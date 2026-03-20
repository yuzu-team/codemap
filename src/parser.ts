/**
 * Parser - extracts AST information from a single TypeScript file using ts-morph.
 * Produces a FileNode with exports, imports, classes, functions, types, enums, and re-exports.
 */

import {
  Project,
  type SourceFile,
  Node,
  SyntaxKind,
  type ClassDeclaration,
  type FunctionDeclaration,
  type InterfaceDeclaration,
  type TypeAliasDeclaration,
  type EnumDeclaration,
  type VariableStatement,
  type ExportDeclaration,
  type ImportDeclaration,
  type MethodDeclaration,
  type PropertyDeclaration,
  type ParameterDeclaration,
  type PropertySignature,
  type MethodSignature,
  Scope,
} from "ts-morph";

import type {
  FileNode,
  Export,
  Import,
  ClassInfo,
  FunctionInfo,
  TypeInfo,
  EnumInfo,
  ReExport,
  ExportKind,
  MethodInfo,
  PropertyInfo,
  ParamInfo,
} from "./types";

/** Shared ts-morph Project instance for parsing */
let sharedProject: Project | null = null;

function getProject(): Project {
  if (!sharedProject) {
    sharedProject = new Project({
      compilerOptions: {
        allowJs: true,
        noEmit: true,
        skipLibCheck: true,
      },
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
    });
  }
  return sharedProject;
}

/**
 * Reset the shared project (useful between test runs or when processing many files).
 */
export function resetProject(): void {
  sharedProject = null;
}

/**
 * Extract JSDoc comment text from a node.
 */
function getJsDoc(node: Node): string | undefined {
  if (!Node.isJSDocable(node)) return undefined;
  const docs = node.getJsDocs();
  if (docs.length === 0) return undefined;
  // Get the last JSDoc (closest to the declaration)
  const doc = docs[docs.length - 1]!;
  return doc.getDescription().trim() || undefined;
}

/**
 * Extract parameter info from a parameter declaration.
 */
function extractParam(param: ParameterDeclaration): ParamInfo {
  return {
    name: param.getName(),
    type: param.getType().getText(param) || "unknown",
    isOptional: param.isOptional(),
    isRest: param.isRestParameter(),
    defaultValue: param.getInitializer()?.getText(),
  };
}

/**
 * Get the visibility/scope of a class member.
 */
function getVisibility(node: MethodDeclaration | PropertyDeclaration): "public" | "protected" | "private" {
  const scope = node.getScope();
  if (scope === Scope.Protected) return "protected";
  if (scope === Scope.Private) return "private";
  return "public";
}

/**
 * Extract method info from a class method declaration.
 */
function extractMethod(method: MethodDeclaration): MethodInfo {
  return {
    name: method.getName(),
    signature: method.getText().split("{")[0]!.trim(),
    returnType: method.getReturnType().getText(method),
    params: method.getParameters().map(extractParam),
    isStatic: method.isStatic(),
    isAsync: method.isAsync(),
    isAbstract: method.isAbstract(),
    visibility: getVisibility(method),
    jsdoc: getJsDoc(method),
  };
}

/**
 * Extract property info from a class property.
 */
function extractProperty(prop: PropertyDeclaration): PropertyInfo {
  return {
    name: prop.getName(),
    type: prop.getType().getText(prop),
    isOptional: prop.hasQuestionToken(),
    isReadonly: prop.isReadonly(),
    isStatic: prop.isStatic(),
    visibility: getVisibility(prop),
    jsdoc: getJsDoc(prop),
  };
}

/**
 * Extract property info from an interface property signature.
 */
function extractPropertySignature(prop: PropertySignature): PropertyInfo {
  return {
    name: prop.getName(),
    type: prop.getType().getText(prop),
    isOptional: prop.hasQuestionToken(),
    isReadonly: prop.isReadonly(),
    isStatic: false,
    visibility: "public",
    jsdoc: getJsDoc(prop),
  };
}

/**
 * Extract detailed class information.
 */
function extractClassInfo(cls: ClassDeclaration): ClassInfo {
  const name = cls.getName() || "default";
  const extendsClause = cls.getExtends();
  const implementsClauses = cls.getImplements();

  return {
    name,
    extends: extendsClause?.getText(),
    implements: implementsClauses.map((i) => i.getText()),
    methods: cls.getMethods().map(extractMethod),
    properties: cls.getProperties().map(extractProperty),
    isAbstract: cls.isAbstract(),
    typeParameters: cls.getTypeParameters().map((tp) => tp.getText()),
    jsdoc: getJsDoc(cls),
  };
}

