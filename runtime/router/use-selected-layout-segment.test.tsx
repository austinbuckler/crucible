import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  LayoutSegmentContext,
  type LayoutSegmentContextValue,
  useSelectedLayoutSegment,
} from "./context.ts";
import type { Match, RouteRecord } from "./types.ts";

afterEach(() => cleanup());

function makeMatch(
  segments: Match["route"]["segments"],
  params: Record<string, string> = {},
): Match {
  const route: RouteRecord = {
    path: "/" + segments.map((s) =>
      s.kind === "literal" ? s.value :
      s.kind === "param" ? `[${s.name}]` : `[...${s.name}]`,
    ).join("/"),
    segments,
    frames: [],
    entrypoint: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      root: { moduleId: "x", load: () => Promise.resolve({}), getModuleIfRequired: () => null } as any,
      getPreloadProps: () => ({ queries: {} }),
    },
  };
  return { route, params };
}

function Probe({ slot }: { slot?: string }): ReactNode {
  // Render the result so we can read it from the DOM. Empty string means
  // "null" so we can distinguish "no descendant active" from "descendant
  // = literal 'null'" without overloading the ariane wire.
  const value = useSelectedLayoutSegment(slot);
  return <span data-testid="probe">{value ?? "<null>"}</span>;
}

function withContext(
  value: LayoutSegmentContextValue | null,
  children: ReactNode,
): ReactNode {
  if (!value) return <>{children}</>;
  return <LayoutSegmentContext value={value}>{children}</LayoutSegmentContext>;
}

describe("useSelectedLayoutSegment — no slot arg (children semantics)", () => {
  test("returns the segment immediately below the layout's URL position", () => {
    // Layout at root, URL = /orders/abc. Layout's depth = 0.
    const main = makeMatch(
      [
        { kind: "literal", value: "orders" },
        { kind: "param", name: "id" },
      ],
      { id: "abc" },
    );
    const { getByTestId } = render(
      withContext(
        { mainMatch: main, slotMatches: new Map(), urlDepth: 0 },
        <Probe />,
      ),
    );
    expect(getByTestId("probe").textContent).toBe("orders");
  });

  test("returns null when no descendant page is active under the layout", () => {
    // Layout at /orders/[id] (depth 2), URL only has 2 segments — there
    // IS no segment at index 2. Hook returns null per Next.js semantics.
    const main = makeMatch(
      [
        { kind: "literal", value: "orders" },
        { kind: "param", name: "id" },
      ],
      { id: "abc" },
    );
    const { getByTestId } = render(
      withContext(
        { mainMatch: main, slotMatches: new Map(), urlDepth: 2 },
        <Probe />,
      ),
    );
    expect(getByTestId("probe").textContent).toBe("<null>");
  });

  test("explicit 'children' arg behaves identically to no arg", () => {
    const main = makeMatch([{ kind: "literal", value: "settings" }]);
    const { getByTestId } = render(
      withContext(
        { mainMatch: main, slotMatches: new Map(), urlDepth: 0 },
        <Probe slot="children" />,
      ),
    );
    expect(getByTestId("probe").textContent).toBe("settings");
  });
});

describe("useSelectedLayoutSegment — with slot arg (parallel route semantics)", () => {
  test("returns the deepest segment of the named slot's match", () => {
    // Slot match: /orders/new (an intercept route) under @dialog. The
    // hook called from a layout above the slot returns the slot's last
    // segment — "new" — so consumers can detect intercept activity.
    const slotMatch = makeMatch([
      { kind: "literal", value: "orders" },
      { kind: "literal", value: "new" },
    ]);
    const slotMatches = new Map<string, Match | null>([
      ["dialog", slotMatch],
    ]);
    const { getByTestId } = render(
      withContext(
        {
          mainMatch: makeMatch([{ kind: "literal", value: "orders" }]),
          slotMatches,
          urlDepth: 0,
        },
        <Probe slot="dialog" />,
      ),
    );
    expect(getByTestId("probe").textContent).toBe("new");
  });

  test("returns null when the named slot has no active page", () => {
    const slotMatches = new Map<string, Match | null>([["dialog", null]]);
    const { getByTestId } = render(
      withContext(
        {
          mainMatch: makeMatch([{ kind: "literal", value: "orders" }]),
          slotMatches,
          urlDepth: 0,
        },
        <Probe slot="dialog" />,
      ),
    );
    expect(getByTestId("probe").textContent).toBe("<null>");
  });

  test("returns null when the named slot is unknown to the router", () => {
    const { getByTestId } = render(
      withContext(
        {
          mainMatch: makeMatch([{ kind: "literal", value: "orders" }]),
          slotMatches: new Map(),
          urlDepth: 0,
        },
        <Probe slot="dialog" />,
      ),
    );
    expect(getByTestId("probe").textContent).toBe("<null>");
  });
});

describe("useSelectedLayoutSegment — outside the router", () => {
  test("returns null when no LayoutSegmentContext is provided", () => {
    const { getByTestId } = render(<Probe />);
    expect(getByTestId("probe").textContent).toBe("<null>");
  });
});
