import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

/**
 * Walk up from a document's directory to find the nearest `aiken.toml`,
 * falling back to the VS Code workspace folder root.
 */
export function getProjectRoot(documentUri: vscode.Uri): string | undefined {
  let currentDir = path.dirname(documentUri.fsPath);
  while (currentDir !== path.dirname(currentDir)) {
    if (fs.existsSync(path.join(currentDir, "aiken.toml"))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
  return workspaceFolder?.uri.fsPath;
}

export interface ParsedImport {
  modulePath: string;
  symbols: string[];
}

/**
 * Parse all `use` import statements from source text.
 * Handles single-symbol (`use m.Symbol`), multi-symbol (`use m.{A, B}`),
 * and multi-line brace imports.
 */
export function parseImports(text: string): ParsedImport[] {
  const lines = text.split("\n");
  const imports: ParsedImport[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("use ")) continue;

    let currentImport = line;
    let openBraces = (currentImport.match(/{/g) || []).length;
    let closeBraces = (currentImport.match(/}/g) || []).length;

    while (openBraces > closeBraces && i + 1 < lines.length) {
      i++;
      const nextLine = lines[i].trim();
      currentImport += " " + nextLine;
      openBraces += (nextLine.match(/{/g) || []).length;
      closeBraces += (nextLine.match(/}/g) || []).length;
    }

    const braceStart = currentImport.indexOf("{");
    if (braceStart !== -1) {
      const modulePath = currentImport
        .substring(4, braceStart)
        .replace(/\.$/, "")
        .trim();
      const symbolsPart = currentImport.substring(braceStart);
      if (symbolsPart.startsWith("{") && symbolsPart.endsWith("}")) {
        const content = symbolsPart.slice(1, -1);
        const symbols = content
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        imports.push({ modulePath, symbols });
      }
    } else {
      const afterUse = currentImport.substring(4).trim();
      const lastDot = afterUse.lastIndexOf(".");
      if (lastDot !== -1) {
        const modulePath = afterUse.substring(0, lastDot).trim();
        const symbol = afterUse.substring(lastDot + 1).trim();
        if (symbol.length > 0) {
          imports.push({ modulePath, symbols: [symbol] });
        }
      }
    }
  }
  return imports;
}

/**
 * Build the list of candidate file paths for a given module path,
 * searching lib/, validators/, and build/packages/{pkg}/lib/.
 */
export function resolveModulePaths(
  rootPath: string,
  modulePath: string,
): string[] {
  const possiblePaths = [
    path.join(rootPath, "lib", `${modulePath}.ak`),
    path.join(rootPath, "validators", `${modulePath}.ak`),
  ];

  const buildDir = path.join(rootPath, "build", "packages");
  if (fs.existsSync(buildDir)) {
    try {
      const packages = fs.readdirSync(buildDir);
      for (const pkg of packages) {
        possiblePaths.push(
          path.join(buildDir, pkg, "lib", `${modulePath}.ak`),
        );
      }
    } catch {
      // ignore read errors
    }
  }
  return possiblePaths;
}

export function isTypeLike(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/**
 * Regex-based definition matching.
 * For PascalCase names: matches type definitions and type constructors.
 * For camelCase names: matches fn, validator, test, bench, let, expect.
 */
export function findDefinitionLine(
  lines: string[],
  name: string,
): { lineIndex: number; charIndex: number } | undefined {
  const typelike = isTypeLike(name);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("//")) continue;

    if (typelike) {
      if (/^(let|expect|fn|validator|test)\b/.test(trimmed)) continue;

      const typeRegex = new RegExp(
        `^\\s*(pub\\s+)?(type|opaque\\s+type)\\s+${escapeRegex(name)}\\b`,
      );
      if (typeRegex.test(line)) {
        const matchIndex = line.indexOf(name);
        if (matchIndex >= 0) return { lineIndex: i, charIndex: matchIndex };
      }

      const constructorRegex = new RegExp(
        `^\\s+${escapeRegex(name)}\\b`,
      );
      if (constructorRegex.test(line)) {
        const matchIndex = line.indexOf(name);
        if (matchIndex >= 0) return { lineIndex: i, charIndex: matchIndex };
      }
    } else {
      const fnVarRegex = new RegExp(
        `^\\s*(pub\\s+)?(fn|validator|test|bench|let|expect)\\s+${escapeRegex(name)}\\b`,
      );
      if (fnVarRegex.test(line)) {
        const matchIndex = line.indexOf(name);
        if (matchIndex >= 0) return { lineIndex: i, charIndex: matchIndex };
      }
    }
  }
  return undefined;
}

/**
 * Extract `///` doc comments above a definition and the code block itself.
 */
export function extractDefinitionWithDocs(
  lines: string[],
  definitionIndex: number,
): { docs: string; code: string } {
  const docLines: string[] = [];
  let j = definitionIndex - 1;
  while (j >= 0) {
    const prevLine = lines[j].trim();
    if (prevLine.startsWith("///")) {
      docLines.unshift(prevLine.substring(3).trimStart());
    } else if (prevLine === "") {
      j--;
      continue;
    } else {
      break;
    }
    j--;
  }

  const codeBlock = extractDefinitionBlock(lines, definitionIndex);

  return {
    docs: docLines.join("\n"),
    code: codeBlock,
  };
}

function extractDefinitionBlock(lines: string[], startIndex: number): string {
  const startLine = lines[startIndex];
  if (startLine.trim().endsWith("{")) {
    const extracted: string[] = [];
    let openBraces = 0;

    for (let j = startIndex; j < lines.length; j++) {
      const line = lines[j];
      const trimmed = line.trim();

      if (trimmed.startsWith("///")) continue;

      extracted.push(line);

      openBraces += (line.match(/{/g) || []).length;
      openBraces -= (line.match(/}/g) || []).length;

      if (openBraces <= 0 && j >= startIndex) break;
      if (extracted.length >= 200) break;
    }
    return extracted.join("\n");
  } else {
    return lines
      .slice(startIndex, Math.min(startIndex + 5, lines.length))
      .join("\n");
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
