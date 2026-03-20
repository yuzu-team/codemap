import { test, expect, describe } from "bun:test";
import { scan } from "../src/scanner";
import { resolve } from "node:path";

const FIXTURE_ROOT = resolve(import.meta.dir, "fixtures/sample-project");

describe("scanner", () => {
  test("finds .ts and .tsx files", async () => {
    const files = await scan(FIXTURE_ROOT);
    expect(files).toContain("src/index.ts");
    expect(files).toContain("src/utils.ts");
    expect(files).toContain("src/component.tsx");
  });

  test("skips node_modules and dist", async () => {
    const files = await scan(FIXTURE_ROOT);
    const hasNodeModules = files.some((f) => f.includes("node_modules"));
    const hasDist = files.some((f) => f.includes("dist"));
    expect(hasNodeModules).toBe(false);
    expect(hasDist).toBe(false);
  });

  test("respects .gitignore patterns", async () => {
    const files = await scan(FIXTURE_ROOT);
    const hasGenerated = files.some((f) => f.includes(".generated."));
    expect(hasGenerated).toBe(false);
  });

  test("returns sorted results", async () => {
    const files = await scan(FIXTURE_ROOT);
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
  });

  test("supports exclude patterns", async () => {
    const files = await scan(FIXTURE_ROOT, {
      include: [],
      exclude: ["**/*.tsx"],
    });
    expect(files).not.toContain("src/component.tsx");
    expect(files).toContain("src/index.ts");
  });

  test("supports include patterns", async () => {
    const files = await scan(FIXTURE_ROOT, {
      include: ["src/index.ts"],
      exclude: [],
    });
    expect(files).toEqual(["src/index.ts"]);
  });
});
