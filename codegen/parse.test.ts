import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePage } from "./parse.ts";

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

describe("parsePage — direct exports", () => {
  test("returns empty query/entrypoint data for a static page", () => {
    const { file, dir } = writePage(
      `export default function Page() { return null }`,
    );
    const r = parsePage(file);
    expect(r.queries).toHaveLength(0);
    expect(r.hasSearchParams).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("identifies a page query from `export const query`", () => {
    const { file, dir } = writePage(
      `import { graphql } from "react-relay";
       export const query = graphql\`query page_HomeQuery @preloadable { __typename }\`;
       export default function Page() { return null }`,
      [{ name: "page_HomeQuery" }],
    );
    const r = parsePage(file);
    expect(r.queries).toHaveLength(1);
    expect(r.queries[0]!.fieldName).toBe("data");
    expect(r.queries[0]!.artifactExport).toBe("page_HomeQuery");
    expect(r.queries[0]!.artifactPath).toMatch(
      /__generated__\/page_HomeQuery\.graphql$/,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("requires exported page queries to be graphql tags", () => {
    const { file, dir } = writePage(
      `export const query = "not graphql";
       export default function Page() { return null }`,
    );
    expect(() => parsePage(file)).toThrow(/graphql/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("requires exported page queries to be preloadable", () => {
    const { file, dir } = writePage(
      `import { graphql } from "react-relay";
       export const query = graphql\`query page_HomeQuery { __typename }\`;
       export default function Page() { return null }`,
    );
    expect(() => parsePage(file)).toThrow(/@preloadable/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("ignores non-exported preloadable graphql tags", () => {
    const { file, dir } = writePage(
      `import { graphql } from "react-relay";
       const query = graphql\`query page_HomeQuery @preloadable { __typename }\`;
       export default function Page() { return null }`,
      [{ name: "page_HomeQuery" }],
    );
    const r = parsePage(file);
    expect(r.queries).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("parsePage — search detection", () => {
  test("hasSearchParams is true when the page exports `searchParams`", () => {
    const { file, dir } = writePage(
      `export const searchParams = { tab: ["a", "b"] as const };
       export default function Page() { return null }`,
    );
    const r = parsePage(file);
    expect(r.hasSearchParams).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("hasSearchParams is false without `searchParams`", () => {
    const { file, dir } = writePage(
      `export const metadata = { title: "Home" };
       export default function Page() { return null }`,
    );
    const r = parsePage(file);
    expect(r.hasSearchParams).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("parsePage — entryPoints rejection", () => {
  test("rejects entryPoints because parallel routes are the composition primitive", () => {
    const { file, dir } = writePage(
      `import Sidebar from "./sidebar.tsx";
       export const entryPoints = { Sidebar };
       export default function Page() { return null }`,
    );
    writeFileSync(join(dir, "sidebar.tsx"), `export default function S() { return null }\n`);
    expect(() => parsePage(file)).toThrow(/parallel route slots/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("parsePage — operation variables extraction", () => {
  test("extracts variable names from inline graphql operations", () => {
    const { file, dir } = writePage(
      `import { graphql } from "react-relay";
       export const query = graphql\`query Foo($id: ID!, $tab: String) @preloadable { __typename }\`;
       export default function Page() { return null }`,
    );
    const r = parsePage(file);
    expect(Array.from(r.operationVariables.keys())).toContain("Foo");
    expect(r.operationVariables.get("Foo")).toEqual(["id", "tab"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns an empty map when the page has no graphql tags", () => {
    const { file, dir } = writePage(
      `export default function Page() { return null }`,
    );
    const r = parsePage(file);
    expect(r.operationVariables.size).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
