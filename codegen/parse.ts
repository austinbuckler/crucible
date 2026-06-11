import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseGraphQL } from "graphql";
import ts from "typescript";

// Page parser for the omakase route contract:
//
//   export const Route = Crucible.Route("/clients/[id]", {
//     search: { tab: ["orders","docs"] as const },
//     title: ({ data }) => data.client?.name ?? "Client",
//     Entrypoint: { Sidebar, Feed },
//   });
//
//   export default Route.page(({ data, params, search }) => { ... });
//
// The page's *primary query* — the one whose `PreloadedQuery` is passed
// as `data` — is discovered by scanning the file for a `graphql\`...\``
// template literal whose operation has the `@preloadable` directive.
// Codegen requires exactly one preloadable operation per page; that's
// the page query.
//
// Sub-entrypoints declared via `Entrypoint: { Foo, Bar }` are resolved
// by reading the import that each identifier (`Foo`, `Bar`) points to.
// Each must default-export `Crucible.Entrypoint(...)`.

export type QueryField = {
  // Property key on the page's preloaded data — fixed to `data` for
  // the page's primary query. Sub-entrypoints get their own queries
  // by detecting `@preloadable` operations inside their own files.
  fieldName: string;
  // Original exported name from the relay-compiler artifact (e.g.
  // `page_HomeQuery`). The name we `import` to get the parameters.
  artifactExport: string;
  // Resolved absolute path to the `.graphql` (without `.ts`) artifact
  // stem — relay-compiler emits TS artifacts as `<stem>.ts`.
  artifactPath: string;
};

export type EntryPointField = {
  // Property key on the page's `Entrypoint: { ... }` map — capitalized
  // (e.g. `Sidebar`) so JSX consumes it naturally:
  //   <Route.Entrypoint.Sidebar client={client} />
  fieldName: string;
  // Resolved absolute path to the sub-entrypoint module (no extension).
  modulePath: string;
};

export type ParsedPage = {
  pageFile: string;
  queries: ReadonlyArray<QueryField>;
  // Operation name → ordered list of variable names. Source: the
  // `graphql\`query Foo($id: ID!) {...}\`` template in the page.
  operationVariables: ReadonlyMap<string, ReadonlyArray<string>>;
  // True when the Route's config object has a `search` property.
  // Codegen uses this to widen the page's `search` prop from
  // `URLSearchParams` to the inferred shape.
  hasSearchParams: boolean;
  // Sub-entrypoints declared via `Entrypoint: { Foo, Bar }`.
  entryPoints: ReadonlyArray<EntryPointField>;
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

  // Locate `export const Route = Crucible.Route(pattern, config)`.
  const routeCall = findRouteCall(sf, pageFile);

  // Page's primary query: the operation marked `@preloadable` in any
  // graphql tag in this file. Exactly one expected.
  const preloadable = findPreloadableOperation(source, pageFile);
  const queries: QueryField[] = preloadable
    ? [resolvePreloadableQuery(preloadable, importMap, pageDir, pageFile)]
    : [];

  // Read the Route config object: search? title? Entrypoint?
  const configProps = readRouteConfig(routeCall, pageFile);

  return {
    pageFile,
    queries,
    operationVariables,
    hasSearchParams: configProps.hasSearch,
    entryPoints: resolveEntrypoints(
      configProps.entrypointEntries,
      importMap,
      pageDir,
      pageFile,
    ),
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

// `export const Route = Crucible.Route(pattern, config)` — find that
// CallExpression. Returns null if absent (a non-page file or a page
// missing the new contract).
function findRouteCall(
  sf: ts.SourceFile,
  pageFile: string,
): ts.CallExpression | null {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const isExported = stmt.modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!isExported) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      if (decl.name.text !== "Route") continue;
      if (!decl.initializer || !ts.isCallExpression(decl.initializer)) {
        throw new Error(
          `[crucible] \`export const Route\` in ${pageFile} must be initialized with \`Crucible.Route(pattern, config)\`.`,
        );
      }
      const expr = decl.initializer.expression;
      const isCrucibleRoute =
        (ts.isPropertyAccessExpression(expr) &&
          expr.name.text === "Route" &&
          ts.isIdentifier(expr.expression)) ||
        (ts.isIdentifier(expr) && expr.text === "Route");
      if (!isCrucibleRoute) {
        throw new Error(
          `[crucible] \`export const Route\` in ${pageFile} must call \`Crucible.Route(...)\` (or aliased \`Route(...)\`).`,
        );
      }
      return decl.initializer;
    }
  }
  return null;
}

