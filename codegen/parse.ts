import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseGraphQL } from "graphql";
import ts from "typescript";

// Page parser for Crucible's direct-export page contract:
//
//   export const query = graphql`query PageQuery @preloadable { ... }`;
//   export const searchParams = SomeStandardSchema;
//   export default function Page({ data, params, search }) { ... }
//
// The page's *primary query* — the one whose `PreloadedQuery` is passed
// as `data` — is discovered from the exported `query` binding. Pages without
// data omit it. When present, it must be a named `@preloadable` operation.

export type QueryField = {
  // Property key on the page's preloaded data — fixed to `data` for
  // the page's primary query.
  fieldName: string;
  // Original exported name from the relay-compiler artifact (e.g.
  // `page_HomeQuery`). The name we `import` to get the parameters.
  artifactExport: string;
  // Resolved absolute path to the `.graphql` (without `.ts`) artifact
  // stem — relay-compiler emits TS artifacts as `<stem>.ts`.
  artifactPath: string;
};

export type ParsedPage = {
  pageFile: string;
  queries: ReadonlyArray<QueryField>;
  // Operation name → ordered list of variable names. Source: the
  // `graphql\`query Foo($id: ID!) {...}\`` template in the page.
  operationVariables: ReadonlyMap<string, ReadonlyArray<string>>;
  // True when the page directly exports `searchParams`.
  // Codegen uses this to widen the page's `search` prop from
  // `URLSearchParams` to the inferred shape.
  hasSearchParams: boolean;
};

export function parsePage(pageFile: string): ParsedPage {
  const source = readFileSync(pageFile, "utf8");
  const sf = ts.createSourceFile(
    pageFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const importMap = buildImportMap(sf);
  const operationVariables = collectOperationVariables(sf);
  const pageDir = dirname(pageFile);

  const directExports = readDirectPageExports(sf, pageFile);
  const queries: QueryField[] = [];
  if (directExports.query) {
    queries.push(
      resolvePreloadableQuery(directExports.query, importMap, pageDir, pageFile),
    );
  }

  return {
    pageFile,
    queries,
    operationVariables,
    hasSearchParams: directExports.hasSearchParams,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

function buildImportMap(
  sf: ts.SourceFile,
): Map<string, { exported: string; moduleSpecifier: string }> {
  const importMap = new Map<
    string,
    { exported: string; moduleSpecifier: string }
  >();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const moduleSpec = (stmt.moduleSpecifier as ts.StringLiteral).text;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name) {
      importMap.set(clause.name.text, {
        exported: "default",
        moduleSpecifier: moduleSpec,
      });
    }
    const named = clause.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const elt of named.elements) {
        const local = elt.name.text;
        const exported = elt.propertyName?.text ?? local;
        importMap.set(local, { exported, moduleSpecifier: moduleSpec });
      }
    } else if (named && ts.isNamespaceImport(named)) {
      importMap.set(named.name.text, {
        exported: "*",
        moduleSpecifier: moduleSpec,
      });
    }
  }
  return importMap;
}

function readDirectPageExports(
  sf: ts.SourceFile,
  pageFile: string,
): {
  query: { operationName: string; sourceTagText: string } | null;
  hasSearchParams: boolean;
  hasEntryPointsExport: boolean;
} {
  let query: { operationName: string; sourceTagText: string } | null = null;
  let hasSearchParams = false;
  let hasEntryPointsExport = false;

  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const isExported = stmt.modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!isExported) continue;

    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;

      if (name === "query") {
        if (
          !decl.initializer ||
          !ts.isTaggedTemplateExpression(decl.initializer) ||
          !isGraphqlTag(decl.initializer.tag)
        ) {
          throw new Error(
            `[crucible] \`export const query\` in ${pageFile} must be initialized with a \`graphql\`...\`\` tagged template.`,
          );
        }
        const next = readPreloadableGraphqlTag(decl.initializer, pageFile);
        if (!next) {
          throw new Error(
            `[crucible] \`export const query\` in ${pageFile} must contain a named \`@preloadable\` operation.`,
          );
        }
        if (query) {
          throw new Error(
            `[crucible] ${pageFile} exports more than one \`query\`. A page must have exactly one primary query export.`,
          );
        }
        query = next;
      } else if (name === "searchParams") {
        hasSearchParams = true;
      } else if (name === "entryPoints") {
        hasEntryPointsExport = true;
      }
    }
  }

  if (hasEntryPointsExport) {
    throw new Error(
      `[crucible] \`export const entryPoints\` is not supported in ${pageFile}. Use filesystem routes and parallel route slots for parallel UI/data loading.`,
    );
  }

  return { query, hasSearchParams, hasEntryPointsExport };
}

