import * as vscode from "vscode";
import * as fs from "fs";
import {
  getProjectRoot,
  parseImports,
  resolveModulePaths,
  findDefinitionLine,
} from "./aikenUtils";

export class AikenDefinitionProvider implements vscode.DefinitionProvider {
  public async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<vscode.Definition | undefined> {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return;

    const word = document.getText(wordRange);
    const text = document.getText();
    const lines = text.split("\n");

    // 1. Search in the current document first
    const localDef = findDefinitionLine(lines, word);
    if (localDef) {
      return new vscode.Location(
        document.uri,
        new vscode.Range(
          localDef.lineIndex,
          localDef.charIndex,
          localDef.lineIndex,
          localDef.charIndex + word.length,
        ),
      );
    }

    // 2. Search in imported modules
    const projectRoot = getProjectRoot(document.uri);
    if (!projectRoot) return;

    const imports = parseImports(text);
    for (const imp of imports) {
      if (!imp.symbols.includes(word)) continue;

      const candidatePaths = resolveModulePaths(projectRoot, imp.modulePath);
      for (const fullPath of candidatePaths) {
        if (!fs.existsSync(fullPath)) continue;

        const fileContent = fs.readFileSync(fullPath, "utf8");
        const fileLines = fileContent.split("\n");
        const match = findDefinitionLine(fileLines, word);
        if (match) {
          return new vscode.Location(
            vscode.Uri.file(fullPath),
            new vscode.Range(
              match.lineIndex,
              match.charIndex,
              match.lineIndex,
              match.charIndex + word.length,
            ),
          );
        }
      }
    }

    return undefined;
  }
}
