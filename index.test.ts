import { describe, expect, test } from "bun:test";
import {
  isAppPageModule,
  isRelayGeneratedArtifact,
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
});
