/**
 * Import resolver - resolves import specifiers to actual file paths.
 * Handles tsconfig path aliases, barrel imports (index.ts), and external packages.
 */

import { resolve, join, dirname, relative } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { Import, ReExport, FileNode, Edge } from "./types";

/** TypeScript extensions to try when resolving bare specifiers */
const TS_EXTENSIONS = [".ts", ".tsx", ".d.ts"];

/** Index file names to try for directory imports */
const INDEX_FILES = ["index.ts", "index.tsx"];

/** Parsed tsconfig paths configuration */
export interface TsConfigPaths {
  baseUrl: string;
  paths: Record<string, string[]>;
}

/**
 * Load and parse tsconfig.json paths configuration.
 * Returns null if no tsconfig.json or no paths configured.
 */
export async function loadTsConfigPaths(rootPath: string): Promise<TsConfigPaths | null> {
  const tsconfigPath = join(rootPath, "tsconfig.json");

  if (!existsSync(tsconfigPath)) {
    return null;
  }

  try {
    const file = Bun.file(tsconfigPath);
    const text = await file.text();
    // Strip JSON comments (// and /* */ style) for parsing
    const stripped = text
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const tsconfig = JSON.parse(stripped);
    const compilerOptions = tsconfig.compilerOptions || {};

    const baseUrl = compilerOptions.baseUrl
      ? resolve(rootPath, compilerOptions.baseUrl)
      : rootPath;

    const paths = compilerOptions.paths || {};

    if (Object.keys(paths).length === 0 && !compilerOptions.baseUrl) {
      return null;
    }

    return { baseUrl, paths };
  } catch {
    return null;
  }
}

/**
 * Try to resolve a file path by appending TypeScript extensions.
 * Returns the resolved path if found, null otherwise.
 */
function tryResolveWithExtensions(basePath: string): string | null {
  // Try exact path first (only if it's a file, not a directory)
  if (existsSync(basePath)) {
    try {
      if (statSync(basePath).isFile()) {
        return basePath;
      }
    } catch {
      // fall through
    }
  }

  // Try with TS extensions
  for (const ext of TS_EXTENSIONS) {
    const withExt = basePath + ext;
    if (existsSync(withExt)) {
      return withExt;
    }
  }

  // Try as directory with index files
  for (const indexFile of INDEX_FILES) {
    const indexPath = join(basePath, indexFile);
    if (existsSync(indexPath)) {
      return indexPath;
    }
  }

  return null;
}

/**
 * Resolve a path alias using tsconfig paths.
 * Returns the resolved absolute path or null.
 */
function resolvePathAlias(
  specifier: string,
  tsConfigPaths: TsConfigPaths,
): string | null {
  for (const [pattern, mappings] of Object.entries(tsConfigPaths.paths)) {
    // Handle wildcard patterns like "@yuzu/platform/*"
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      if (specifier.startsWith(prefix + "/")) {
        const rest = specifier.slice(prefix.length + 1);
        for (const mapping of mappings) {
          const mappingBase = mapping.endsWith("/*")
            ? mapping.slice(0, -2)
            : mapping;
          const resolvedBase = resolve(tsConfigPaths.baseUrl, mappingBase);
          const candidate = join(resolvedBase, rest);
          const resolved = tryResolveWithExtensions(candidate);
          if (resolved) return resolved;
        }
      }
    }
    // Handle exact patterns like "@utils"
    else if (specifier === pattern) {
      for (const mapping of mappings) {
        const candidate = resolve(tsConfigPaths.baseUrl, mapping);
        const resolved = tryResolveWithExtensions(candidate);
        if (resolved) return resolved;
      }
    }
  }

  return null;
}

/**
 * Resolve a relative import specifier to an absolute file path.
 */
function resolveRelativeImport(
  specifier: string,
  fromFile: string,
): string | null {
  const fromDir = dirname(fromFile);
  const candidate = resolve(fromDir, specifier);
  return tryResolveWithExtensions(candidate);
}

/**
 * Resolve a baseUrl import (non-relative, non-external).
 */
