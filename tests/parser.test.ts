import { test, expect, describe, beforeEach } from "bun:test";
import { parseFile, resetProject } from "../src/parser";
import { resolve } from "node:path";

const FIXTURE_ROOT = resolve(import.meta.dir, "fixtures/sample-project");

beforeEach(() => {
  resetProject();
});

describe("parser - exports", () => {
  test("extracts function exports", () => {
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/index.ts"),
      "src/index.ts",
    );
    const helloExport = result.exports.find((e) => e.name === "hello");
    expect(helloExport).toBeDefined();
    expect(helloExport!.kind).toBe("function");
    expect(helloExport!.isDefault).toBe(false);
  });

  test("extracts const exports", () => {
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/utils.ts"),
      "src/utils.ts",
    );
    const versionExport = result.exports.find((e) => e.name === "VERSION");
    expect(versionExport).toBeDefined();
    expect(versionExport!.kind).toBe("const");
  });

  test("extracts class exports", () => {
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/service.ts"),
      "src/service.ts",
    );
    const userServiceExport = result.exports.find(
      (e) => e.name === "UserService",
    );
    expect(userServiceExport).toBeDefined();
    expect(userServiceExport!.kind).toBe("class");
  });

  test("extracts interface exports", () => {
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/types.ts"),
      "src/types.ts",
    );
    const userExport = result.exports.find((e) => e.name === "User");
    expect(userExport).toBeDefined();
    expect(userExport!.kind).toBe("interface");
  });

  test("extracts type alias exports", () => {
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/types.ts"),
      "src/types.ts",
    );
    const configExport = result.exports.find((e) => e.name === "Config");
    expect(configExport).toBeDefined();
    expect(configExport!.kind).toBe("type");
  });
});

describe("parser - JSDoc", () => {
  test("extracts JSDoc from exports", () => {
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/types.ts"),
      "src/types.ts",
    );
    const userExport = result.exports.find((e) => e.name === "User");
    expect(userExport!.jsdoc).toBe("A user in the system");
  });

  test("extracts JSDoc from class methods", () => {
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/service.ts"),
      "src/service.ts",
    );
    const userService = result.classes.find((c) => c.name === "UserService");
    const getUser = userService!.methods.find((m) => m.name === "getUser");
    expect(getUser!.jsdoc).toBe("Get a user by ID");
  });
});

describe("parser - classes", () => {
  test("extracts class extends", () => {
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/service.ts"),
      "src/service.ts",
    );
    const userService = result.classes.find((c) => c.name === "UserService");
    expect(userService).toBeDefined();
    expect(userService!.extends).toBe("BaseService");
  });

  test("extracts abstract class", () => {
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/service.ts"),
      "src/service.ts",
    );
    const baseService = result.classes.find((c) => c.name === "BaseService");
    expect(baseService).toBeDefined();
    expect(baseService!.isAbstract).toBe(true);
  });

  test("extracts class methods with signatures", () => {
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/service.ts"),
      "src/service.ts",
    );
    const userService = result.classes.find((c) => c.name === "UserService");
    expect(userService!.methods.length).toBeGreaterThanOrEqual(3);

    const createUser = userService!.methods.find(
      (m) => m.name === "createUser",
    );
    expect(createUser).toBeDefined();
    expect(createUser!.isAsync).toBe(true);
    expect(createUser!.params.length).toBe(2);
    expect(createUser!.params[0]!.name).toBe("name");
    expect(createUser!.params[1]!.name).toBe("email");
    expect(createUser!.params[1]!.isOptional).toBe(true);
  });

  test("extracts class properties with visibility", () => {
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/service.ts"),
      "src/service.ts",
    );
    const baseService = result.classes.find((c) => c.name === "BaseService");
    const configProp = baseService!.properties.find(
      (p) => p.name === "config",
    );
    expect(configProp).toBeDefined();
    expect(configProp!.visibility).toBe("protected");
  });
});

describe("parser - functions", () => {
  test("extracts function params and return type", () => {
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/service.ts"),
      "src/service.ts",
    );
    const validateEmail = result.functions.find(
      (f) => f.name === "validateEmail",
    );
    expect(validateEmail).toBeDefined();
    expect(validateEmail!.params.length).toBe(1);
    expect(validateEmail!.params[0]!.name).toBe("email");
    expect(validateEmail!.params[0]!.type).toBe("string");
    expect(validateEmail!.returnType).toBe("boolean");
  });
});

describe("parser - types and interfaces", () => {
  test("extracts interface properties", () => {
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/types.ts"),
      "src/types.ts",
    );
    const user = result.types.find((t) => t.name === "User");
    expect(user).toBeDefined();
    expect(user!.kind).toBe("interface");
    expect(user!.properties.length).toBe(3);

    const emailProp = user!.properties.find((p) => p.name === "email");
    expect(emailProp!.isOptional).toBe(true);
  });

  test("extracts interface extends", () => {
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/types.ts"),
      "src/types.ts",
    );
    const adminUser = result.types.find((t) => t.name === "AdminUser");
    expect(adminUser).toBeDefined();
    expect(adminUser!.extends).toContain("User");
  });

  test("extracts type aliases", () => {
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/types.ts"),
      "src/types.ts",
    );
    const config = result.types.find((t) => t.name === "Config");
    expect(config).toBeDefined();
    expect(config!.kind).toBe("type");
    expect(config!.properties.length).toBe(3);
  });
});

describe("parser - imports", () => {
  test("extracts named imports", () => {
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/service.ts"),
      "src/service.ts",
    );
    const typesImport = result.imports.find((i) => i.source === "./types");
    expect(typesImport).toBeDefined();
    expect(typesImport!.namedImports).toContain("User");
    expect(typesImport!.namedImports).toContain("Config");
    expect(typesImport!.isExternal).toBe(false);
  });

  test("identifies external imports", () => {
    // index.ts has no external imports, but let's verify the logic
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/index.ts"),
      "src/index.ts",
    );
    // No external imports in this file
    const externalImports = result.imports.filter((i) => i.isExternal);
    expect(externalImports.length).toBe(0);
  });
});

describe("parser - re-exports", () => {
  test("extracts barrel re-exports (export *)", () => {
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/barrel.ts"),
      "src/barrel.ts",
    );
    const starReExport = result.reExports.find(
      (r) => r.source === "./types" && r.names.length === 0,
    );
    expect(starReExport).toBeDefined();
    // export * from is a namespace re-export in ts-morph
    expect(starReExport!.isNamespaceReExport).toBe(true);
  });

  test("extracts named re-exports", () => {
    const result = parseFile(
      resolve(FIXTURE_ROOT, "src/barrel.ts"),
      "src/barrel.ts",
    );
    const serviceReExport = result.reExports.find(
      (r) => r.source === "./service",
    );
    expect(serviceReExport).toBeDefined();
    expect(serviceReExport!.names).toContain("UserService");
  });
});
