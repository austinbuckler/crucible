import { test, expect, describe } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCodegen } from "./run.ts";

function makeApp(structure: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "crucible-codegen-"));
  for (const [path, content] of Object.entries(structure)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe("runCodegen — full pipeline", () => {
  test("emits routes manifest + entrypoint for a single page", () => {
    const root = makeApp({
      "src/app/page.tsx": `
        import * as Crucible from "crucible";
        import { graphql } from "react-relay";
        const _q = graphql\`query page_HomeQuery @preloadable { __typename }\`;
        export const Route = Crucible.Route("/", {});
        export default function Page() { return null }
      `,
      // relay-compiler artifact stub so the entrypoint import resolves
      "src/app/__generated__/page_HomeQuery.graphql.ts":
        "const node: any = {}; export default node; export type page_HomeQuery = { variables: {}; response: {} };",
    });

    const result = runCodegen({ appRoot: root });
    expect(result.routeCount).toBe(1);

    const routesFile = join(root, ".crucible", "routes.ts");
    const entrypointFile = join(
      root,
      ".crucible",
      "entrypoints",
      "index.ts",
    );
    expect(existsSync(routesFile)).toBe(true);
    expect(existsSync(entrypointFile)).toBe(true);

    const routes = readFileSync(routesFile, "utf8");
    expect(routes).toContain('path: "/"');
    expect(routes).toContain("entrypoint:");

    const ep = readFileSync(entrypointFile, "utf8");
    expect(ep).toContain("page_HomeQuery");
    expect(ep).toContain("getPreloadProps");

    rmSync(root, { recursive: true });
  });

  test("emits param mapping for dynamic routes when names match", () => {
    const root = makeApp({
      "src/app/clients/[id]/page.tsx": `
        import * as Crucible from "crucible";
        import { graphql } from "react-relay";
        import type { ClientQuery } from "./__generated__/ClientQuery.graphql";
        export const Route = Crucible.Route("/clients/[id]", {});
        export default function Page() {
          return usePreloadedQuery(graphql\`
            query ClientQuery($id: ID!) @preloadable { client(id: $id) { id } }
          \`, queries.client)
        }
      `,
      "src/app/clients/[id]/__generated__/ClientQuery.graphql.ts":
        "const node: any = {}; export default node; export type ClientQuery = { variables: { id: string }; response: {} };",
    });

    const result = runCodegen({ appRoot: root });
    expect(result.routeCount).toBe(1);

    const ep = readFileSync(
      join(root, ".crucible", "entrypoints", "clients.[id].ts"),
      "utf8",
    );
    // params destructured from getPreloadProps and `id` mapped to params.id
    expect(ep).toContain("({ params })");
    expect(ep).toContain("id: params.id");
    rmSync(root, { recursive: true });
  });

  test("emits _preload destructure when no variables consume params", () => {
    const root = makeApp({
      "src/app/page.tsx": `
        import * as Crucible from "crucible";
        import { graphql } from "react-relay";
        import type { page_HomeQuery } from "./__generated__/page_HomeQuery.graphql";
        const _q = graphql\`query page_HomeQuery @preloadable { __typename }\`;
        export const Route = Crucible.Route("/", {});
        export default function Page() { return null }
      `,
      "src/app/__generated__/page_HomeQuery.graphql.ts":
        "const node: any = {}; export default node; export type page_HomeQuery = { variables: {}; response: {} };",
    });

    runCodegen({ appRoot: root });
    const ep = readFileSync(
      join(root, ".crucible", "entrypoints", "index.ts"),
      "utf8",
    );
    expect(ep).toContain("(_preload)");
    rmSync(root, { recursive: true });
  });


  test("emits slot field on slot routes and slots[] on parent frame", () => {
    const root = makeApp({
      "src/app/layout.tsx": "export default function L({children}){return children}",
      "src/app/page.tsx": "export default function P(){return null}",
      "src/app/@modal/orders/[id]/page.tsx":
        "export default function P(){return null}",
    });

    runCodegen({ appRoot: root });
    const routesFile = readFileSync(
      join(root, ".crucible", "routes.ts"),
      "utf8",
    );
    expect(routesFile).toContain('slot: "modal"');
    expect(routesFile).toContain('slots: ["modal"]');
    rmSync(root, { recursive: true });
  });

  test("emits intercept field on intercepting routes", () => {
    const root = makeApp({
      "src/app/page.tsx": "export default function P(){return null}",
      "src/app/photos/[id]/page.tsx": "export default function P(){return null}",
      "src/app/@modal/(..)photos/[id]/page.tsx":
        "export default function P(){return null}",
    });

    runCodegen({ appRoot: root });
    const routes = readFileSync(
      join(root, ".crucible", "routes.ts"),
      "utf8",
    );
    expect(routes).toContain('intercept: ".."');
    rmSync(root, { recursive: true });
  });

  test("emits sub-entrypoint module + wires parent's Entrypoint field", () => {
    const root = makeApp({
      "src/app/dashboard/page.tsx": `
        import * as Crucible from "crucible";
        import { graphql } from "react-relay";
        import Sidebar from "./sidebar";
        import type { dashboard_PageQuery } from "./__generated__/dashboard_PageQuery.graphql";
        const _q = graphql\`query dashboard_PageQuery @preloadable { __typename }\`;
        export const Route = Crucible.Route("/dashboard", {
          Entrypoint: { Sidebar },
        });
        export default function Page() { return null }
      `,
      "src/app/dashboard/__generated__/dashboard_PageQuery.graphql.ts":
        "const node: any = {}; export default node; export type dashboard_PageQuery = { variables: {}; response: {} };",
      "src/app/dashboard/sidebar.tsx": `
        import { graphql } from "react-relay";
        import type { dashboard_StatsQuery } from "./__generated__/dashboard_StatsQuery.graphql";
        const _q = graphql\`query dashboard_StatsQuery @preloadable { __typename }\`;
        export default function Sidebar() { return null }
      `,
      "src/app/dashboard/__generated__/dashboard_StatsQuery.graphql.ts":
        "const node: any = {}; export default node; export type dashboard_StatsQuery = { variables: {}; response: {} };",
    });

    runCodegen({ appRoot: root });

    const parentEntryFile = join(
      root,
      ".crucible",
      "entrypoints",
      "dashboard.ts",
    );
    const subEntryFile = join(
      root,
      ".crucible",
      "entrypoints",
      "dashboard.Sidebar.ts",
    );

    expect(existsSync(parentEntryFile)).toBe(true);
    expect(existsSync(subEntryFile)).toBe(true);

    const parent = readFileSync(parentEntryFile, "utf8");
    expect(parent).toContain('import __ep_Sidebar from "./dashboard.Sidebar.ts"');
    expect(parent).toMatch(/entryPoints:\s*\{\s*Sidebar:\s*__ep_Sidebar/);

    const sub = readFileSync(subEntryFile, "utf8");
    // Sub-entrypoint uses SubEntryPoint type (not EntryPoint) and SubModule
    // shape (no params/search).
    expect(sub).toContain("SubEntryPoint<Queries>");
    expect(sub).toContain("dashboard_StatsQuery");
    expect(sub).not.toContain("search:");

    rmSync(root, { recursive: true });
  });

  test("seeds persisted-queries.json when missing", () => {
    const root = makeApp({
      "src/app/page.tsx": "export default function P(){return null}",
    });
    runCodegen({ appRoot: root });
    const persisted = join(root, "persisted-queries.json");
    expect(existsSync(persisted)).toBe(true);
    expect(readFileSync(persisted, "utf8").trim()).toBe("{}");
    rmSync(root, { recursive: true });
  });

  test("main.tsx emission omits crucible.config import when no config file is present (#46)", () => {
    const root = makeApp({
      "src/app/page.tsx": "export default function P(){return null}",
    });
    runCodegen({ appRoot: root });
    const main = readFileSync(join(root, ".crucible", "main.tsx"), "utf8");
    expect(main).not.toContain("crucible.config");
    expect(main).toContain('import * as Crucible from "react-crucible/crucible"');
    expect(main).toContain("Crucible.createEnvironment()");
    rmSync(root, { recursive: true });
  });

  test("main.tsx emission imports network from crucible.config.ts when present and threads it into createEnvironment (#46)", () => {
    const root = makeApp({
      "src/app/page.tsx": "export default function P(){return null}",
      "src/app/crucible.config.ts": `
        import type { CrucibleConfig } from "crucible";
        export const network: CrucibleConfig["network"] = { fetch: globalThis.fetch };
      `,
    });
    runCodegen({ appRoot: root });
    const main = readFileSync(join(root, ".crucible", "main.tsx"), "utf8");
    expect(main).toContain(
      'import { network as __cruxNetwork } from "../src/app/crucible.config.ts"',
    );
    expect(main).toContain(
      "Crucible.createEnvironment({ fetch: __cruxNetwork?.fetch, subscribe: __cruxNetwork?.subscribe })",
    );
    // network-only config does NOT thread swUpdate onto AppShell — the
    // emission should fall back to the bare `<Crucible.AppShell>` open
    // tag so the existing #29 default behavior holds.
    expect(main).toContain("<Crucible.AppShell>");
    expect(main).not.toContain("__cruxSwUpdate");
    rmSync(root, { recursive: true });
  });

  test("main.tsx emission imports localGraphQL from crucible.config.ts and turns it into Relay fetch", () => {
    const root = makeApp({
      "src/app/page.tsx": "export default function P(){return null}",
      "src/app/crucible.config.ts": `
        import type { CrucibleConfig } from "crucible";
        export const localGraphQL: CrucibleConfig["localGraphQL"] = {} as never;
      `,
    });
    runCodegen({ appRoot: root });
    const main = readFileSync(join(root, ".crucible", "main.tsx"), "utf8");
    expect(main).toContain(
      'import { localGraphQL as __cruxLocalGraphQL } from "../src/app/crucible.config.ts"',
    );
    expect(main).toContain(
      'import { createLocalGraphQLFetch, createLocalGraphQLSubscribe, prepareLocalGraphQL } from "react-crucible/runtime/local-graphql.ts"',
    );
    expect(main).toContain(
      "if (__cruxLocalGraphQL) await prepareLocalGraphQL(__cruxLocalGraphQL);",
    );
    expect(main).toContain(
      "Crucible.createEnvironment({ fetch: __cruxLocalGraphQL ? createLocalGraphQLFetch(__cruxLocalGraphQL) : undefined, subscribe: __cruxLocalGraphQL ? createLocalGraphQLSubscribe(__cruxLocalGraphQL) : undefined, persistStore: __cruxLocalGraphQL ? false : true })",
    );
    expect(main).not.toContain("__cruxNetwork");
    rmSync(root, { recursive: true });
  });

  test("main.tsx emission lets localGraphQL override network when both are exported", () => {
    const root = makeApp({
      "src/app/page.tsx": "export default function P(){return null}",
      "src/app/crucible.config.ts": `
        import type { CrucibleConfig } from "crucible";
        export const network: CrucibleConfig["network"] = { fetch: globalThis.fetch };
        export const localGraphQL: CrucibleConfig["localGraphQL"] = {} as never;
      `,
    });
    runCodegen({ appRoot: root });
    const main = readFileSync(join(root, ".crucible", "main.tsx"), "utf8");
    expect(main).toContain(
      'import { network as __cruxNetwork, localGraphQL as __cruxLocalGraphQL } from "../src/app/crucible.config.ts"',
    );
    expect(main).toContain(
      "if (__cruxLocalGraphQL) await prepareLocalGraphQL(__cruxLocalGraphQL);",
    );
    expect(main).toContain(
      "const __cruxFetch = __cruxLocalGraphQL ? createLocalGraphQLFetch(__cruxLocalGraphQL) : __cruxNetwork?.fetch;",
    );
    expect(main).toContain(
      "const __cruxSubscribe = __cruxLocalGraphQL ? createLocalGraphQLSubscribe(__cruxLocalGraphQL) : __cruxNetwork?.subscribe;",
    );
    expect(main).toContain(
      "const environment = Crucible.createEnvironment({ fetch: __cruxFetch, subscribe: __cruxSubscribe, persistStore: __cruxLocalGraphQL ? false : true });",
    );
    rmSync(root, { recursive: true });
  });

  test("main.tsx emission imports swUpdate from crucible.config.ts and threads it onto <AppShell> (#53)", () => {
    const root = makeApp({
      "src/app/page.tsx": "export default function P(){return null}",
      "src/app/crucible.config.ts": `
        import type { CrucibleConfig } from "crucible";
        export const swUpdate: CrucibleConfig["swUpdate"] = { idleThresholdMs: 60_000 };
      `,
    });
    runCodegen({ appRoot: root });
    const main = readFileSync(join(root, ".crucible", "main.tsx"), "utf8");
    expect(main).toContain(
      'import { swUpdate as __cruxSwUpdate } from "../src/app/crucible.config.ts"',
    );
    expect(main).toContain(
      "<Crucible.AppShell swUpdate={__cruxSwUpdate}>",
    );
    // swUpdate-only config does NOT change the env-construction path —
    // it falls back to the legacy positional `createEnvironment()` call,
    // matching the #46 fallback when no `network` export is present.
    expect(main).toContain("Crucible.createEnvironment()");
    expect(main).not.toContain("__cruxNetwork");
    rmSync(root, { recursive: true });
  });

  test("main.tsx emission threads BOTH network and swUpdate when both are exported (#53)", () => {
    const root = makeApp({
      "src/app/page.tsx": "export default function P(){return null}",
      "src/app/crucible.config.ts": `
        import type { CrucibleConfig } from "crucible";
        export const network: CrucibleConfig["network"] = { fetch: globalThis.fetch };
        export const swUpdate: CrucibleConfig["swUpdate"] = { idleThresholdMs: 60_000 };
      `,
    });
    runCodegen({ appRoot: root });
    const main = readFileSync(join(root, ".crucible", "main.tsx"), "utf8");
    // Single import line names both bindings — keeps the emitted file
    // tidy regardless of how many fields the user opts into.
    expect(main).toContain(
      'import { network as __cruxNetwork, swUpdate as __cruxSwUpdate } from "../src/app/crucible.config.ts"',
    );
    expect(main).toContain(
      "Crucible.createEnvironment({ fetch: __cruxNetwork?.fetch, subscribe: __cruxNetwork?.subscribe })",
    );
    expect(main).toContain(
      "<Crucible.AppShell swUpdate={__cruxSwUpdate}>",
    );
    rmSync(root, { recursive: true });
  });

  test("main.tsx emission falls back to bare AppShell when config file exists but exports no recognized fields (#53)", () => {
    // Defensive: the user wrote a config file but only put helpers /
    // unrecognized exports in it. Codegen detects no relevant exports
    // and falls back to the zero-config emission. This is what keeps
    // empty-config-files cheap rather than failing loudly.
    const root = makeApp({
      "src/app/page.tsx": "export default function P(){return null}",
      "src/app/crucible.config.ts": `
        // Helpers a user might keep here without exporting anything.
        const localHelper = () => null;
        export {};
      `,
    });
    runCodegen({ appRoot: root });
    const main = readFileSync(join(root, ".crucible", "main.tsx"), "utf8");
    expect(main).not.toContain("crucible.config");
    expect(main).toContain("Crucible.createEnvironment()");
    expect(main).toContain("<Crucible.AppShell>");
    rmSync(root, { recursive: true });
  });

  test("main.tsx config export detection ignores comments, strings, and aliases away", () => {
    const root = makeApp({
      "src/app/page.tsx": "export default function P(){return null}",
      "src/app/crucible.config.ts": `
        // export const network = { fetch: globalThis.fetch };
        const text = "export const localGraphQL = {}";
        const pattern = /export const swUpdate/;
        function matcher() { return /export const localGraphQL/; }
        const network = { fetch: globalThis.fetch };
        export { network as notNetwork };
      `,
    });
    runCodegen({ appRoot: root });
    const main = readFileSync(join(root, ".crucible", "main.tsx"), "utf8");
    expect(main).not.toContain("crucible.config");
    expect(main).toContain("Crucible.createEnvironment()");
    rmSync(root, { recursive: true });
  });

  test("main.tsx config export detection accepts aliases into known names", () => {
    const root = makeApp({
      "src/app/page.tsx": "export default function P(){return null}",
      "src/app/crucible.config.ts": `
        import type { CrucibleConfig } from "crucible";
        const local = {} as CrucibleConfig["localGraphQL"];
        export { local as localGraphQL };
      `,
    });
    runCodegen({ appRoot: root });
    const main = readFileSync(join(root, ".crucible", "main.tsx"), "utf8");
    expect(main).toContain(
      'import { localGraphQL as __cruxLocalGraphQL } from "../src/app/crucible.config.ts"',
    );
    rmSync(root, { recursive: true });
  });

  test("main.tsx config export detection accepts multi-declarator exports", () => {
    const root = makeApp({
      "src/app/page.tsx": "export default function P(){return null}",
      "src/app/crucible.config.ts": `
        import type { CrucibleConfig } from "crucible";
        export const network: CrucibleConfig["network"] = { fetch: () => { return fetch("/api/graphql"); } },
          localGraphQL: CrucibleConfig["localGraphQL"] = {} as never;
      `,
    });
    runCodegen({ appRoot: root });
    const main = readFileSync(join(root, ".crucible", "main.tsx"), "utf8");
    expect(main).toContain("network as __cruxNetwork, localGraphQL as __cruxLocalGraphQL");
    rmSync(root, { recursive: true });
  });

  test("main.tsx config export detection ignores initializer object properties", () => {
    const root = makeApp({
      "src/app/page.tsx": "export default function P(){return null}",
      "src/app/crucible.config.ts": `
        export const network = { fetch: globalThis.fetch, localGraphQL: false };
        const helper = 1, localGraphQL = false;
      `,
    });
    runCodegen({ appRoot: root });
    const main = readFileSync(join(root, ".crucible", "main.tsx"), "utf8");
    expect(main).toContain('import { network as __cruxNetwork }');
    expect(main).not.toContain("__cruxLocalGraphQL");
    rmSync(root, { recursive: true });
  });

  test("main.tsx config export detection handles semicolonless exports", () => {
    const root = makeApp({
      "src/app/page.tsx": "export default function P(){return null}",
      "src/app/crucible.config.ts": `
        export const network = {}
        export const localGraphQL = {} as never
      `,
    });
    runCodegen({ appRoot: root });
    const main = readFileSync(join(root, ".crucible", "main.tsx"), "utf8");
    expect(main).toContain("network as __cruxNetwork, localGraphQL as __cruxLocalGraphQL");
    rmSync(root, { recursive: true });
  });
});
