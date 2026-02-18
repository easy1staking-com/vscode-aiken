import * as vscode from "vscode";
import * as fs from "fs";
import {
  getProjectRoot,
  parseImports,
  resolveModulePaths,
  findDefinitionLine,
  extractDefinitionWithDocs,
} from "./aikenUtils";

export class AikenHoverProvider implements vscode.HoverProvider {
  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return;

    const word = document.getText(wordRange);
    const text = document.getText();
    const lines = text.split("\n");

    // 1. Check local definitions
    const localMatch = findDefinitionLine(lines, word);
    if (localMatch) {
      const def = extractDefinitionWithDocs(lines, localMatch.lineIndex);
      return buildHover(def.docs, def.code);
    }

    // 2. Check imported definitions
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
          const def = extractDefinitionWithDocs(fileLines, match.lineIndex);
          return buildHover(def.docs, def.code, fullPath);
        }
      }
    }

    return undefined;
  }
}

function buildHover(
  docs: string,
  code: string,
  filePath?: string,
): vscode.Hover {
  const contents: vscode.MarkdownString[] = [];

  if (docs) {
    contents.push(new vscode.MarkdownString(docs));
  }

  contents.push(new vscode.MarkdownString().appendCodeblock(code, "aiken"));

  if (filePath) {
    const pathMd = new vscode.MarkdownString();
    pathMd.appendMarkdown(`*${filePath}*`);
    contents.push(pathMd);
  }

  return new vscode.Hover(contents);
}
