import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCodeGraph,
  incrementalBuildCodeGraph,
  computeFileHashes,
  diffFileHashes,
} from "../src/graph";
import { addSummaries } from "../src/summarizer";

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "codemap-incr-"));
  await mkdir(join(testDir, "src"), { recursive: true });
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function writeTS(relPath: string, content: string) {
  const full = join(testDir, relPath);
  const dir = full.slice(0, full.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(full, content, "utf-8");
}

describe("computeFileHashes", () => {
  test("returns hex sha256 hashes for files", async () => {
    await writeTS("src/a.ts", 'export const a = 1;\n');
    await writeTS("src/b.ts", 'export const b = 2;\n');

    const hashes = await computeFileHashes(testDir, ["src/a.ts", "src/b.ts"]);
    expect(Object.keys(hashes)).toEqual(["src/a.ts", "src/b.ts"]);
    // SHA-256 hex is 64 chars
    expect(hashes["src/a.ts"]!.length).toBe(64);
    expect(hashes["src/b.ts"]!.length).toBe(64);
    // Different content = different hash
    expect(hashes["src/a.ts"]).not.toBe(hashes["src/b.ts"]);
  });

  test("same content produces same hash", async () => {
    await writeTS("src/c.ts", 'export const c = 1;\n');
    const h1 = await computeFileHashes(testDir, ["src/c.ts"]);
    const h2 = await computeFileHashes(testDir, ["src/c.ts"]);
    expect(h1["src/c.ts"]).toBe(h2["src/c.ts"]);
  });
});

describe("diffFileHashes", () => {
  test("detects added files", () => {
    const old = { "a.ts": "aaa" };
    const cur = { "a.ts": "aaa", "b.ts": "bbb" };
    const diff = diffFileHashes(old, cur);
    expect(diff.added).toEqual(["b.ts"]);
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  test("detects changed files", () => {
    const old = { "a.ts": "aaa" };
    const cur = { "a.ts": "xxx" };
    const diff = diffFileHashes(old, cur);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual(["a.ts"]);
    expect(diff.removed).toEqual([]);
  });

  test("detects removed files", () => {
    const old = { "a.ts": "aaa", "b.ts": "bbb" };
    const cur = { "a.ts": "aaa" };
    const diff = diffFileHashes(old, cur);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual(["b.ts"]);
  });

  test("detects all three at once", () => {
    const old = { "a.ts": "aaa", "b.ts": "bbb" };
    const cur = { "a.ts": "xxx", "c.ts": "ccc" };
    const diff = diffFileHashes(old, cur);
    expect(diff.added).toEqual(["c.ts"]);
    expect(diff.changed).toEqual(["a.ts"]);
    expect(diff.removed).toEqual(["b.ts"]);
  });

  test("no changes returns empty sets", () => {
    const hashes = { "a.ts": "aaa", "b.ts": "bbb" };
    const diff = diffFileHashes(hashes, hashes);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual([]);
  });
});

describe("incrementalBuildCodeGraph", () => {
  test("full build includes fileHashes", async () => {
    await writeTS("src/alpha.ts", 'export function alpha() { return 1; }\n');
    await writeTS("src/beta.ts", 'import { alpha } from "./alpha";\nexport const b = alpha();\n');

    const graph = await buildCodeGraph(testDir);
    expect(graph.fileHashes).toBeDefined();
    expect(Object.keys(graph.fileHashes).length).toBeGreaterThanOrEqual(2);
    expect(graph.fileHashes["src/alpha.ts"]).toBeDefined();
    expect(graph.fileHashes["src/beta.ts"]).toBeDefined();
  });

  test("returns zero changes when nothing changed", async () => {
    const graph = await buildCodeGraph(testDir);
    const { graph: newGraph, stats } = await incrementalBuildCodeGraph(testDir, graph);

    expect(stats.added).toBe(0);
    expect(stats.changed).toBe(0);
    expect(stats.removed).toBe(0);
    expect(stats.unchanged).toBe(graph.files.length);
    expect(newGraph.files.length).toBe(graph.files.length);
  });

  test("re-parses only changed file", async () => {
    const graph = await buildCodeGraph(testDir);
    const originalAlphaHash = graph.fileHashes["src/alpha.ts"];

    // Modify alpha.ts
    await writeTS("src/alpha.ts", 'export function alpha() { return 42; }\nexport function gamma() { return 0; }\n');

    const { graph: newGraph, stats } = await incrementalBuildCodeGraph(testDir, graph);

    expect(stats.changed).toBe(1);
    expect(stats.added).toBe(0);
    expect(stats.removed).toBe(0);
    // Hash should be different now
    expect(newGraph.fileHashes["src/alpha.ts"]).not.toBe(originalAlphaHash);
    // The new file should have the gamma export
    const alphaNode = newGraph.files.find(f => f.path === "src/alpha.ts");
    expect(alphaNode).toBeDefined();
    const exportNames = alphaNode!.exports.map(e => e.name);
    expect(exportNames).toContain("gamma");
  });

  test("handles new files", async () => {
    const graph = await buildCodeGraph(testDir);
    const prevCount = graph.files.length;

    // Add a new file
    await writeTS("src/delta.ts", 'export const delta = "new";\n');

    const { graph: newGraph, stats } = await incrementalBuildCodeGraph(testDir, graph);

    expect(stats.added).toBe(1);
    expect(newGraph.files.length).toBe(prevCount + 1);
    const deltaNode = newGraph.files.find(f => f.path === "src/delta.ts");
    expect(deltaNode).toBeDefined();
    expect(deltaNode!.exports.map(e => e.name)).toContain("delta");
  });

  test("handles deleted files", async () => {
    const graph = await buildCodeGraph(testDir);
    const prevCount = graph.files.length;

    // Delete delta.ts
    await rm(join(testDir, "src/delta.ts"));

    const { graph: newGraph, stats } = await incrementalBuildCodeGraph(testDir, graph);

    expect(stats.removed).toBe(1);
    expect(newGraph.files.length).toBe(prevCount - 1);
    expect(newGraph.files.find(f => f.path === "src/delta.ts")).toBeUndefined();
    expect(newGraph.fileHashes["src/delta.ts"]).toBeUndefined();
  });

  test("unchanged files keep their FileNode identity", async () => {
    const graph = await buildCodeGraph(testDir);
    const betaBefore = graph.files.find(f => f.path === "src/beta.ts");

    // Modify only alpha
    await writeTS("src/alpha.ts", 'export function alpha() { return 99; }\n');

    const { graph: newGraph } = await incrementalBuildCodeGraph(testDir, graph);
    const betaAfter = newGraph.files.find(f => f.path === "src/beta.ts");

    // beta was not re-parsed — should be the exact same object
    expect(betaAfter).toBe(betaBefore);
  });
});
