import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanRoutes } from "./scan.ts";

function makeFixture(structure: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "crucible-scan-"));
  for (const [path, content] of Object.entries(structure)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const STUB_PAGE = "export default function Page() { return null }";
const STUB_LAYOUT =
  "export default function Layout({children}) { return children }";

describe("scanRoutes basic discovery", () => {
  test("finds a single root page", () => {
    const root = makeFixture({ "page.tsx": STUB_PAGE });
    const routes = scanRoutes(root);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.urlPath).toBe("/");
    expect(routes[0]!.id).toBe("index");
    expect(routes[0]!.segments).toEqual([]);
    rmSync(root, { recursive: true });
  });

  test("finds nested static routes", () => {
    const root = makeFixture({
      "page.tsx": STUB_PAGE,
      "clients/page.tsx": STUB_PAGE,
      "settings/account/page.tsx": STUB_PAGE,
    });
    const routes = scanRoutes(root);
    const paths = routes.map((r) => r.urlPath).sort();
    expect(paths).toEqual(["/", "/clients", "/settings/account"]);
    rmSync(root, { recursive: true });
  });

  test("uses [id] notation for dynamic segments", () => {
    const root = makeFixture({
      "clients/[id]/page.tsx": STUB_PAGE,
    });
    const routes = scanRoutes(root);
    expect(routes[0]!.urlPath).toBe("/clients/[id]");
    expect(routes[0]!.segments).toEqual([
      { kind: "literal", value: "clients" },
      { kind: "param", name: "id" },
    ]);
    rmSync(root, { recursive: true });
  });

  test("uses [...slug] notation for catchall", () => {
    const root = makeFixture({
      "blog/[...slug]/page.tsx": STUB_PAGE,
    });
    const routes = scanRoutes(root);
    expect(routes[0]!.urlPath).toBe("/blog/[...slug]");
    expect(routes[0]!.segments).toEqual([
      { kind: "literal", value: "blog" },
      { kind: "catchall", name: "slug" },
    ]);
    rmSync(root, { recursive: true });
  });

  test("(group) directories are path-transparent", () => {
    const root = makeFixture({
      "(marketing)/about/page.tsx": STUB_PAGE,
    });
    const routes = scanRoutes(root);
    expect(routes[0]!.urlPath).toBe("/about");
    rmSync(root, { recursive: true });
  });

  test("throws when path-transparent groups create duplicate route ids", () => {
    const root = makeFixture({
      "(marketing)/about/page.tsx": STUB_PAGE,
      "(app)/about/page.tsx": STUB_PAGE,
    });
    expect(() => scanRoutes(root)).toThrow(/Duplicate route id "about"/);
    rmSync(root, { recursive: true });
  });

  test("_private directories are skipped", () => {
    const root = makeFixture({
      "page.tsx": STUB_PAGE,
      "_components/widget.tsx": STUB_PAGE,
      "_workers/csv.ts": "export async function exportCsv() {}",
    });
    const routes = scanRoutes(root);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.urlPath).toBe("/");
    rmSync(root, { recursive: true });
  });
});

describe("scanRoutes layouts and frames", () => {
  test("collects layouts on the path", () => {
    const root = makeFixture({
      "layout.tsx": STUB_LAYOUT,
      "clients/layout.tsx": STUB_LAYOUT,
      "clients/[id]/page.tsx": STUB_PAGE,
    });
    const routes = scanRoutes(root);
    expect(routes).toHaveLength(1);
    const frames = routes[0]!.frames;
    expect(frames).toHaveLength(2);
    expect(frames[0]!.layout).toContain("layout.tsx");
    expect(frames[1]!.layout).toContain("clients/layout.tsx");
    rmSync(root, { recursive: true });
  });

  test("empty levels (no layout/loading/error/not-found) collapse out of frames", () => {
    const root = makeFixture({
      "layout.tsx": STUB_LAYOUT,
      "clients/[id]/page.tsx": STUB_PAGE,
    });
    const routes = scanRoutes(root);
    expect(routes[0]!.frames).toHaveLength(1);
    rmSync(root, { recursive: true });
  });

  test("loading.tsx, error.tsx, not-found.tsx populate the frame", () => {
    const root = makeFixture({
      "layout.tsx": STUB_LAYOUT,
      "loading.tsx": "export default () => 'loading'",
      "error.tsx": "export default () => 'error'",
      "not-found.tsx": "export default () => '404'",
      "page.tsx": STUB_PAGE,
    });
    const routes = scanRoutes(root);
    const frame = routes[0]!.frames[0]!;
    expect(frame.layout).toBeDefined();
    expect(frame.loading).toBeDefined();
    expect(frame.error).toBeDefined();
    expect(frame.notFound).toBeDefined();
    rmSync(root, { recursive: true });
  });
});

