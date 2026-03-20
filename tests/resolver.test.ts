import { test, expect, describe } from "bun:test";
import {
  resolveImport,
  loadTsConfigPaths,
  isExternalImport,
  resolveFileImports,
  buildEdges,
} from "../src/resolver";
import { parseFile, resetProject } from "../src/parser";
import { resolve } from "node:path";
import type { FileNode, Import, ReExport } from "../src/types";

const FIXTURE_ROOT = resolve(import.meta.dir, "fixtures/sample-project");

describe("resolver - isExternalImport", () => {
  test("relative imports are not external", () => {
    expect(isExternalImport("./utils")).toBe(false);
    expect(isExternalImport("../lib/foo")).toBe(false);
    expect(isExternalImport("/absolute/path")).toBe(false);
  });

  test("node built-ins are external", () => {
    expect(isExternalImport("node:fs")).toBe(true);
    expect(isExternalImport("bun:test")).toBe(true);
  });

  test("npm packages are external", () => {
    expect(isExternalImport("ts-morph")).toBe(true);
    expect(isExternalImport("@types/node")).toBe(true);
    expect(isExternalImport("react")).toBe(true);
  });
});

describe("resolver - resolveImport (relative)", () => {
  test("resolves relative import with extension", () => {
    const fromFile = resolve(FIXTURE_ROOT, "src/service.ts");
    const result = resolveImport("./types", fromFile, FIXTURE_ROOT, null);
    expect(result).toBe("src/types.ts");
  });

  test("resolves relative import to .tsx file", () => {
    const fromFile = resolve(FIXTURE_ROOT, "src/barrel.ts");
    // component.tsx should be resolvable
    const result = resolveImport("./component", fromFile, FIXTURE_ROOT, null);
    expect(result).toBe("src/component.tsx");
  });

  test("returns null for unresolvable import", () => {
    const fromFile = resolve(FIXTURE_ROOT, "src/service.ts");
    const result = resolveImport("./nonexistent", fromFile, FIXTURE_ROOT, null);
    expect(result).toBeNull();
  });

  test("returns null for external package", () => {
    const fromFile = resolve(FIXTURE_ROOT, "src/service.ts");
    const result = resolveImport("ts-morph", fromFile, FIXTURE_ROOT, null);
    expect(result).toBeNull();
  });
});

describe("resolver - resolveImport (index barrel)", () => {
  test("resolves directory import to index.ts", async () => {
    // Create a temp directory with index.ts for this test
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const testDir = resolve(FIXTURE_ROOT, "src/subdir");
    const indexFile = resolve(testDir, "index.ts");

    try {
      mkdirSync(testDir, { recursive: true });
      writeFileSync(indexFile, "export const x = 1;");

      const fromFile = resolve(FIXTURE_ROOT, "src/service.ts");
      const result = resolveImport("./subdir", fromFile, FIXTURE_ROOT, null);
      expect(result).toBe("src/subdir/index.ts");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe("resolver - tsconfig paths", () => {
  test("loads tsconfig paths", async () => {
    const paths = await loadTsConfigPaths(FIXTURE_ROOT);
    expect(paths).not.toBeNull();
    expect(paths!.paths["@app/*"]).toBeDefined();
    expect(paths!.paths["@utils"]).toBeDefined();
  });

  test("resolves wildcard path alias", async () => {
    const paths = await loadTsConfigPaths(FIXTURE_ROOT);
    const fromFile = resolve(FIXTURE_ROOT, "src/service.ts");
    const result = resolveImport("@app/types", fromFile, FIXTURE_ROOT, paths);
    expect(result).toBe("src/types.ts");
  });

  test("resolves exact path alias", async () => {
    const paths = await loadTsConfigPaths(FIXTURE_ROOT);
    const fromFile = resolve(FIXTURE_ROOT, "src/service.ts");
    const result = resolveImport("@utils", fromFile, FIXTURE_ROOT, paths);
    expect(result).toBe("src/utils.ts");
  });

  test("returns null when tsconfig has no paths", async () => {
    // Use a directory without tsconfig
    const paths = await loadTsConfigPaths("/tmp/nonexistent");
    expect(paths).toBeNull();
  });
});

describe("resolver - resolveFileImports", () => {
  test("resolves all imports in a FileNode", async () => {
    resetProject();
    const paths = await loadTsConfigPaths(FIXTURE_ROOT);
    const fileNode = parseFile(
      resolve(FIXTURE_ROOT, "src/service.ts"),
      "src/service.ts",
    );

    resolveFileImports(fileNode, FIXTURE_ROOT, paths);

    const typesImport = fileNode.imports.find((i) => i.source === "./types");
    expect(typesImport!.resolvedPath).toBe("src/types.ts");
    expect(typesImport!.isExternal).toBe(false);
  });

  test("resolves re-export sources", async () => {
    resetProject();
    const paths = await loadTsConfigPaths(FIXTURE_ROOT);
    const fileNode = parseFile(
      resolve(FIXTURE_ROOT, "src/barrel.ts"),
      "src/barrel.ts",
    );

    resolveFileImports(fileNode, FIXTURE_ROOT, paths);

    const typesReExport = fileNode.reExports.find(
      (r) => r.source === "./types",
    );
    expect(typesReExport!.resolvedPath).toBe("src/types.ts");
  });
});

describe("resolver - buildEdges", () => {
  test("builds edges from resolved imports", () => {
    const files: FileNode[] = [
      {
        path: "src/service.ts",
        exports: [],
        imports: [
          {
            source: "./types",
            resolvedPath: "src/types.ts",
            namedImports: ["User", "Config"],
            isExternal: false,
          },
        ],
        classes: [],
        functions: [],
        types: [],
        enums: [],
        reExports: [],
      },
      {
        path: "src/types.ts",
        exports: [],
        imports: [],
        classes: [],
        functions: [],
        types: [],
        enums: [],
        reExports: [],
      },
    ];

    const edges = buildEdges(files);
    expect(edges.length).toBe(1);
    expect(edges[0]!.from).toBe("src/service.ts");
    expect(edges[0]!.to).toBe("src/types.ts");
    expect(edges[0]!.importedNames).toEqual(["User", "Config"]);
  });

  test("excludes edges to unknown files", () => {
    const files: FileNode[] = [
      {
        path: "src/service.ts",
        exports: [],
        imports: [
          {
            source: "react",
            resolvedPath: null,
            namedImports: [],
            isExternal: true,
          },
        ],
        classes: [],
        functions: [],
        types: [],
        enums: [],
        reExports: [],
      },
    ];

    const edges = buildEdges(files);
    expect(edges.length).toBe(0);
  });

  test("builds edges from re-exports", () => {
    const files: FileNode[] = [
      {
        path: "src/barrel.ts",
        exports: [],
        imports: [],
        classes: [],
        functions: [],
        types: [],
        enums: [],
        reExports: [
          {
            source: "./types",
            resolvedPath: "src/types.ts",
            names: [],
            isNamespaceReExport: true,
          },
        ],
      },
      {
        path: "src/types.ts",
        exports: [],
        imports: [],
        classes: [],
        functions: [],
        types: [],
        enums: [],
        reExports: [],
      },
    ];

    const edges = buildEdges(files);
    expect(edges.length).toBe(1);
    expect(edges[0]!.from).toBe("src/barrel.ts");
    expect(edges[0]!.to).toBe("src/types.ts");
    expect(edges[0]!.importedNames).toEqual(["*"]);
  });
});
