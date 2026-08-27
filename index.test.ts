import { describe, expect, test } from "bun:test";
import {
  crucible,
  isAppPageModule,
  isRelayGeneratedArtifact,
  stripPageQueryExport,
  stripRelayResolverTypeAssertions,
} from "./index.ts";

describe("crucible Vite transforms", () => {
  test("detects app page modules", () => {
    const appRoot = "/repo/app";
    expect(isAppPageModule("/repo/app/src/app/page.tsx", appRoot)).toBe(true);
    expect(isAppPageModule("/repo/app/src/app/orders/default.tsx", appRoot)).toBe(true);
    expect(isAppPageModule("/repo/app/src/app/layout.tsx", appRoot)).toBe(false);
  });

  test("detects Relay generated artifacts", () => {
    expect(
      isRelayGeneratedArtifact("/repo/app/src/app/__generated__/page_Query.graphql.ts"),
    ).toBe(true);
    expect(
      isRelayGeneratedArtifact("/repo/app/src/app/__generated__/page_Query$parameters.ts"),
    ).toBe(false);
  });

  test("strips Relay resolver type assertions that become runtime ReferenceErrors", () => {
    const input = `import type { foo as fooResolverType } from "./resolvers";
// Type assertion validating that \`fooResolverType\` resolver is correctly implemented.
(fooResolverType satisfies (
  __relay_model_instance: Model$data['__relay_model_instance'],
) => LiveState<boolean | null | undefined>);
(queryAppResolverType satisfies () => CrucibleApp | null | undefined);
import {foo as fooResolver} from "./resolvers";
const node = { resolverModule: fooResolver };
`;

    const output = stripRelayResolverTypeAssertions(input);

    expect(output).toContain("import type { foo as fooResolverType }");
    expect(output).not.toContain("fooResolverType satisfies");
    expect(output).not.toContain("queryAppResolverType satisfies");
    expect(output).toContain("resolverModule: fooResolver");
  });

  test("strips standalone page query exports without swallowing sibling exports", () => {
    const standalone = stripPageQueryExport(
      "export const query = graphql`query Home { __typename }`;\nexport const metadata = {};",
    );
    expect(standalone).toContain("const query = graphql");
    expect(standalone).toContain("export const metadata");

    const multi = stripPageQueryExport(
      "export const query = graphql`query Home { __typename }`, metadata = {};",
    );
    expect(multi).toContain("export const query");
    expect(multi).toContain("metadata");

    const semicolonless = stripPageQueryExport(
      "export const query = Relay.graphql`query Home { __typename }`\nexport default function Page() { return null }",
    );
    expect(semicolonless).toContain("const query = Relay.graphql");
    expect(semicolonless).toContain("export default function Page");

    const relayBabelOutput = stripPageQueryExport(
      'export const query = (_page.hash && console.error("Run `relay-compiler`;"), _page);\nconst mutation = (_mutation);',
    );
    expect(relayBabelOutput).toContain("const query = (_page.hash");
    expect(relayBabelOutput).not.toContain("export const query");

    const typed = stripPageQueryExport(
      "export const query: Foo<Bar, Baz> = graphql`query Home { __typename }`;\nexport default function Page() {}",
    );
    expect(typed).toContain("const query: Foo<Bar, Baz>");
    expect(typed).not.toContain("export const query");

    const quoted = stripPageQueryExport(
      'const snippet = "export const query = 1;";\n// export const query = 2;\nexport default function Page() { return snippet }',
    );
    expect(quoted).toContain('"export const query = 1;"');
    expect(quoted).toContain("// export const query = 2;");
  });

  test("emits React ViewTransition experimental flag", () => {
    const plugin = crucible({
      experimental: { reactViewTransitions: true },
    });
    const config = typeof plugin.config === "function"
      ? plugin.config.call(
        {} as never,
        {} as never,
        { command: "build", mode: "test" },
      )
      : null;

    expect(config).toMatchObject({
      define: {
        "import.meta.env.CRUCIBLE_REACT_VIEW_TRANSITIONS": "true",
      },
    });
  });
});
