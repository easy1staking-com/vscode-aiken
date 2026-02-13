import * as vscode from "vscode";
import * as cp from "child_process";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import { AikenDefinitionProvider } from "./definitionProvider";
import { AikenHoverProvider } from "./hoverProvider";
import { AikenDocumentSymbolProvider } from "./documentSymbolProvider";
import { AikenWorkspaceSymbolProvider } from "./workspaceSymbolProvider";
import { AikenCompletionProvider } from "./completionProvider";
import { AikenTaskProvider } from "./taskProvider";
import { AikenReferenceProvider } from "./referenceProvider";
import { AikenImportCodeActionProvider } from "./importCodeActionProvider";

const clients = new Map<string, LanguageClient>();
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let tomlWatcher: vscode.FileSystemWatcher | undefined;

function getConfig() {
  const config = vscode.workspace.getConfiguration("aiken");
  return {
    serverPath: config.get<string>("server.path", ""),
    formattingTimeout: config.get<number>("server.formattingTimeout", 5000),
  };
}

function findAikenBinary(): string | undefined {
  const { serverPath } = getConfig();
  if (serverPath) {
    try {
      cp.execFileSync(serverPath, ["--version"], { stdio: "ignore" });
      return serverPath;
    } catch {
      return undefined;
    }
  }

  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    return cp.execSync(`${cmd} aiken`, { encoding: "utf-8" }).trim();
  } catch {
    return undefined;
  }
}

function updateStatusBar() {
  const count = clients.size;
  if (count === 0) {
    statusBarItem.text = "$(error) Aiken";
    statusBarItem.tooltip = "Aiken LSP: No projects";
  } else if (count === 1) {
    statusBarItem.text = "$(check) Aiken";
    statusBarItem.tooltip = "Aiken LSP: Ready (1 project)";
  } else {
    statusBarItem.text = `$(check) Aiken (${count})`;
    statusBarItem.tooltip = `Aiken LSP: Ready (${count} projects)`;
  }
  statusBarItem.show();
}

function setStatus(text: string, icon: string, tooltip: string) {
  statusBarItem.text = `${icon} ${text}`;
  statusBarItem.tooltip = tooltip;
  statusBarItem.show();
}

async function startClientForRoot(
  projectRoot: string,
  binary: string,
): Promise<void> {
  if (clients.has(projectRoot)) return;

  const { formattingTimeout } = getConfig();

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      {
        scheme: "file",
        language: "aiken",
        pattern: `${projectRoot}/**/*.ak`,
      },
    ],
    synchronize: {
      fileEvents: [
        vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(projectRoot, "aiken.toml"),
        ),
      ],
    },
    outputChannel,
    middleware: {
      provideDocumentFormattingEdits: async (
        document,
        options,
        token,
        next,
      ) => {
        if (formattingTimeout <= 0) {
          return next(document, options, token);
        }

        let timer: ReturnType<typeof setTimeout>;
        const formatPromise = Promise.resolve(
          next(document, options, token),
        ).then((edits) => {
          clearTimeout(timer);
          return edits;
        });
        const timeoutPromise = new Promise<
          vscode.TextEdit[] | null | undefined
        >((resolve) => {
          timer = setTimeout(() => {
            outputChannel.appendLine(
              `[warn] Formatting timed out after ${formattingTimeout}ms for ${document.fileName}`,
            );
            resolve([]);
          }, formattingTimeout);
        });

        return Promise.race([formatPromise, timeoutPromise]);
      },
    },
  };

  const serverOptions: ServerOptions = {
    command: binary,
    args: ["lsp"],
    transport: TransportKind.stdio,
    options: {
      env: { ...process.env },
      cwd: projectRoot,
    },
  };

  const client = new LanguageClient(
    `aiken_language_server_${projectRoot}`,
    `Aiken Language Server (${projectRoot})`,
    serverOptions,
    clientOptions,
  );

  try {
    await client.start();
    clients.set(projectRoot, client);
    outputChannel.appendLine(
      `[info] Language server started for: ${projectRoot}`,
    );
    updateStatusBar();
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    let message: string;
    if (error.code === "ENOENT") {
      message = `Binary not found: ${binary}`;
    } else if (error.code === "EACCES") {
      message = `Permission denied: ${binary}`;
    } else {
      message = error.message ?? String(err);
    }
    outputChannel.appendLine(
      `[error] Failed to start language server for ${projectRoot}: ${message}`,
    );
  }
}

async function stopClientForRoot(projectRoot: string): Promise<void> {
  const client = clients.get(projectRoot);
  if (!client) return;
  clients.delete(projectRoot);
  try {
    const stopPromise = client.stop();
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000));
    await Promise.race([stopPromise, timeout]);
  } catch {
    // Client already stopped or crashed
  }
  outputChannel.appendLine(
    `[info] Language server stopped for: ${projectRoot}`,
  );
  updateStatusBar();
}

