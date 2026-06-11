/// <reference lib="dom" />
import { test, expect, describe, mock, beforeEach } from "bun:test";
import { render, cleanup, act } from "@testing-library/react";
import {
  NavigationContext,
  ParamsContext,
  useLocation,
  useNavigate,
  usePrefetch,
  useIsNavigating,
  useParams,
  useRefresh,
  useSearchParams,
  useDeferredSearchParams,
  parseLocation,
  type NavigationContextValue,
} from "./context.ts";
import type { Location } from "./types.ts";

beforeEach(() => cleanup());

function makeNavCtx(over: Partial<NavigationContextValue> = {}): NavigationContextValue {
  return {
    location: {
      pathname: "/",
      search: new URLSearchParams(),
      hash: "",
    },
    navigate: () => {},
    prefetch: () => {},
    refresh: () => {},
    isNavigating: false,
    ...over,
  };
}

// Probe: capture a hook's return value into a ref so the test can read it.
function makeProbe<T>(hook: () => T) {
  const captured: { value: T | undefined } = { value: undefined };
  function Probe() {
    captured.value = hook();
    return null;
  }
  return { Probe, captured };
}

describe("useLocation", () => {
  test("returns the context's location when mounted under <App>", () => {
    const location: Location = {
      pathname: "/orders/abc",
      search: new URLSearchParams("tab=archived"),
      hash: "#section",
    };
    const ctx = makeNavCtx({ location });
    const { Probe, captured } = makeProbe(useLocation);

    render(
      <NavigationContext.Provider value={ctx}>
        <Probe />
      </NavigationContext.Provider>,
    );

    expect(captured.value).toBe(location);
  });

  test("throws outside <App>", () => {
    const { Probe } = makeProbe(useLocation);
    // React renders the throw inside an error path; we catch via try/catch
    // on the synchronous render call.
    expect(() => render(<Probe />)).toThrow(/useLocation outside/);
  });
});

describe("useNavigate", () => {
  test("returns the context's navigate fn", () => {
    const navigate = mock(() => {});
    const ctx = makeNavCtx({ navigate });
    const { Probe, captured } = makeProbe(useNavigate);

    render(
      <NavigationContext.Provider value={ctx}>
        <Probe />
      </NavigationContext.Provider>,
    );

    captured.value!("/x");
    expect(navigate).toHaveBeenCalledWith("/x");
  });

  test("throws outside <App>", () => {
    const { Probe } = makeProbe(useNavigate);
    expect(() => render(<Probe />)).toThrow(/useNavigate outside/);
  });
});

describe("usePrefetch", () => {
  test("returns the context's prefetch fn", () => {
    const prefetch = mock(() => {});
    const ctx = makeNavCtx({ prefetch });
    const { Probe, captured } = makeProbe(usePrefetch);

    render(
      <NavigationContext.Provider value={ctx}>
        <Probe />
      </NavigationContext.Provider>,
    );

    captured.value!("/x");
    expect(prefetch).toHaveBeenCalledWith("/x");
  });

  test("throws outside <App>", () => {
    const { Probe } = makeProbe(usePrefetch);
    expect(() => render(<Probe />)).toThrow(/usePrefetch outside/);
  });
});

