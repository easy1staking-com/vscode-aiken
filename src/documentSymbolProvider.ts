import * as vscode from "vscode";
import {
  findAllDefinitions,
  definitionKindToSymbolKind,
  DefinitionInfo,
} from "./aikenUtils";

export class AikenDocumentSymbolProvider
  implements vscode.DocumentSymbolProvider
{
  public provideDocumentSymbols(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.DocumentSymbol[] {
    const lines = document.getText().split("\n");
    const defs = findAllDefinitions(lines);
    return buildSymbolHierarchy(defs);
  }
}

function buildSymbolHierarchy(
  defs: DefinitionInfo[],
): vscode.DocumentSymbol[] {
  const topLevel: vscode.DocumentSymbol[] = [];
  const parentMap = new Map<number, vscode.DocumentSymbol>();

  for (const def of defs) {
    const nameRange = new vscode.Range(
      def.lineIndex,
      def.charIndex,
      def.lineIndex,
      def.charIndex + def.name.length,
    );
    const fullRange = nameRange; // simplified; name range = full range

    const symbol = new vscode.DocumentSymbol(
      def.name,
      def.kind,
      definitionKindToSymbolKind(def.kind),
      fullRange,
      nameRange,
    );

    if (
      def.parentLineIndex !== undefined &&
      parentMap.has(def.parentLineIndex)
    ) {
      parentMap.get(def.parentLineIndex)!.children.push(symbol);
    } else {
      topLevel.push(symbol);
    }

    if (def.kind === "type") {
      parentMap.set(def.lineIndex, symbol);
    }
  }

  return topLevel;
}
