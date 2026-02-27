import * as vscode from "vscode";
import * as fs from "fs";
import { escapeRegex, getProjectRoot } from "./aikenUtils";

export class AikenReferenceProvider implements vscode.ReferenceProvider {
  public async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
    _token: vscode.CancellationToken,
  ): Promise<vscode.Location[]> {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return [];

    const word = document.getText(wordRange);
    const pattern = new RegExp(`\\b${escapeRegex(word)}\\b`, "g");
    const results: vscode.Location[] = [];

    // Search current file
    this.searchFile(document.uri, document.getText(), pattern, results);

    // Search all .ak files in the project
    const projectRoot = getProjectRoot(document.uri);
    if (projectRoot) {
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(projectRoot, "**/*.ak"),
      );
      for (const file of files) {
        if (file.fsPath === document.uri.fsPath) continue;
        try {
          const content = fs.readFileSync(file.fsPath, "utf8");
          this.searchFile(file, content, pattern, results);
        } catch {
          // skip unreadable files
        }
      }
    }

    return results;
  }

  private searchFile(
    uri: vscode.Uri,
    content: string,
    pattern: RegExp,
    results: vscode.Location[],
  ): void {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trimStart().startsWith("//")) continue;

      let match: RegExpExecArray | null;
      // Reset lastIndex for each line since we reuse the regex
      pattern.lastIndex = 0;
      while ((match = pattern.exec(line)) !== null) {
        results.push(
          new vscode.Location(
            uri,
            new vscode.Range(i, match.index, i, match.index + match[0].length),
          ),
        );
      }
    }
  }
}
