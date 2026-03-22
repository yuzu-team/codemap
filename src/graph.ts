/**
 * Graph — builds dependency graph and module groupings from parsed files.
 * Detects circular dependencies and computes module-level edges.
 */

import { dirname, join, resolve } from "node:path";
import type { FileNode, Edge, ModuleInfo, CodeGraph } from "./types";
import { buildEdges, resolveFileImports, initResolvers } from "./resolver";
import { scan } from "./scanner";
import { parseFiles, registerPlugin, initParser } from "./parser";
import { registerTypescript } from "./languages/typescript";

/**
 * Group files into modules by directory.
 * A module = a directory containing source files.
 */
export function groupIntoModules(files: FileNode[]): ModuleInfo[] {
  const moduleMap = new Map<string, string[]>();

  for (const file of files) {
    const dir = dirname(file.path);
    const existing = moduleMap.get(dir);
    if (existing) {
      existing.push(file.path);
    } else {
      moduleMap.set(dir, [file.path]);
    }
  }

  const modules: ModuleInfo[] = [];
  for (const [dir, filePaths] of moduleMap) {
    // Module name = last directory segment, or "root" for top-level
    const name = dir === "." ? "root" : dir.split("/").pop() ?? dir;
    modules.push({
      name,
      path: dir,
      files: filePaths.sort(),
    });
  }

  return modules.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Detect circular dependencies in the edge graph.
 * Returns arrays of file paths that form cycles.
 */
export function detectCircularDeps(edges: Edge[]): string[][] {
  // Build adjacency list
  const adj = new Map<string, Set<string>>();
  for (const edge of edges) {
    const neighbors = adj.get(edge.from);
    if (neighbors) {
      neighbors.add(edge.to);
    } else {
      adj.set(edge.from, new Set([edge.to]));
    }
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string): void {
    if (inStack.has(node)) {
      // Found a cycle — extract it
      const cycleStart = stack.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push(stack.slice(cycleStart));
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    stack.push(node);

    const neighbors = adj.get(node);
    if (neighbors) {
      for (const neighbor of neighbors) {
        dfs(neighbor);
      }
    }

    stack.pop();
    inStack.delete(node);
  }

  // Run DFS from all nodes
  for (const node of adj.keys()) {
    dfs(node);
  }

  return cycles;
}

/**
 * Compute module-level dependency edges (directory → directory).
 */
export function computeModuleEdges(
  edges: Edge[],
  modules: ModuleInfo[],
): { from: string; to: string; count: number }[] {
  // Map file → module path
  const fileToModule = new Map<string, string>();
  for (const mod of modules) {
    for (const file of mod.files) {
      fileToModule.set(file, mod.path);
    }
  }

  // Aggregate edges at module level
  const moduleEdgeMap = new Map<string, number>();
  for (const edge of edges) {
    const fromMod = fileToModule.get(edge.from);
    const toMod = fileToModule.get(edge.to);
    if (!fromMod || !toMod || fromMod === toMod) continue; // skip intra-module

    const key = `${fromMod}→${toMod}`;
    moduleEdgeMap.set(key, (moduleEdgeMap.get(key) ?? 0) + 1);
  }

  const result: { from: string; to: string; count: number }[] = [];
  for (const [key, count] of moduleEdgeMap) {
    const [from, to] = key.split("→") as [string, string];
    result.push({ from, to, count });
  }

  return result.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/**
 * Compute SHA-256 content hash for a list of files.
 * Returns a map of relative path → hex hash.
 */
export async function computeFileHashes(
  rootPath: string,
  relativePaths: string[],
): Promise<Record<string, string>> {
  const absRoot = resolve(rootPath);
  const hashes: Record<string, string> = {};

  for (const relPath of relativePaths) {
    const file = Bun.file(join(absRoot, relPath));
    const buffer = await file.arrayBuffer();
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(buffer);
    hashes[relPath] = hasher.digest("hex");
  }

  return hashes;
}

/**
 * Diff file hashes to determine what changed.
 * Returns sets of added, changed, and removed file paths.
 */
export function diffFileHashes(
  oldHashes: Record<string, string>,
  newHashes: Record<string, string>,
): { added: string[]; changed: string[]; removed: string[] } {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const path of Object.keys(newHashes)) {
    if (!(path in oldHashes)) {
      added.push(path);
    } else if (oldHashes[path] !== newHashes[path]) {
      changed.push(path);
    }
  }

  for (const path of Object.keys(oldHashes)) {
    if (!(path in newHashes)) {
      removed.push(path);
    }
  }

  return { added, changed, removed };
}

async function initPipeline(rootPath: string): Promise<void> {
  await initParser();
  const tsPlugin = await registerTypescript();
  registerPlugin(tsPlugin);
  await initResolvers(rootPath);
}

function getCommitHash(rootPath: string): string | undefined {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
      cwd: rootPath,
    });
    return proc.stdout.toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the complete code graph for a project (full rebuild).
 * This is the main orchestration function.
 */
export async function buildCodeGraph(
  rootPath: string,
  options: { include?: string[]; exclude?: string[] } = {},
): Promise<CodeGraph> {
  await initPipeline(rootPath);

  // Scan for source files
  const filePaths = await scan(rootPath, options);

  // Hash all files
  const fileHashes = await computeFileHashes(rootPath, filePaths);

  // Parse all files
  const files = await parseFiles(rootPath, filePaths);

  // Resolve imports
  for (const file of files) {
    resolveFileImports(file, rootPath);
  }

  // Build dependency edges
  const edges = buildEdges(files);

  // Group into modules
  const modules = groupIntoModules(files);

  return {
    root: rootPath,
    files,
    edges,
    modules,
    fileHashes,
    commitHash: getCommitHash(rootPath),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Incrementally rebuild a code graph by re-parsing only changed files.
 * Keeps unchanged FileNodes from the previous graph intact.
 */
export async function incrementalBuildCodeGraph(
  rootPath: string,
  previousGraph: CodeGraph,
  options: { include?: string[]; exclude?: string[] } = {},
): Promise<{ graph: CodeGraph; stats: { added: number; changed: number; removed: number; unchanged: number } }> {
  await initPipeline(rootPath);

  // Scan current file list
  const filePaths = await scan(rootPath, options);

  // Hash current files
  const newHashes = await computeFileHashes(rootPath, filePaths);

  // Diff against previous hashes
  const oldHashes = previousGraph.fileHashes ?? {};
  const diff = diffFileHashes(oldHashes, newHashes);

  // Index previous files for fast lookup
  const prevFileMap = new Map<string, FileNode>();
  for (const file of previousGraph.files) {
    prevFileMap.set(file.path, file);
  }

  // Parse only added + changed files
  const dirtyPaths = [...diff.added, ...diff.changed];
  const freshFiles = dirtyPaths.length > 0
    ? await parseFiles(rootPath, dirtyPaths)
    : [];

  // Build the new file list: unchanged files from previous + freshly parsed
  const dirtySet = new Set(dirtyPaths);
  const removedSet = new Set(diff.removed);
  const unchangedFiles: FileNode[] = [];
  for (const file of previousGraph.files) {
    if (!dirtySet.has(file.path) && !removedSet.has(file.path)) {
      unchangedFiles.push(file);
    }
  }
  const allFiles = [...unchangedFiles, ...freshFiles];

  // Re-resolve imports for all files (edges may shift if a changed file's exports changed)
  for (const file of allFiles) {
    resolveFileImports(file, rootPath);
  }

  // Rebuild edges and modules from the full file list
  const edges = buildEdges(allFiles);
  const modules = groupIntoModules(allFiles);

  const graph: CodeGraph = {
    root: rootPath,
    files: allFiles,
    edges,
    modules,
    fileHashes: newHashes,
    commitHash: getCommitHash(rootPath),
    generatedAt: new Date().toISOString(),
  };

  const stats = {
    added: diff.added.length,
    changed: diff.changed.length,
    removed: diff.removed.length,
    unchanged: unchangedFiles.length,
  };

  return { graph, stats };
}
