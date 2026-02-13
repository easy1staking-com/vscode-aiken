import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  findAllDefinitions,
  definitionKindToSymbolKind,
  getProjectRoot,
  parseImports,
  resolveModulePaths,
  walkAkFiles,
  filePathToModulePath,
} from "./aikenUtils";

const AIKEN_KEYWORDS = [
  "and",
  "as",
  "assert",
  "bench",
  "const",
  "else",
  "expect",
  "fail",
  "fn",
  "if",
  "is",
  "let",
  "not",
  "once",
  "opaque",
  "or",
  "pub",
  "test",
  "todo",
  "trace",
  "type",
  "use",
  "validator",
  "when",
];

export class AikenCompletionProvider
  implements vscode.CompletionItemProvider
{
  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext,
  ): vscode.CompletionItem[] {
    const lineText = document.lineAt(position).text;
    const linePrefix = lineText.substring(0, position.character);

    // Module path completions after "use "
    if (/^\s*use\s+/.test(linePrefix)) {
      return this.getModulePathCompletions(document);
    }

    const items: vscode.CompletionItem[] = [];

    // Keywords
    for (const kw of AIKEN_KEYWORDS) {
      const item = new vscode.CompletionItem(
        kw,
        vscode.CompletionItemKind.Keyword,
      );
      item.sortText = `2_${kw}`;
      items.push(item);
    }

    // Local symbols from current file
    const text = document.getText();
    const lines = text.split("\n");
    const localDefs = findAllDefinitions(lines);
    for (const def of localDefs) {
      const item = new vscode.CompletionItem(
        def.name,
        symbolKindToCompletionKind(definitionKindToSymbolKind(def.kind)),
      );
      item.detail = `(${def.kind})`;
      item.sortText = `0_${def.name}`;
      items.push(item);
    }

    // Imported symbols
    const projectRoot = getProjectRoot(document.uri);
    if (projectRoot) {
      const imports = parseImports(text);
      for (const imp of imports) {
        const candidatePaths = resolveModulePaths(projectRoot, imp.modulePath);
        for (const fullPath of candidatePaths) {
          if (!fs.existsSync(fullPath)) continue;
          try {
            const fileContent = fs.readFileSync(fullPath, "utf8");
            const fileLines = fileContent.split("\n");
            const defs = findAllDefinitions(fileLines);
            for (const def of defs) {
              if (def.visibility !== "pub") continue;
              // Only include explicitly imported symbols, or all pub symbols if wildcard
              if (imp.symbols.length > 0 && !imp.symbols.includes(def.name))
                continue;

              const item = new vscode.CompletionItem(
                def.name,
                symbolKindToCompletionKind(
                  definitionKindToSymbolKind(def.kind),
                ),
              );
              item.detail = `${imp.modulePath} (${def.kind})`;
              item.sortText = `1_${def.name}`;
              items.push(item);
            }
          } catch {
            // skip unreadable files
          }
          break; // stop after first found file
        }
      }
    }

    return items;
  }

  private getModulePathCompletions(
    document: vscode.TextDocument,
  ): vscode.CompletionItem[] {
    const projectRoot = getProjectRoot(document.uri);
    if (!projectRoot) return [];

    const items: vscode.CompletionItem[] = [];
    const seen = new Set<string>();

    const searchDirs = [
      path.join(projectRoot, "lib"),
      path.join(projectRoot, "validators"),
    ];

    const buildDir = path.join(projectRoot, "build", "packages");
    if (fs.existsSync(buildDir)) {
      try {
        const packages = fs.readdirSync(buildDir);
        for (const pkg of packages) {
          searchDirs.push(path.join(buildDir, pkg, "lib"));
        }
      } catch {
        // ignore
      }
    }

    for (const dir of searchDirs) {
      walkAkFiles(dir, (filePath) => {
        const modPath = filePathToModulePath(filePath, projectRoot);
        if (modPath && !seen.has(modPath)) {
          seen.add(modPath);
          const item = new vscode.CompletionItem(
            modPath,
            vscode.CompletionItemKind.Module,
          );
          items.push(item);
        }
      });
    }

    return items;
  }
}

function symbolKindToCompletionKind(
  kind: vscode.SymbolKind,
): vscode.CompletionItemKind {
  switch (kind) {
    case vscode.SymbolKind.Function:
      return vscode.CompletionItemKind.Function;
    case vscode.SymbolKind.Enum:
      return vscode.CompletionItemKind.Enum;
    case vscode.SymbolKind.EnumMember:
      return vscode.CompletionItemKind.EnumMember;
    case vscode.SymbolKind.Interface:
      return vscode.CompletionItemKind.Interface;
    case vscode.SymbolKind.Method:
      return vscode.CompletionItemKind.Method;
    case vscode.SymbolKind.Constant:
      return vscode.CompletionItemKind.Constant;
    case vscode.SymbolKind.Variable:
      return vscode.CompletionItemKind.Variable;
    default:
      return vscode.CompletionItemKind.Text;
  }
}