/**
 * Extract detailed function information.
 */
function extractFunctionInfo(fn: FunctionDeclaration): FunctionInfo {
  const name = fn.getName() || "default";
  return {
    name,
    signature: fn.getText().split("{")[0]!.trim(),
    params: fn.getParameters().map(extractParam),
    returnType: fn.getReturnType().getText(fn),
    isAsync: fn.isAsync(),
    isGenerator: fn.isGenerator(),
    typeParameters: fn.getTypeParameters().map((tp) => tp.getText()),
    jsdoc: getJsDoc(fn),
  };
}

/**
 * Extract detailed type alias information.
 */
function extractTypeAliasInfo(typeAlias: TypeAliasDeclaration): TypeInfo {
  const typeNode = typeAlias.getTypeNode();
  const properties: PropertyInfo[] = [];

  // Try to extract properties if it's an object type
  const type = typeAlias.getType();
  for (const prop of type.getProperties()) {
    const decl = prop.getDeclarations()[0];
    if (decl && Node.isPropertySignature(decl)) {
      properties.push(extractPropertySignature(decl));
    }
  }

  return {
    name: typeAlias.getName(),
    kind: "type",
    properties,
    extends: [],
    typeParameters: typeAlias.getTypeParameters().map((tp) => tp.getText()),
    typeExpression: typeNode?.getText(),
    jsdoc: getJsDoc(typeAlias),
  };
}

/**
 * Extract detailed interface information.
 */
function extractInterfaceInfo(iface: InterfaceDeclaration): TypeInfo {
  const extendsExprs = iface.getExtends();

  return {
    name: iface.getName(),
    kind: "interface",
    properties: iface.getProperties().map(extractPropertySignature),
    extends: extendsExprs.map((e) => e.getText()),
    typeParameters: iface.getTypeParameters().map((tp) => tp.getText()),
    jsdoc: getJsDoc(iface),
  };
}

/**
 * Extract detailed enum information.
 */
function extractEnumInfo(enumDecl: EnumDeclaration): EnumInfo {
  return {
    name: enumDecl.getName(),
    members: enumDecl.getMembers().map((m) => ({
      name: m.getName(),
      value: m.getValue()?.toString(),
    })),
    isConst: enumDecl.isConstEnum(),
    jsdoc: getJsDoc(enumDecl),
  };
}

/**
 * Determine the export kind from a node.
 */
function getExportKind(node: Node): ExportKind {
  if (Node.isClassDeclaration(node)) return "class";
  if (Node.isFunctionDeclaration(node)) return "function";
  if (Node.isInterfaceDeclaration(node)) return "interface";
  if (Node.isTypeAliasDeclaration(node)) return "type";
  if (Node.isEnumDeclaration(node)) return "enum";
  if (Node.isVariableDeclaration(node)) {
    // Check if it's a const
    const parent = node.getParent();
    if (Node.isVariableDeclarationList(parent)) {
      const flags = parent.getDeclarationKind();
      if (flags.toString() === "const") return "const";
    }
    return "variable";
  }
  if (Node.isVariableStatement(node)) return "const";
  return "variable";
}

/**
 * Get a clean signature string for an exported symbol.
 */
function getSignature(node: Node): string {
  if (Node.isFunctionDeclaration(node)) {
    // Get signature without the body
    return node.getText().split("{")[0]!.trim();
  }
  if (Node.isClassDeclaration(node)) {
    // Class name + extends/implements
    const cls = node as ClassDeclaration;
    let sig = `class ${cls.getName() || "default"}`;
    const ext = cls.getExtends();
    if (ext) sig += ` extends ${ext.getText()}`;
    const impls = cls.getImplements();
    if (impls.length > 0) sig += ` implements ${impls.map((i) => i.getText()).join(", ")}`;
    return sig;
  }
  if (Node.isInterfaceDeclaration(node)) {
    const iface = node as InterfaceDeclaration;
    let sig = `interface ${iface.getName()}`;
    const ext = iface.getExtends();
    if (ext.length > 0) sig += ` extends ${ext.map((e) => e.getText()).join(", ")}`;
    return sig;
  }
  if (Node.isTypeAliasDeclaration(node)) {
    return node.getText().replace(/\n/g, " ").trim();
  }
  if (Node.isEnumDeclaration(node)) {
    const enumDecl = node as EnumDeclaration;
    return `enum ${enumDecl.getName()}`;
  }
  if (Node.isVariableDeclaration(node)) {
    const name = node.getName();
    const typeNode = node.getTypeNode();
    if (typeNode) return `const ${name}: ${typeNode.getText()}`;
    const init = node.getInitializer();
    if (init) {
      const text = init.getText();
      // Truncate long initializers
      if (text.length > 80) return `const ${name} = ${text.slice(0, 77)}...`;
      return `const ${name} = ${text}`;
    }
    return `const ${name}`;
  }
  return node.getText().slice(0, 100);
}

