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

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Shared types and utilities for symbol providers ---

export interface DefinitionInfo {
  name: string;
  kind: string; // "type" | "fn" | "validator" | "test" | "bench" | "const" | "let" | "expect" | "constructor"
  visibility: "pub" | "priv";
  lineIndex: number;
  charIndex: number;
  parentLineIndex?: number;
}

/**
 * Scan all lines for every definition. Tracks brace depth to nest
 * type constructors under parent types.
 */
export function findAllDefinitions(lines: string[]): DefinitionInfo[] {
  const defs: DefinitionInfo[] = [];
  let braceDepth = 0;
  let currentTypeLineIndex: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("//")) {
      continue;
    }

    // Check for top-level definitions
    const defMatch = trimmed.match(
      /^(pub\s+)?(opaque\s+)?(type|fn|validator|test|bench|const)\s+(\w+)/,
    );
    if (defMatch && braceDepth === 0) {
      const isPub = !!defMatch[1];
      let kind = defMatch[3];
      if (defMatch[2] && kind === "type") {
        kind = "type"; // opaque type is still "type"
      }
      const name = defMatch[4];
      const charIndex = line.indexOf(name);
      defs.push({
        name,
        kind,
        visibility: isPub ? "pub" : "priv",
        lineIndex: i,
        charIndex: charIndex >= 0 ? charIndex : 0,
      });
      if (kind === "type") {
        currentTypeLineIndex = i;
      }
    }

    // Check for let/expect bindings at top-level
    if (braceDepth === 0) {
      const bindingMatch = trimmed.match(/^(pub\s+)?(let|expect)\s+(\w+)/);
      if (bindingMatch) {
        const isPub = !!bindingMatch[1];
        const kind = bindingMatch[2];
        const name = bindingMatch[3];
        const charIndex = line.indexOf(name);
        defs.push({
          name,
          kind,
          visibility: isPub ? "pub" : "priv",
          lineIndex: i,
          charIndex: charIndex >= 0 ? charIndex : 0,
        });
      }
    }

    // Track braces
    for (const ch of line) {
      if (ch === "{") braceDepth++;
      if (ch === "}") braceDepth--;
    }
    if (braceDepth < 0) braceDepth = 0;

    // Check for type constructors inside a type body
    if (currentTypeLineIndex !== undefined && braceDepth > 0) {
      const ctorMatch = trimmed.match(/^([A-Z]\w*)\b/);
      if (ctorMatch && !trimmed.startsWith("//")) {
        const name = ctorMatch[1];
        const charIndex = line.indexOf(name);
        defs.push({
          name,
          kind: "constructor",
          visibility: "priv",
          lineIndex: i,
          charIndex: charIndex >= 0 ? charIndex : 0,
          parentLineIndex: currentTypeLineIndex,
        });
      }
    }

    // Reset current type when we leave the type block
    if (braceDepth === 0 && currentTypeLineIndex !== undefined) {
      currentTypeLineIndex = undefined;
    }
  }

  return defs;
}

/**
 * Map a definition kind to a vscode.SymbolKind.
 */
export function definitionKindToSymbolKind(kind: string): vscode.SymbolKind {
  switch (kind) {
    case "type":
      return vscode.SymbolKind.Enum;
    case "constructor":
      return vscode.SymbolKind.EnumMember;
    case "fn":
      return vscode.SymbolKind.Function;
    case "validator":
      return vscode.SymbolKind.Interface;
    case "test":
    case "bench":
      return vscode.SymbolKind.Method;
    case "const":
      return vscode.SymbolKind.Constant;
    case "let":
    case "expect":
      return vscode.SymbolKind.Variable;
    default:
      return vscode.SymbolKind.Variable;
  }
}

/**
 * Convert an absolute file path to an Aiken module path.
 * e.g. `lib/aiken/crypto.ak` → `aiken/crypto`
 */
export function filePathToModulePath(
  filePath: string,
  searchRoot: string,
): string | undefined {
  const relative = path.relative(searchRoot, filePath).replace(/\\/g, "/");
  const prefixes = ["lib/", "validators/"];
  for (const prefix of prefixes) {
    if (relative.startsWith(prefix)) {
      return relative.slice(prefix.length).replace(/\.ak$/, "");
    }
  }
  // build/packages/*/lib/...
  const buildMatch = relative.match(/^build\/packages\/[^/]+\/lib\/(.+)\.ak$/);
  if (buildMatch) {
    return buildMatch[1];
  }
  return relative.replace(/\.ak$/, "");
}

export interface ExportedSymbol {
  name: string;
  kind: string;
  modulePath: string;
  filePath: string;
}

/**
 * Recursively walk a directory for `.ak` files, calling `callback` for each.
 */
export function walkAkFiles(
  dir: string,
  callback: (filePath: string) => void,
): void {
  if (!fs.existsSync(dir)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAkFiles(fullPath, callback);
    } else if (entry.isFile() && entry.name.endsWith(".ak")) {
      callback(fullPath);
    }
  }
}

/**
 * Scan lib/, validators/, and build packages for all pub definitions.
 */
export function findExportedSymbols(projectRoot: string): ExportedSymbol[] {
  const symbols: ExportedSymbol[] = [];
  const searchDirs = [
    path.join(projectRoot, "lib"),
    path.join(projectRoot, "validators"),
  ];

  // Also scan build/packages/*/lib/
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
      try {
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split("\n");
        const defs = findAllDefinitions(lines);
        const modPath = filePathToModulePath(filePath, projectRoot);
        for (const def of defs) {
          if (def.visibility === "pub" && def.kind !== "constructor") {
            symbols.push({
              name: def.name,
              kind: def.kind,
              modulePath: modPath || "",
              filePath,
            });
          }
        }
      } catch {
        // skip unreadable files
      }
    });
  }

  return symbols;
}