describe("useRefresh", () => {
  test("returns the context's refresh fn — invoking it calls through", () => {
    const refresh = mock(() => {});
    const ctx = makeNavCtx({ refresh });
    const { Probe, captured } = makeProbe(useRefresh);

    render(
      <NavigationContext.Provider value={ctx}>
        <Probe />
      </NavigationContext.Provider>,
    );

    captured.value!();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("throws outside <App>", () => {
    const { Probe } = makeProbe(useRefresh);
    expect(() => render(<Probe />)).toThrow(/useRefresh outside/);
  });
});

describe("useIsNavigating", () => {
  // Two probes (one per ctx value) so we actually prove the hook reads
  // dynamically from context — not a hardcoded value or the wrong ctx.
  test("dynamically reflects the ctx value (true and false)", () => {
    const trueCtx = makeNavCtx({ isNavigating: true });
    const falseCtx = makeNavCtx({ isNavigating: false });
    const probeT = makeProbe(useIsNavigating);
    const probeF = makeProbe(useIsNavigating);

    render(
      <NavigationContext.Provider value={trueCtx}>
        <probeT.Probe />
      </NavigationContext.Provider>,
    );
    cleanup();
    render(
      <NavigationContext.Provider value={falseCtx}>
        <probeF.Probe />
      </NavigationContext.Provider>,
    );

    expect(probeT.captured.value).toBe(true);
    expect(probeF.captured.value).toBe(false);
  });

  test("throws outside <App>", () => {
    const { Probe } = makeProbe(useIsNavigating);
    expect(() => render(<Probe />)).toThrow(/useIsNavigating outside/);
  });
});

describe("useParams", () => {
  test("returns the params context value", () => {
    const params = { id: "abc", filter: "active" };
    const { Probe, captured } = makeProbe(() =>
      useParams<typeof params>(),
    );

    render(
      <ParamsContext.Provider value={params}>
        <Probe />
      </ParamsContext.Provider>,
    );

    expect(captured.value).toEqual(params);
  });

  test("returns the default empty object when no provider mounted", () => {
    // Unlike useNavigate, useParams doesn't throw when called outside —
    // it returns the default {} so consumers can safely call it from
    // non-routed React trees (storybook, tests).
    const { Probe, captured } = makeProbe(useParams);
    render(<Probe />);
    expect(captured.value).toEqual({});
  });
});

describe("useSearchParams", () => {
  test("returns location.search", () => {
    const search = new URLSearchParams("filter=active&page=2");
    const ctx = makeNavCtx({
      location: { pathname: "/", search, hash: "" },
    });
    const { Probe, captured } = makeProbe(useSearchParams);

    render(
      <NavigationContext.Provider value={ctx}>
        <Probe />
      </NavigationContext.Provider>,
    );

    expect(captured.value).toBe(search);
  });
});

describe("useDeferredSearchParams", () => {
  test("returns a URLSearchParams with the same entries as the live one", () => {
    const search = new URLSearchParams("filter=active&page=2");
    const ctx = makeNavCtx({
      location: { pathname: "/", search, hash: "" },
    });
    const { Probe, captured } = makeProbe(useDeferredSearchParams);

    render(
      <NavigationContext.Provider value={ctx}>
        <Probe />
      </NavigationContext.Provider>,
    );

    expect(captured.value).toBeInstanceOf(URLSearchParams);
    expect(captured.value!.get("filter")).toBe("active");
    expect(captured.value!.get("page")).toBe("2");
  });

  test("returns a stable reference across same-string re-renders (memoized)", () => {
    const search = new URLSearchParams("a=1");
    const ctx = makeNavCtx({
      location: { pathname: "/", search, hash: "" },
    });
    const seen: URLSearchParams[] = [];
    function Probe() {
      seen.push(useDeferredSearchParams());
      return null;
    }

    const { rerender } = render(
      <NavigationContext.Provider value={ctx}>
        <Probe />
      </NavigationContext.Provider>,
    );
    rerender(
      <NavigationContext.Provider value={ctx}>
        <Probe />
      </NavigationContext.Provider>,
    );

    expect(seen.length).toBeGreaterThanOrEqual(2);
    // Memoized on serialized-string identity, so two reads with the
    // same params share an instance.
    expect(seen[0]).toBe(seen[1]);
  });
});

describe("parseLocation", () => {
  test("extracts pathname, search, and hash from a URL", () => {
    const url = new URL("https://x.example/orders/123?filter=open#hash");
    const loc = parseLocation(url);
    expect(loc.pathname).toBe("/orders/123");
    expect(loc.hash).toBe("#hash");
    expect(loc.search.get("filter")).toBe("open");
  });

  test("handles URLs with no search and no hash", () => {
    const url = new URL("https://x.example/");
    const loc = parseLocation(url);
    expect(loc.pathname).toBe("/");
    expect(loc.search.toString()).toBe("");
    expect(loc.hash).toBe("");
  });

  test("preserves repeated query keys", () => {
    const url = new URL("https://x.example/?tag=a&tag=b");
    const loc = parseLocation(url);
    expect(loc.search.getAll("tag")).toEqual(["a", "b"]);
  });
});
