import { test, expect, describe } from "bun:test";
import { Route, Entrypoint } from "./route.ts";

// `Crucible.Route(...)` and `Crucible.Entrypoint(...)` are runtime
// thin-shells whose real job is a build-time signal to the codegen.
// At runtime they should be cheap and predictable: identity wrappers
// that don't introspect or coerce.

describe("Route", () => {
  test("returns an object with `page` and `Entrypoint` properties", () => {
    const r = Route("/hello", { title: "Hello" });
    expect(typeof r.page).toBe("function");
    expect(typeof r.Entrypoint).toBe("object");
  });

  test("`page` is identity at runtime — wraps the function unchanged", () => {
    const r = Route("/hello", { title: "Hello" });
    const fn = (_props: unknown) => null;
    // The wrapper returns the same function reference. The wrapper's
    // role is type-level (constraining the props shape), not runtime
    // transformation.
    expect(r.page(fn)).toBe(fn);
  });

  test("`Entrypoint` defaults to an empty object when not configured", () => {
    const r = Route("/hello", { title: "Hello" });
    expect(r.Entrypoint).toEqual({});
  });

  test("`Entrypoint` carries through the configured map by reference", () => {
    const Sidebar = (() => null) as never;
    const Feed = (() => null) as never;
    const r = Route("/clients/[id]", {
      Entrypoint: { Sidebar, Feed },
    });
    // Same identities — codegen relies on this for the import-graph
    // walk, so changing it would break sub-entrypoint discovery.
    expect(r.Entrypoint.Sidebar).toBe(Sidebar);
    expect(r.Entrypoint.Feed).toBe(Feed);
  });
});

describe("Entrypoint", () => {
  test("is identity at runtime — returns the component unchanged", () => {
    // The wrapper's signal is the call-site presence, not a runtime
    // transformation. Codegen recognizes `export default Crucible.Entrypoint(...)`
    // by inspecting the source AST.
    const C = (() => null) as never;
    expect(Entrypoint(C)).toBe(C);
  });
});

describe("Route — search spec (Standard Schema)", () => {
  test("accepts a Standard Schema validator and stores it on config", () => {
    // Search specs are Standard Schema validators only — Crucible
    // delegates to the spec's `~standard.validate` at navigation time
    // via the runtime PageRenderer.
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (v: unknown) => ({ value: v }),
      },
    };
    const r = Route("/x", { search: schema });
    expect(r.config.search).toBe(schema);
  });
});