function readPreloadableGraphqlTag(
  node: ts.TaggedTemplateExpression,
  pageFile: string,
): { operationName: string; sourceTagText: string } | null {
  const text = templateText(node.template);
  if (!text || !text.includes("@preloadable")) return null;

  let doc: ReturnType<typeof parseGraphQL> | null = null;
  try {
    doc = parseGraphQL(text);
  } catch {
    /* relay-compiler will raise its own error for malformed graphql */
  }
  if (!doc) return null;

  let result: { operationName: string; sourceTagText: string } | null = null;
  for (const def of doc.definitions) {
    if (def.kind !== "OperationDefinition") continue;
    const hasPreloadable = (def.directives ?? []).some(
      (d) => d.name.value === "preloadable",
    );
    if (!hasPreloadable || !def.name) continue;
    if (result) {
      throw new Error(
        `[crucible] ${pageFile} has more than one \`@preloadable\` operation inside \`export const query\`. A page must have exactly one primary query export.`,
      );
    }
    result = { operationName: def.name.value, sourceTagText: text };
  }
  return result;
}

// Resolve the direct `query` export's operation name to the relay-compiler
// artifact path. Two strategies, in order:
//
//   1. Look for an explicit `import { <OpName> } from "<path>/<OpName>.graphql"`
//      in the page. Wins when the user happens to type-import the
//      generated artifact (e.g. for a custom artifactDirectory).
//   2. Fall back to relay-compiler's colocated default:
//      `<pageDir>/__generated__/<OpName>.graphql.ts`. The exported query's
//      operation name is the durable pointer; users shouldn't have to author
//      a dummy type-only import just to satisfy codegen.
function resolvePreloadableQuery(
  preloadable: { operationName: string; sourceTagText: string },
  importMap: Map<string, { exported: string; moduleSpecifier: string }>,
  pageDir: string,
  _pageFile: string,
): QueryField {
  const opName = preloadable.operationName;
  for (const [_local, imp] of importMap) {
    if (imp.moduleSpecifier.endsWith(`${opName}.graphql`) && imp.exported === opName) {
      return {
        fieldName: "data",
        artifactExport: opName,
        artifactPath: resolve(pageDir, imp.moduleSpecifier),
      };
    }
  }
  return {
    fieldName: "data",
    artifactExport: opName,
    artifactPath: resolve(pageDir, "__generated__", `${opName}.graphql`),
  };
}

function collectOperationVariables(
  sf: ts.SourceFile,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const out = new Map<string, ReadonlyArray<string>>();
  ts.forEachChild(sf, function visit(node: ts.Node) {
    if (ts.isTaggedTemplateExpression(node) && isGraphqlTag(node.tag)) {
      const text = templateText(node.template);
      if (text !== null) {
        try {
          const doc = parseGraphQL(text);
          for (const def of doc.definitions) {
            if (def.kind === "OperationDefinition" && def.name) {
              const vars = (def.variableDefinitions ?? []).map(
                (v) => v.variable.name.value,
              );
              out.set(def.name.value, vars);
            }
          }
        } catch {
          /* relay-compiler raises its own error for malformed graphql */
        }
      }
    }
    ts.forEachChild(node, visit);
  });
  return out;
}

function isGraphqlTag(tag: ts.Expression): boolean {
  if (ts.isIdentifier(tag)) return tag.text === "graphql";
  if (ts.isPropertyAccessExpression(tag)) return tag.name.text === "graphql";
  return false;
}

function templateText(
  template: ts.TemplateLiteral,
): string | null {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
  let out = template.head.text;
  for (const span of template.templateSpans) out += span.literal.text;
  return out;
}
