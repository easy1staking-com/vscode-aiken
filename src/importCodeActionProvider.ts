import * as vscode from "vscode";
import {
  findAllDefinitions,
  findExportedSymbols,
  getProjectRoot,
  parseImports,
  ExportedSymbol,
} from "./aikenUtils";

const CACHE_TTL_MS = 10_000;

let cachedSymbols: ExportedSymbol[] = [];
let cachedRoot: string | undefined;
let cacheTime = 0;

function getCachedExportedSymbols(projectRoot: string): ExportedSymbol[] {
  const now = Date.now();
  if (
    cachedRoot === projectRoot &&
    cachedSymbols.length > 0 &&
    now - cacheTime < CACHE_TTL_MS
  ) {
    return cachedSymbols;
  }
  cachedSymbols = findExportedSymbols(projectRoot);
  cachedRoot = projectRoot;
  cacheTime = now;
  return cachedSymbols;
}

export class AikenImportCodeActionProvider
  implements vscode.CodeActionProvider
{
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
  ];

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    _context: vscode.CodeActionContext,
    _token: vscode.CancellationToken,
  ): vscode.CodeAction[] {
    const wordRange = document.getWordRangeAtPosition(range.start);
    if (!wordRange) return [];

    const word = document.getText(wordRange);
    if (!word || word.length < 2) return [];

    const text = document.getText();
    const lines = text.split("\n");

    // Check if already defined locally
    const localDefs = findAllDefinitions(lines);
    if (localDefs.some((d) => d.name === word)) return [];

    // Check if already imported
    const imports = parseImports(text);
    for (const imp of imports) {
      if (imp.symbols.includes(word)) return [];
    }

    // Find matching exported symbols from project
    const projectRoot = getProjectRoot(document.uri);
    if (!projectRoot) return [];

    const exported = getCachedExportedSymbols(projectRoot);
    const matches = exported.filter((s) => s.name === word);
    if (matches.length === 0) return [];

    const actions: vscode.CodeAction[] = [];

    for (const match of matches) {
      const title = `Add import: use ${match.modulePath}.{${match.name}}`;
      const action = new vscode.CodeAction(
        title,
        vscode.CodeActionKind.QuickFix,
      );
      action.edit = new vscode.WorkspaceEdit();

      // Check if we already import from this module
      const existingImport = imports.find(
        (imp) => imp.modulePath === match.modulePath,
      );

      if (existingImport) {
        // Add to existing import's brace list
        const importLine = this.findImportLine(lines, match.modulePath);
        if (importLine !== undefined) {
          const line = lines[importLine];
          const closeBrace = line.lastIndexOf("}");
          if (closeBrace >= 0) {
            action.edit.insert(
              document.uri,
              new vscode.Position(importLine, closeBrace),
              `, ${match.name}`,
            );
          }
        }
      } else {
        // Insert new use statement after last existing use statement
        const insertLine = this.findInsertLine(lines);
        const importText = `use ${match.modulePath}.{${match.name}}\n`;
        action.edit.insert(
          document.uri,
          new vscode.Position(insertLine, 0),
          importText,
        );
      }

      actions.push(action);
    }

    return actions;
  }

  private findImportLine(lines: string[], modulePath: string): number | undefined {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith("use ") && lines[i].includes(modulePath)) {
        return i;
      }
    }
    return undefined;
  }

  private findInsertLine(lines: string[]): number {
    let lastUseLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith("use ")) {
        lastUseLine = i;
        // Skip multi-line imports
        let openBraces = (lines[i].match(/{/g) || []).length;
        let closeBraces = (lines[i].match(/}/g) || []).length;
        while (openBraces > closeBraces && i + 1 < lines.length) {
          i++;
          lastUseLine = i;
          openBraces += (lines[i].match(/{/g) || []).length;
          closeBraces += (lines[i].match(/}/g) || []).length;
        }
      }
    }
    return lastUseLine + 1;
  }
}