async function stopAllClients(): Promise<void> {
  const stopPromises = Array.from(clients.keys()).map((root) =>
    stopClientForRoot(root),
  );
  await Promise.all(stopPromises);
}

async function discoverAndStartClients(): Promise<void> {
  const binary = findAikenBinary();
  if (!binary) {
    const configuredPath = getConfig().serverPath;
    const detail = configuredPath
      ? `Configured path not found: ${configuredPath}`
      : "'aiken' not found in PATH";
    setStatus("Aiken", "$(error)", `Aiken LSP: ${detail}`);
    outputChannel.appendLine(`[error] ${detail}`);

    const choice = await vscode.window.showErrorMessage(
      `Aiken Language Server: ${detail}`,
      "Open Settings",
      "Retry",
    );
    if (choice === "Open Settings") {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "aiken.server.path",
      );
    } else if (choice === "Retry") {
      await discoverAndStartClients();
    }
    return;
  }

  outputChannel.appendLine(`[info] Using aiken binary: ${binary}`);
  setStatus("Aiken", "$(sync~spin)", "Aiken LSP: Starting...");

  const tomlFiles = await vscode.workspace.findFiles(
    "**/aiken.toml",
    "**/build/**",
  );

  if (tomlFiles.length === 0) {
    // Fallback: start a single client for the first workspace folder
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      await startClientForRoot(folder.uri.fsPath, binary);
    }
  } else {
    const startPromises = tomlFiles.map((toml) => {
      const root = vscode.Uri.joinPath(toml, "..").fsPath;
      return startClientForRoot(root, binary);
    });
    await Promise.all(startPromises);
  }

  updateStatusBar();
}

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Aiken Language Server");

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  );
  statusBarItem.command = "aiken.restartServer";
  context.subscriptions.push(statusBarItem);

  const aikenSelector: vscode.DocumentFilter = {
    scheme: "file",
    language: "aiken",
  };

  // Register all providers
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      aikenSelector,
      new AikenDefinitionProvider(),
    ),
    vscode.languages.registerHoverProvider(
      aikenSelector,
      new AikenHoverProvider(),
    ),
    vscode.languages.registerDocumentSymbolProvider(
      aikenSelector,
      new AikenDocumentSymbolProvider(),
    ),
    vscode.languages.registerCompletionItemProvider(
      aikenSelector,
      new AikenCompletionProvider(),
      ".",
    ),
    vscode.languages.registerReferenceProvider(
      aikenSelector,
      new AikenReferenceProvider(),
    ),
    vscode.languages.registerCodeActionsProvider(
      aikenSelector,
      new AikenImportCodeActionProvider(),
      {
        providedCodeActionKinds:
          AikenImportCodeActionProvider.providedCodeActionKinds,
      },
    ),
  );

  // Workspace symbol provider (no document selector)
  context.subscriptions.push(
    vscode.languages.registerWorkspaceSymbolProvider(
      new AikenWorkspaceSymbolProvider(),
    ),
  );

  // Task provider
  context.subscriptions.push(
    vscode.tasks.registerTaskProvider(
      AikenTaskProvider.type,
      new AikenTaskProvider(),
    ),
  );

  // Restart command restarts all clients
  const restartCommand = vscode.commands.registerCommand(
    "aiken.restartServer",
    async () => {
      outputChannel.appendLine("[info] Restarting all language servers...");
      setStatus("Aiken", "$(sync~spin)", "Aiken LSP: Restarting...");
      await stopAllClients();
      await discoverAndStartClients();
    },
  );
  context.subscriptions.push(restartCommand);

  // Watch for aiken.toml creation/deletion to dynamically start/stop clients
  tomlWatcher = vscode.workspace.createFileSystemWatcher(
    "**/aiken.toml",
    false,
    true,
    false,
  );

  tomlWatcher.onDidCreate(async (uri) => {
    const root = vscode.Uri.joinPath(uri, "..").fsPath;
    outputChannel.appendLine(
      `[info] Detected new aiken.toml at: ${root}`,
    );
    const binary = findAikenBinary();
    if (binary) {
      await startClientForRoot(root, binary);
    }
  });

  tomlWatcher.onDidDelete(async (uri) => {
    const root = vscode.Uri.joinPath(uri, "..").fsPath;
    outputChannel.appendLine(
      `[info] Detected removal of aiken.toml at: ${root}`,
    );
    await stopClientForRoot(root);
  });

  context.subscriptions.push(tomlWatcher);

  // Handle workspace folder changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      outputChannel.appendLine(
        "[info] Workspace folders changed, re-discovering projects...",
      );
      await stopAllClients();
      await discoverAndStartClients();
    }),
  );

  await discoverAndStartClients();
}

export async function deactivate() {
  tomlWatcher?.dispose();
  await stopAllClients();
}
