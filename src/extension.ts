import * as vscode from "vscode";
import * as cp from "child_process";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

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

function setStatus(text: string, icon: string, tooltip: string) {
  statusBarItem.text = `${icon} ${text}`;
  statusBarItem.tooltip = tooltip;
  statusBarItem.show();
}

async function startClient(context: vscode.ExtensionContext) {
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
      startClient(context);
    }
    return;
  }

  outputChannel.appendLine(`[info] Using aiken binary: ${binary}`);
  setStatus("Aiken", "$(sync~spin)", "Aiken LSP: Starting...");

  const { formattingTimeout } = getConfig();

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "aiken" }],
    synchronize: {
      fileEvents: [
        vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(
            vscode.workspace.workspaceFolders
              ? vscode.workspace.workspaceFolders[0]
              : ".",
            "aiken.toml",
          ),
        ),
      ],
    },
    outputChannel,
    middleware: {
      provideDocumentFormattingEdits: async (document, options, token, next) => {
        if (formattingTimeout <= 0) {
          return next(document, options, token);
        }

        const formatPromise = next(document, options, token);
        const timeoutPromise = new Promise<vscode.TextEdit[]>((resolve) => {
          setTimeout(() => {
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
    },
  };

  client = new LanguageClient(
    "aiken_language_server",
    "Aiken Language Server",
    serverOptions,
    clientOptions,
  );

  try {
    await client.start();
    setStatus("Aiken", "$(check)", "Aiken LSP: Ready");
    outputChannel.appendLine("[info] Language server started successfully");
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

    setStatus("Aiken", "$(error)", `Aiken LSP: ${message}`);
    outputChannel.appendLine(`[error] Failed to start language server: ${message}`);
    vscode.window.showErrorMessage(`Aiken Language Server failed to start: ${message}`);
    client = undefined;
  }
}

async function stopClient(): Promise<void> {
  if (!client) {
    return;
  }
  try {
    const stopPromise = client.stop();
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000));
    await Promise.race([stopPromise, timeout]);
  } catch {
    // Client already stopped or crashed
  }
  client = undefined;
}

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Aiken Language Server");

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  );
  statusBarItem.command = "aiken.restartServer";
  context.subscriptions.push(statusBarItem);

  const restartCommand = vscode.commands.registerCommand(
    "aiken.restartServer",
    async () => {
      outputChannel.appendLine("[info] Restarting language server...");
      setStatus("Aiken", "$(sync~spin)", "Aiken LSP: Restarting...");
      await stopClient();
      await startClient(context);
    },
  );
  context.subscriptions.push(restartCommand);

  await startClient(context);
}

export async function deactivate() {
  await stopClient();
}