describe("scanRoutes parallel slots", () => {
  test("@<name> directories produce slot-tagged routes", () => {
    const root = makeFixture({
      "page.tsx": STUB_PAGE,
      "@modal/orders/[id]/page.tsx": STUB_PAGE,
    });
    const routes = scanRoutes(root);
    const main = routes.find((r) => !r.slot);
    const slot = routes.find((r) => r.slot === "modal");
    expect(main).toBeDefined();
    expect(slot).toBeDefined();
    expect(slot!.urlPath).toBe("/orders/[id]");
    expect(slot!.segments).toEqual([
      { kind: "literal", value: "orders" },
      { kind: "param", name: "id" },
    ]);
    rmSync(root, { recursive: true });
  });

  test("parent layout's frame carries slots[]", () => {
    const root = makeFixture({
      "layout.tsx": STUB_LAYOUT,
      "page.tsx": STUB_PAGE,
      "@modal/new/page.tsx": STUB_PAGE,
      "@sidebar/page.tsx": STUB_PAGE,
    });
    const routes = scanRoutes(root);
    const main = routes.find((r) => !r.slot);
    expect(main!.frames[0]!.slots).toBeDefined();
    expect(new Set(main!.frames[0]!.slots!)).toEqual(
      new Set(["modal", "sidebar"]),
    );
    rmSync(root, { recursive: true });
  });

  test("slot subtree starts with fresh frames (no outer layout)", () => {
    const root = makeFixture({
      "layout.tsx": STUB_LAYOUT,
      "page.tsx": STUB_PAGE,
      "@modal/layout.tsx": STUB_LAYOUT,
      "@modal/orders/page.tsx": STUB_PAGE,
    });
    const routes = scanRoutes(root);
    const slot = routes.find((r) => r.slot === "modal")!;
    // Should NOT include the root layout — slot frames are independent
    expect(slot.frames).toHaveLength(1);
    expect(slot.frames[0]!.layout).toContain("@modal/layout.tsx");
    rmSync(root, { recursive: true });
  });

  test("nested slots are dropped silently in v1", () => {
    const root = makeFixture({
      "page.tsx": STUB_PAGE,
      "@modal/page.tsx": STUB_PAGE,
      "@modal/@inner/page.tsx": STUB_PAGE,
    });
    const routes = scanRoutes(root);
    // Should have main + @modal page only, not @modal/@inner
    expect(routes.filter((r) => r.slot)).toHaveLength(1);
    rmSync(root, { recursive: true });
  });
});

describe("scanRoutes intercepting routes", () => {
  test("(.) prefix produces an intercept route", () => {
    const root = makeFixture({
      "page.tsx": STUB_PAGE,
      "@modal/(.)photos/[id]/page.tsx": STUB_PAGE,
    });
    const routes = scanRoutes(root);
    const intercept = routes.find((r) => r.intercept);
    expect(intercept).toBeDefined();
    expect(intercept!.intercept).toBe(".");
    expect(intercept!.urlPath).toBe("/photos/[id]");
    expect(intercept!.slot).toBe("modal");
    rmSync(root, { recursive: true });
  });

  test("(..) prefix records '..' kind", () => {
    const root = makeFixture({
      "feed/page.tsx": STUB_PAGE,
      "feed/@modal/(..)photos/[id]/page.tsx": STUB_PAGE,
    });
    const routes = scanRoutes(root);
    const intercept = routes.find((r) => r.intercept);
    expect(intercept).toBeDefined();
    expect(intercept!.intercept).toBe("..");
    rmSync(root, { recursive: true });
  });

  test("(...) prefix records '...' kind", () => {
    const root = makeFixture({
      "(...)photos/[id]/page.tsx": STUB_PAGE,
      "@modal/(...)photos/[id]/page.tsx": STUB_PAGE,
    });
    const routes = scanRoutes(root);
    const intercepts = routes.filter((r) => r.intercept);
    expect(intercepts.every((r) => r.intercept === "...")).toBe(true);
    rmSync(root, { recursive: true });
  });

  test("intercept tag bubbles down to deeper segments", () => {
    const root = makeFixture({
      "@modal/(..)settings/billing/page.tsx": STUB_PAGE,
    });
    const routes = scanRoutes(root);
    const intercept = routes.find((r) => r.intercept);
    expect(intercept!.urlPath).toBe("/settings/billing");
    expect(intercept!.intercept).toBe("..");
    rmSync(root, { recursive: true });
  });

  test("intercept tag propagates through slot boundary (intercept-wrapping-slot)", () => {
    // Unusual ordering, but must not silently drop the intercept tag —
    // otherwise the slot route would match on hard nav and pop on refresh.
    const root = makeFixture({
      "(.)photos/@modal/[id]/page.tsx": STUB_PAGE,
    });
    const routes = scanRoutes(root);
    const slot = routes.find((r) => r.slot === "modal");
    expect(slot).toBeDefined();
    expect(slot!.intercept).toBe(".");
    rmSync(root, { recursive: true });
  });
});
