import { test, expect, describe } from "bun:test";
import type { AppProps } from "./app.tsx";
import {
  abandonPendingResolutionOwners,
  acknowledgeResolutionOwner,
  addResolutionOwner,
  canRenderResolutionOwner,
  createRouterOwners,
  disposeAllResolutionOwners,
  pickFromLocation,
} from "./app.tsx";
import { parseLocation } from "./context.ts";
import type { Resolution } from "./resolve.ts";

// These tests pin the public observability-hook shape. The router's
// `onNavigate` / `onResolve` are documented RUM hooks — adding/renaming
// fields without bumping consumers is a breaking change to monitoring
// dashboards. If a future refactor changes the hook signatures, these
// type-level assertions will fail at compile time.

describe("AppProps observability hooks — timing", () => {
  test("onNavigate receives startedAt", () => {
    const captured: { startedAt?: number } = {};
    const onNavigate: NonNullable<AppProps["onNavigate"]> = (event) => {
      // Field must exist and be a number — pin the shape.
      const v: number = event.startedAt;
      captured.startedAt = v;
    };
    onNavigate({
      from: { pathname: "/", search: "", hash: "" },
      to: { pathname: "/x", search: "", hash: "" },
      source: "soft",
      startedAt: 12.5,
    });
    expect(captured.startedAt).toBe(12.5);
  });

  test("onResolve receives startedAt, resolvedAt, durationMs", () => {
    const captured: {
      startedAt?: number;
      resolvedAt?: number;
      durationMs?: number;
    } = {};
    const onResolve: NonNullable<AppProps["onResolve"]> = (event) => {
      // Pin all three timing fields — type errors here mean a contract
      // break with consumers' RUM dashboards.
      captured.startedAt = event.startedAt;
      captured.resolvedAt = event.resolvedAt;
      captured.durationMs = event.durationMs;
    };
    onResolve({
      location: { pathname: "/x", search: "", hash: "" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolution: {} as any,
      startedAt: 100,
      resolvedAt: 175.25,
      durationMs: 75.25,
    });
    expect(captured).toEqual({
      startedAt: 100,
      resolvedAt: 175.25,
      durationMs: 75.25,
    });
  });

  test("durationMs equals resolvedAt - startedAt by convention", () => {
    // Pure shape test — the App component emits this relationship; the
    // type doesn't enforce it but RUM math depends on it being reliable.
    const event = {
      startedAt: 10,
      resolvedAt: 42.5,
      durationMs: 32.5,
    };
    expect(event.resolvedAt - event.startedAt).toBeCloseTo(event.durationMs);
  });
});

describe("pickFromLocation — popstate `from` correctness", () => {
  test("pop with a committed last location uses that, NOT window.location (which already moved)", () => {
    const last = parseLocation(new URL("https://x.com/a"));
    const win = parseLocation(new URL("https://x.com/b"));
    const out = pickFromLocation("pop", last, () => win);
    expect(out.pathname).toBe("/a");
    // Critically: the test would fail if the impl read window.location
    // for popstate, which is the bug we're guarding against.
    expect(out.pathname).not.toBe(win.pathname);
  });

  test("soft uses window.location (history hasn't moved yet)", () => {
    const last = parseLocation(new URL("https://x.com/a"));
    const win = parseLocation(new URL("https://x.com/b"));
    const out = pickFromLocation("soft", last, () => win);
    // For soft nav, window.location is the outgoing URL — that's `from`.
    expect(out.pathname).toBe("/b");
  });

  test("init uses window.location", () => {
    const win = parseLocation(new URL("https://x.com/initial"));
    const out = pickFromLocation("init", null, () => win);
    expect(out.pathname).toBe("/initial");
  });

  test("pop with NO committed last location falls back to window.location (first nav of session)", () => {
    // Edge case: a popstate firing before we've committed anything (rare,
    // but possible if user uses back/forward instantly on first paint).
    const win = parseLocation(new URL("https://x.com/x"));
    const out = pickFromLocation("pop", null, () => win);
    expect(out.pathname).toBe("/x");
  });
});

describe("router resolution owners", () => {
  test("acknowledging a pending owner promotes it once", () => {
    const owners = createRouterOwners();
    const disposeCalls: Resolution[] = [];
    const owner = addResolutionOwner(owners, {
      location: parseLocation(new URL("https://x.com/")),
      navSource: "init",
      startedAt: 1,
      resolution: makeResolution(),
    });

    const first = acknowledgeResolutionOwner(
      owners,
      owner.id,
      (resolution) => disposeCalls.push(resolution),
    );
    const replay = acknowledgeResolutionOwner(
      owners,
      owner.id,
      (resolution) => disposeCalls.push(resolution),
    );

    expect(first?.owner).toBe(owner);
    expect(first?.firstCommitAck).toBe(true);
    expect(replay?.firstCommitAck).toBe(false);
    expect(owners.committed).toBe(owner);
    expect(owners.pending.size).toBe(0);
    expect(disposeCalls).toHaveLength(0);
  });

  test("an abandoned owner cannot commit after a newer attempt supersedes it", () => {
    const owners = createRouterOwners();
    const disposeCalls: Resolution[] = [];
    const committed = addResolutionOwner(owners, {
      location: parseLocation(new URL("https://x.com/a")),
      navSource: "init",
      startedAt: 1,
      resolution: makeResolution(),
    });
    acknowledgeResolutionOwner(owners, committed.id, (resolution) => {
      disposeCalls.push(resolution);
    });

    const abandoned = addResolutionOwner(owners, {
      location: parseLocation(new URL("https://x.com/b")),
      navSource: "soft",
      startedAt: 2,
      resolution: makeResolution(),
    });
    abandonPendingResolutionOwners(owners);

    const ack = acknowledgeResolutionOwner(
      owners,
      abandoned.id,
      (resolution) => disposeCalls.push(resolution),
    );

    expect(ack).toBeNull();
    expect(owners.committed).toBe(committed);
    expect(abandoned.state).toBe("abandoned");
    expect(disposeCalls).toEqual([]);
  });

  test("superseded pending owners dispose after a newer owner commits", () => {
    const owners = createRouterOwners();
    const disposeCalls: Resolution[] = [];
    const a = addResolutionOwner(owners, {
      location: parseLocation(new URL("https://x.com/a")),
      navSource: "init",
      startedAt: 1,
      resolution: makeResolution(),
    });
    acknowledgeResolutionOwner(owners, a.id, (resolution) => {
      disposeCalls.push(resolution);
    });

    const b = addResolutionOwner(owners, {
      location: parseLocation(new URL("https://x.com/b")),
      navSource: "soft",
      startedAt: 2,
      resolution: makeResolution(),
    });
    abandonPendingResolutionOwners(owners);
    expect(disposeCalls).toHaveLength(0);

    const c = addResolutionOwner(owners, {
      location: parseLocation(new URL("https://x.com/c")),
      navSource: "soft",
      startedAt: 3,
      resolution: makeResolution(),
    });
    acknowledgeResolutionOwner(owners, c.id, (resolution) => {
      disposeCalls.push(resolution);
    });

    expect(owners.committed).toBe(c);
    expect(a.state).toBe("disposed");
    expect(b.state).toBe("disposed");
    expect(c.state).toBe("committed");
    expect(disposeCalls).toEqual([a.resolution, b.resolution]);
    expect(canRenderResolutionOwner(owners, b.id)).toBe(false);
    expect(canRenderResolutionOwner(owners, c.id)).toBe(true);
  });

  test("acknowledging a pending owner disposes abandoned owners", () => {
    const owners = createRouterOwners();
    const disposeCalls: Resolution[] = [];
    const a = addResolutionOwner(owners, {
      location: parseLocation(new URL("https://x.com/a")),
      navSource: "init",
      startedAt: 1,
      resolution: makeResolution(),
    });
    acknowledgeResolutionOwner(owners, a.id, (resolution) => {
      disposeCalls.push(resolution);
    });

    const b = addResolutionOwner(owners, {
      location: parseLocation(new URL("https://x.com/b")),
      navSource: "soft",
      startedAt: 2,
      resolution: makeResolution(),
    });
    abandonPendingResolutionOwners(owners);
    const c = addResolutionOwner(owners, {
      location: parseLocation(new URL("https://x.com/c")),
      navSource: "soft",
      startedAt: 3,
      resolution: makeResolution(),
    });

    acknowledgeResolutionOwner(owners, c.id, (resolution) => {
      disposeCalls.push(resolution);
    });

    expect(owners.committed).toBe(c);
    expect(a.state).toBe("disposed");
    expect(b.state).toBe("disposed");
    expect(c.state).toBe("committed");
    expect(owners.abandoned.size).toBe(0);
    expect(disposeCalls).toEqual([a.resolution, b.resolution]);
  });

  test("disposeAll disposes committed, pending, and abandoned owners once", () => {
    const owners = createRouterOwners();
    const disposeCalls: Resolution[] = [];
    const a = addResolutionOwner(owners, {
      location: parseLocation(new URL("https://x.com/a")),
      navSource: "init",
      startedAt: 1,
      resolution: makeResolution(),
    });
    acknowledgeResolutionOwner(owners, a.id, (resolution) => {
      disposeCalls.push(resolution);
    });
    const b = addResolutionOwner(owners, {
      location: parseLocation(new URL("https://x.com/b")),
      navSource: "soft",
      startedAt: 2,
      resolution: makeResolution(),
    });
    abandonPendingResolutionOwners(owners);
    const c = addResolutionOwner(owners, {
      location: parseLocation(new URL("https://x.com/c")),
      navSource: "soft",
      startedAt: 3,
      resolution: makeResolution(),
    });

    disposeAllResolutionOwners(owners, (resolution) => {
      disposeCalls.push(resolution);
    });
    disposeAllResolutionOwners(owners, (resolution) => {
      disposeCalls.push(resolution);
    });

    expect(disposeCalls).toEqual([a.resolution, c.resolution, b.resolution]);
    expect(owners.committed).toBeNull();
    expect(owners.pending.size).toBe(0);
    expect(owners.abandoned.size).toBe(0);
    expect(a.state).toBe("disposed");
    expect(b.state).toBe("disposed");
    expect(c.state).toBe("disposed");
  });
});

function makeResolution(): Resolution {
  return {
    main: null,
    slotMatches: new Map(),
    mainLoaded: null,
    slotLoaded: new Map(),
    slotPageCommits: new Map(),
  };
}