// Read the second argument of `Crucible.Route(pattern, config)` — the
// config object literal — and pull out the bits codegen cares about.
function readRouteConfig(
  call: ts.CallExpression | null,
  pageFile: string,
): {
  hasSearch: boolean;
  entrypointEntries: Array<{ fieldName: string; localName: string }>;
} {
  if (!call) {
    return { hasSearch: false, entrypointEntries: [] };
  }
  if (call.arguments.length < 2) {
    throw new Error(
      `[crucible] \`Crucible.Route(...)\` in ${pageFile} requires (pattern, config).`,
    );
  }
  const config = call.arguments[1]!;
  if (!ts.isObjectLiteralExpression(config)) {
    throw new Error(
      `[crucible] \`Crucible.Route(...)\` second argument in ${pageFile} must be an object literal — codegen reads it at build time.`,
    );
  }

  let hasSearch = false;
  const entrypointEntries: Array<{ fieldName: string; localName: string }> =
    [];

  for (const prop of config.properties) {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) {
      continue;
    }
    const key = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null;
    if (!key) continue;

    if (key === "search") {
      hasSearch = true;
      continue;
    }
    if (key === "Entrypoint") {
      // Must be an object literal whose values are identifiers
      // referring to imported components.
      if (!ts.isPropertyAssignment(prop) || !ts.isObjectLiteralExpression(prop.initializer)) {
        throw new Error(
          `[crucible] \`Entrypoint\` in ${pageFile}'s Route config must be an object literal of imported components, e.g. { Sidebar, Feed }.`,
        );
      }
      for (const epProp of prop.initializer.properties) {
        if (ts.isShorthandPropertyAssignment(epProp)) {
          // `Entrypoint: { Sidebar }` — shorthand for { Sidebar: Sidebar }
          entrypointEntries.push({
            fieldName: epProp.name.text,
            localName: epProp.name.text,
          });
        } else if (ts.isPropertyAssignment(epProp)) {
          if (!epProp.name || !ts.isIdentifier(epProp.name)) continue;
          if (!ts.isIdentifier(epProp.initializer)) {
            throw new Error(
              `[crucible] \`Entrypoint.${epProp.name.text}\` in ${pageFile} must reference an imported component identifier.`,
            );
          }
          entrypointEntries.push({
            fieldName: epProp.name.text,
            localName: epProp.initializer.text,
          });
        }
      }
    }
    // `title`, `meta`, `preload` are runtime concerns — codegen
    // doesn't extract them. They flow through the page module's
    // own evaluation at runtime.
  }

  return { hasSearch, entrypointEntries };
}

function resolveEntrypoints(
  entries: ReadonlyArray<{ fieldName: string; localName: string }>,
  importMap: Map<string, { exported: string; moduleSpecifier: string }>,
  pageDir: string,
  pageFile: string,
): ReadonlyArray<EntryPointField> {
  return entries.map(({ fieldName, localName }) => {
    const imp = importMap.get(localName);
    if (!imp) {
      throw new Error(
        `[crucible] Entrypoint.${fieldName} in ${pageFile} references \`${localName}\` but no matching import was found.`,
      );
    }
    return {
      fieldName,
      modulePath: resolve(pageDir, imp.moduleSpecifier),
    };
  });
}

// Find the operation whose graphql tag has `@preloadable`. There must
// be at most one — the page's primary query.
function findPreloadableOperation(
  source: string,
  pageFile: string,
): { operationName: string; sourceTagText: string } | null {
  // Cheap text scan first: only parse files that contain `@preloadable`.
  if (!source.includes("@preloadable")) return null;

  const sf = ts.createSourceFile(
    pageFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  let result: { operationName: string; sourceTagText: string } | null = null;
  ts.forEachChild(sf, function visit(node: ts.Node) {
    if (ts.isTaggedTemplateExpression(node) && isGraphqlTag(node.tag)) {
      const text = templateText(node.template);
      if (text && text.includes("@preloadable")) {
        let doc: ReturnType<typeof parseGraphQL> | null = null;
        try {
          doc = parseGraphQL(text);
        } catch {
          /* relay-compiler will raise its own error for malformed graphql */
        }
        if (doc) {
          for (const def of doc.definitions) {
            if (def.kind !== "OperationDefinition") continue;
            const hasPreloadable = (def.directives ?? []).some(
              (d) => d.name.value === "preloadable",
            );
            if (!hasPreloadable) continue;
            if (!def.name) continue;
            if (result) {
              throw new Error(
                `[crucible] ${pageFile} has more than one \`@preloadable\` operation. A page must have exactly one primary query; declare additional data via \`Entrypoint: { ... }\`.`,
              );
            }
            result = { operationName: def.name.value, sourceTagText: text };
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  });
  return result;
}

// Resolve the `@preloadable` operation's name to the relay-compiler
// artifact path. Two strategies, in order:
//
//   1. Look for an explicit `import { <OpName> } from "<path>/<OpName>.graphql"`
//      in the page. Wins when the user happens to type-import the
//      generated artifact (e.g. for a custom artifactDirectory).
//   2. Fall back to relay-compiler's colocated default:
//      `<pageDir>/__generated__/<OpName>.graphql.ts`. With the omakase
//      shape, the page query's name is already the only durable
//      pointer the user writes — they shouldn't have to author a
//      dummy type-only import just to satisfy codegen.
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
