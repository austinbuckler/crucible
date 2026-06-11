import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePage } from "./parse.ts";

// Helper: write a page.tsx fixture into a fresh tmp dir, optionally
// alongside a `__generated__/` subdirectory holding the relay-compiler
// artifacts the page references. parsePage walks imports, so the
// imported paths must resolve to real files (or at least look like
// they could).
function writePage(
  content: string,
  artifacts: Array<{ name: string; body?: string }> = [],
): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "crucible-parse-"));
  const file = join(dir, "page.tsx");
  writeFileSync(file, content);
  if (artifacts.length > 0) {
    mkdirSync(join(dir, "__generated__"), { recursive: true });
    for (const art of artifacts) {
      writeFileSync(
        join(dir, "__generated__", `${art.name}.graphql.ts`),
        art.body ?? `export type ${art.name} = { variables: object; response: object };\n`,
      );
    }
  }
  return { file, dir };
}

describe("parsePage — Route call detection", () => {
  test("returns empty queries + entrypoints when no Route export is present", () => {
    const { file, dir } = writePage(
      `export default function Page() { return null }`,
    );
    const r = parsePage(file);
    expect(r.queries).toHaveLength(0);
    expect(r.entryPoints).toHaveLength(0);
    expect(r.hasSearchParams).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("throws when Route is exported but not initialized with a call expression", () => {
    const { file, dir } = writePage(
      `export const Route = "/clients/[id]";`,
    );
    expect(() => parsePage(file)).toThrow(/Crucible\.Route/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("throws when Route's call expression isn't Crucible.Route(...)", () => {
    const { file, dir } = writePage(
      `export const Route = something("/clients/[id]", {});`,
    );
    expect(() => parsePage(file)).toThrow(/Crucible\.Route/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("throws when Crucible.Route is called with fewer than 2 args", () => {
    const { file, dir } = writePage(
      `import * as Crucible from "crucible";
       export const Route = Crucible.Route("/x");`,
    );
    expect(() => parsePage(file)).toThrow(/pattern, config/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("throws when the config arg isn't an object literal", () => {
    const { file, dir } = writePage(
      `import * as Crucible from "crucible";
       const cfg = {};
       export const Route = Crucible.Route("/x", cfg);`,
    );
    expect(() => parsePage(file)).toThrow(/object literal/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("accepts namespace import form `Crucible.Route(...)`", () => {
    // Canonical call shape — `import * as Crucible` then
    // `Crucible.Route(...)`. The check is structural (property access
    // whose name is `Route`), not name-bound to the literal identifier
    // `Crucible`, so renamed namespace imports work too.
    const { file, dir } = writePage(
      `import * as Crucible from "crucible";
       export const Route = Crucible.Route("/x", {});`,
    );
    const r = parsePage(file);
    expect(r.hasSearchParams).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("parsePage — primary query (@preloadable)", () => {
  test("identifies the page query by its @preloadable directive", () => {
    const { file, dir } = writePage(
      `import * as Crucible from "crucible";
       import { graphql } from "react-relay";
       import type { page_HomeQuery } from "./__generated__/page_HomeQuery.graphql";
       export const Route = Crucible.Route("/", {});
       const _q = graphql\`query page_HomeQuery @preloadable { __typename }\`;
       export default function Page() { return null }`,
      [{ name: "page_HomeQuery" }],
    );
    const r = parsePage(file);
    expect(r.queries).toHaveLength(1);
    expect(r.queries[0]!.fieldName).toBe("data");
    expect(r.queries[0]!.artifactExport).toBe("page_HomeQuery");
    expect(r.queries[0]!.artifactPath).toContain("page_HomeQuery.graphql");
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns no queries when the page has no @preloadable operation", () => {
    // Pages that don't fetch data are valid — e.g. static error pages.
    const { file, dir } = writePage(
      `import * as Crucible from "crucible";
       export const Route = Crucible.Route("/", {});
       export default function Page() { return null }`,
    );
    const r = parsePage(file);
    expect(r.queries).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("throws when the page has more than one @preloadable operation", () => {
    // The "page has one primary query" rule is intentional — multi-
    // query pages should split the second query into an entrypoint.
    const { file, dir } = writePage(
      `import * as Crucible from "crucible";
       import { graphql } from "react-relay";
       export const Route = Crucible.Route("/", {});
       const _a = graphql\`query A @preloadable { __typename }\`;
       const _b = graphql\`query B @preloadable { __typename }\`;
       export default function Page() { return null }`,
      [{ name: "A" }, { name: "B" }],
    );
    expect(() => parsePage(file)).toThrow(/more than one .*@preloadable/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("falls back to colocated artifact path when no explicit import exists", () => {
    // The omakase shape doesn't require a dummy type-only import for
    // the generated query. parsePage falls back to relay-compiler's
    // colocated default: `<pageDir>/__generated__/<OpName>.graphql`.
    const { file, dir } = writePage(
      `import * as Crucible from "crucible";
       import { graphql } from "react-relay";
       export const Route = Crucible.Route("/", {});
       const _q = graphql\`query page_HomeQuery @preloadable { __typename }\`;
       export default function Page() { return null }`,
      // no artifact import in the page — codegen synthesizes the path
    );
    const r = parsePage(file);
    expect(r.queries).toHaveLength(1);
    expect(r.queries[0]!.artifactExport).toBe("page_HomeQuery");
    expect(r.queries[0]!.artifactPath).toMatch(
      /__generated__\/page_HomeQuery\.graphql$/,
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("parsePage — search detection", () => {
  test("hasSearchParams is true when Route config has a `search` property", () => {
    const { file, dir } = writePage(
      `import * as Crucible from "crucible";
       export const Route = Crucible.Route("/", {
         search: { tab: ["a", "b"] as const },
       });
       export default function Page() { return null }`,
    );
    const r = parsePage(file);
    expect(r.hasSearchParams).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("hasSearchParams is false when Route config has no `search`", () => {
    const { file, dir } = writePage(
      `import * as Crucible from "crucible";
       export const Route = Crucible.Route("/", { title: "Home" });
       export default function Page() { return null }`,
    );
    const r = parsePage(file);
    expect(r.hasSearchParams).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("parsePage — Entrypoint resolution", () => {
  test("extracts entrypoints declared via shorthand { Sidebar }", () => {
    const { file, dir } = writePage(
      `import * as Crucible from "crucible";
       import Sidebar from "./sidebar.tsx";
       export const Route = Crucible.Route("/", {
         Entrypoint: { Sidebar },
       });
       export default function Page() { return null }`,
    );
    writeFileSync(join(dir, "sidebar.tsx"), `export default function S() { return null }\n`);
    const r = parsePage(file);
    expect(r.entryPoints).toHaveLength(1);
    expect(r.entryPoints[0]!.fieldName).toBe("Sidebar");
    expect(r.entryPoints[0]!.modulePath).toContain("sidebar");
    rmSync(dir, { recursive: true, force: true });
  });

  test("extracts entrypoints with key:value form { MyAlias: Sidebar }", () => {
    const { file, dir } = writePage(
      `import * as Crucible from "crucible";
       import Sidebar from "./sidebar.tsx";
       export const Route = Crucible.Route("/", {
         Entrypoint: { Aside: Sidebar },
       });
       export default function Page() { return null }`,
    );
    writeFileSync(join(dir, "sidebar.tsx"), `export default function S() { return null }\n`);
    const r = parsePage(file);
    expect(r.entryPoints).toHaveLength(1);
    expect(r.entryPoints[0]!.fieldName).toBe("Aside");
    rmSync(dir, { recursive: true, force: true });
  });

  test("extracts multiple entrypoints", () => {
    const { file, dir } = writePage(
      `import * as Crucible from "crucible";
       import Sidebar from "./sidebar.tsx";
       import Feed from "./feed.tsx";
       export const Route = Crucible.Route("/", {
         Entrypoint: { Sidebar, Feed },
       });
       export default function Page() { return null }`,
    );
    writeFileSync(join(dir, "sidebar.tsx"), `export default function S() { return null }\n`);
    writeFileSync(join(dir, "feed.tsx"), `export default function F() { return null }\n`);
    const r = parsePage(file);
    expect(r.entryPoints).toHaveLength(2);
    expect(r.entryPoints.map((e) => e.fieldName).sort()).toEqual(["Feed", "Sidebar"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("throws when Entrypoint references an unimported identifier", () => {
    const { file, dir } = writePage(
      `import * as Crucible from "crucible";
       export const Route = Crucible.Route("/", {
         Entrypoint: { Sidebar },
       });
       export default function Page() { return null }`,
    );
    expect(() => parsePage(file)).toThrow(/Sidebar/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("throws when Entrypoint isn't an object literal", () => {
    const { file, dir } = writePage(
      `import * as Crucible from "crucible";
       const stuff = {};
       export const Route = Crucible.Route("/", {
         Entrypoint: stuff,
       });
       export default function Page() { return null }`,
    );
    expect(() => parsePage(file)).toThrow(/object literal/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("parsePage — operation variables extraction", () => {
  test("extracts variable names from inline graphql operations", () => {
    const { file, dir } = writePage(
      `import * as Crucible from "crucible";
       import { graphql } from "react-relay";
       export const Route = Crucible.Route("/", {});
       const _q = graphql\`query Foo($id: ID!, $tab: String) { __typename }\`;
       export default function Page() { return null }`,
    );
    const r = parsePage(file);
    expect(Array.from(r.operationVariables.keys())).toContain("Foo");
    expect(r.operationVariables.get("Foo")).toEqual(["id", "tab"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns an empty map when the page has no graphql tags", () => {
    const { file, dir } = writePage(
      `import * as Crucible from "crucible";
       export const Route = Crucible.Route("/", {});
       export default function Page() { return null }`,
    );
    const r = parsePage(file);
    expect(r.operationVariables.size).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