function resolveBaseUrlImport(
  specifier: string,
  tsConfigPaths: TsConfigPaths,
): string | null {
  const candidate = resolve(tsConfigPaths.baseUrl, specifier);
  return tryResolveWithExtensions(candidate);
}

/**
 * Check if an import specifier refers to an external (npm) package.
 */
export function isExternalImport(specifier: string): boolean {
  // Relative imports
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return false;
  }
  // Node built-in modules
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) {
    return true;
  }
  // Scoped or regular packages are external unless resolved by tsconfig
  return true;
}

/**
 * Resolve a single import specifier to a file path relative to root.
 *
 * @param specifier - The import specifier (e.g. "./utils", "@yuzu/platform/tupy")
 * @param fromFile - Absolute path of the file containing the import
 * @param rootPath - Absolute project root path
 * @param tsConfigPaths - Parsed tsconfig paths, or null
 * @returns Relative file path or null if external/unresolvable
 */
export function resolveImport(
  specifier: string,
  fromFile: string,
  rootPath: string,
  tsConfigPaths: TsConfigPaths | null,
): string | null {
  // Relative imports
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const resolved = resolveRelativeImport(specifier, fromFile);
    if (resolved) return relative(rootPath, resolved);
    return null;
  }

  // Node/Bun built-ins are external
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) {
    return null;
  }

  // Try tsconfig path aliases
  if (tsConfigPaths) {
    const aliasResolved = resolvePathAlias(specifier, tsConfigPaths);
    if (aliasResolved) return relative(rootPath, aliasResolved);

    // Try baseUrl resolution
    const baseUrlResolved = resolveBaseUrlImport(specifier, tsConfigPaths);
    if (baseUrlResolved) return relative(rootPath, baseUrlResolved);
  }

  // External package
  return null;
}

/**
 * Resolve all imports in a FileNode, mutating the resolvedPath fields.
 *
 * @param fileNode - The parsed file node
 * @param rootPath - Absolute project root path
 * @param tsConfigPaths - Parsed tsconfig paths, or null
 */
export function resolveFileImports(
  fileNode: FileNode,
  rootPath: string,
  tsConfigPaths: TsConfigPaths | null,
): void {
  const absFilePath = resolve(rootPath, fileNode.path);

  // Resolve regular imports
  for (const imp of fileNode.imports) {
    imp.resolvedPath = resolveImport(
      imp.source,
      absFilePath,
      rootPath,
      tsConfigPaths,
    );
    imp.isExternal = imp.resolvedPath === null && isExternalImport(imp.source);
  }

  // Resolve re-export sources
  for (const reExport of fileNode.reExports) {
    reExport.resolvedPath = resolveImport(
      reExport.source,
      absFilePath,
      rootPath,
      tsConfigPaths,
    );
  }
}

/**
 * Build dependency edges from resolved file nodes.
 * Only includes edges where the target is a known internal file.
 *
 * @param fileNodes - All parsed file nodes with resolved imports
 * @returns Array of directed edges
 */
export function buildEdges(fileNodes: FileNode[]): Edge[] {
  const knownFiles = new Set(fileNodes.map((f) => f.path));
  const edges: Edge[] = [];

  for (const file of fileNodes) {
    // Edges from regular imports
    for (const imp of file.imports) {
      if (imp.resolvedPath && knownFiles.has(imp.resolvedPath)) {
        edges.push({
          from: file.path,
          to: imp.resolvedPath,
          importedNames: [
            ...(imp.defaultImport ? [imp.defaultImport] : []),
            ...imp.namedImports,
            ...(imp.namespaceImport ? [imp.namespaceImport] : []),
          ],
        });
      }
    }

    // Edges from re-exports
    for (const reExport of file.reExports) {
      if (reExport.resolvedPath && knownFiles.has(reExport.resolvedPath)) {
        edges.push({
          from: file.path,
          to: reExport.resolvedPath,
          importedNames: reExport.names.length > 0 ? reExport.names : ["*"],
        });
      }
    }
  }

  return edges;
}
