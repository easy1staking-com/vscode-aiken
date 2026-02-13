import * as vscode from "vscode";
import * as fs from "fs";
import { findAllDefinitions, definitionKindToSymbolKind } from "./aikenUtils";

export class AikenWorkspaceSymbolProvider
  implements vscode.WorkspaceSymbolProvider
{
  public async provideWorkspaceSymbols(
    query: string,
    _token: vscode.CancellationToken,
  ): Promise<vscode.SymbolInformation[]> {
    const lowerQuery = query.toLowerCase();
    const files = await vscode.workspace.findFiles("**/*.ak");
    const results: vscode.SymbolInformation[] = [];

    for (const file of files) {
      let content: string;
      try {
        content = fs.readFileSync(file.fsPath, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      const defs = findAllDefinitions(lines);

      for (const def of defs) {
        if (def.kind === "constructor") continue;
        if (lowerQuery && !def.name.toLowerCase().includes(lowerQuery))
          continue;

        results.push(
          new vscode.SymbolInformation(
            def.name,
            definitionKindToSymbolKind(def.kind),
            "",
            new vscode.Location(
              file,
              new vscode.Position(def.lineIndex, def.charIndex),
            ),
          ),
        );
      }
    }

    return results;
  }
}