/**
 * Extract all exports from a source file.
 */
function extractExports(sourceFile: SourceFile): Export[] {
  const exports: Export[] = [];

  // Exported declarations (functions, classes, etc.)
  for (const [name, decls] of sourceFile.getExportedDeclarations()) {
    for (const decl of decls) {
      exports.push({
        name,
        kind: getExportKind(decl),
        signature: getSignature(decl),
        jsdoc: Node.isJSDocable(decl) ? getJsDoc(decl) : undefined,
        isDefault: name === "default",
      });
    }
  }

  return exports;
}

/**
 * Extract all imports from a source file.
 */
function extractImports(sourceFile: SourceFile): Import[] {
  const imports: Import[] = [];

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const moduleSpecifier = importDecl.getModuleSpecifierValue();
    const namedImports = importDecl
      .getNamedImports()
      .map((ni) => ni.getName());
    const defaultImport = importDecl.getDefaultImport()?.getText();
    const namespaceImport = importDecl.getNamespaceImport()?.getText();

    // Determine if external (doesn't start with . or /)
    const isExternal = !moduleSpecifier.startsWith(".") && !moduleSpecifier.startsWith("/");

    imports.push({
      source: moduleSpecifier,
      resolvedPath: null, // Will be resolved by the resolver module
      namedImports,
      defaultImport,
      namespaceImport,
      isExternal,
    });
  }

  return imports;
}

/**
 * Extract barrel re-exports from a source file.
 */
function extractReExports(sourceFile: SourceFile): ReExport[] {
  const reExports: ReExport[] = [];

  for (const exportDecl of sourceFile.getExportDeclarations()) {
    const moduleSpecifier = exportDecl.getModuleSpecifierValue();
    if (!moduleSpecifier) continue; // Skip `export { x }` without `from`

    const namedExports = exportDecl.getNamedExports().map((ne) => ne.getName());
    const isNamespaceReExport = exportDecl.isNamespaceExport();

    reExports.push({
      source: moduleSpecifier,
      resolvedPath: null,
      names: namedExports,
      isNamespaceReExport,
    });
  }

  return reExports;
}

/**
 * Parse a single TypeScript file and extract all AST information.
 *
 * @param filePath - Absolute path to the file
 * @param relativePath - Path relative to project root (used in FileNode.path)
 * @returns FileNode with all extracted information
 */
export function parseFile(filePath: string, relativePath: string): FileNode {
  const project = getProject();

  // Add or update the source file
  let sourceFile = project.getSourceFile(filePath);
  if (!sourceFile) {
    sourceFile = project.addSourceFileAtPath(filePath);
  }

  // Extract all information
  const exports = extractExports(sourceFile);
  const imports = extractImports(sourceFile);
  const reExportsList = extractReExports(sourceFile);

  // Extract detailed info for classes, functions, types, enums
  const classes: ClassInfo[] = [];
  const functions: FunctionInfo[] = [];
  const types: TypeInfo[] = [];
  const enums: EnumInfo[] = [];

  for (const cls of sourceFile.getClasses()) {
    classes.push(extractClassInfo(cls));
  }

  for (const fn of sourceFile.getFunctions()) {
    functions.push(extractFunctionInfo(fn));
  }

  for (const iface of sourceFile.getInterfaces()) {
    types.push(extractInterfaceInfo(iface));
  }

  for (const typeAlias of sourceFile.getTypeAliases()) {
    types.push(extractTypeAliasInfo(typeAlias));
  }

  for (const enumDecl of sourceFile.getEnums()) {
    enums.push(extractEnumInfo(enumDecl));
  }

  // Clean up - remove the source file from the project to avoid memory leaks
  project.removeSourceFile(sourceFile);

  return {
    path: relativePath,
    exports,
    imports,
    classes,
    functions,
    types,
    enums,
    reExports: reExportsList,
  };
}
