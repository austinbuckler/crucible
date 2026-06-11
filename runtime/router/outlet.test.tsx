import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { Suspense } from "react";
import type { ReactNode } from "react";
import type {
  EntryPoint,
  JSResource,
  PageModule,
  QueryParameter,
} from "../entrypoint.ts";
import {
  MetadataDefaultsProvider,
  type MetadataDefaults,
} from "../metadata.tsx";
import { RouteOutlet } from "./outlet.tsx";
import type {
  LayoutModule,
  LoadedEntrypoint,
  Match,
  RouteRecord,
} from "./types.ts";

afterEach(() => cleanup());

// Helper to build a `JSResource` whose `getModuleIfRequired()` returns
// a stub module synchronously (so PageRenderer doesn't suspend) OR
// returns null to force suspension via `readResource`. Mirrors
// `readResource`'s contract in `load.ts:15-19`: cached module → return
// it, no cache → throw the load promise.
function eagerResource<T extends object>(mod: T): JSResource<T> {
  return {
    moduleId: "test-eager",
    getModuleIfRequired: () => mod,
    load: () => Promise.resolve(mod),
  };
}

function suspendingResource<T extends object>(): JSResource<T> {
  // `load()` returns a promise that never resolves — readResource will
  // throw it, triggering Suspense. The closest boundary catches.
  return {
    moduleId: "test-suspend",
    getModuleIfRequired: () => null,
    load: () =>
      new Promise<T>(() => {
        // never resolves — keeps the suspension active for the test
      }),
  };
}

type PageModuleAny = PageModule<Record<string, QueryParameter>>;
type PageComponent = PageModuleAny["default"];

function makeEntrypoint(
  Component: PageComponent,
): EntryPoint<Record<string, QueryParameter>> {
  return {
    root: eagerResource<PageModuleAny>({ default: Component }),
    getPreloadProps: () => ({ queries: {} }),
  };
}

function makeSuspendingEntrypoint(): EntryPoint<
  Record<string, QueryParameter>
> {
  return {
    root: suspendingResource<PageModuleAny>(),
    getPreloadProps: () => ({ queries: {} }),
  };
}

function makeRoute(
  path: string,
  entrypoint: EntryPoint<Record<string, QueryParameter>>,
  opts: { slot?: string; intercept?: string | true } = {},
): RouteRecord {
  return {
    path,
    segments: [],
    frames: [],
    entrypoint,
    ...opts,
  };
}

function makeMatch(route: RouteRecord): Match {
  return { route, params: {} };
}

function makeLoaded(match: Match): LoadedEntrypoint {
  return { route: match.route, preloaded: {}, entryPoints: {} };
}

// Mirrors how App.tsx mounts the outlet — the App-level Suspense is what
// would render the "page goes white" fallback if a slot's load were to
// bubble. We render the outlet under that boundary in tests so we can
// assert the bug stays fixed: with isolation, the App-level fallback
// must NOT render when a slot suspends.
const TEST_DEFAULTS: MetadataDefaults = {
  themeColor: "#ffffff",
  backgroundColor: "#ffffff",
  statusBarStyle: "default",
  manifest: false,
  defaultTitle: "",
};

function renderInAppShell(node: ReactNode): {
  getByText: (text: string) => HTMLElement;
  queryByText: (text: string) => HTMLElement | null;
} {
  const { getByText, queryByText } = render(
    <MetadataDefaultsProvider value={TEST_DEFAULTS}>
      <Suspense fallback={<div data-testid="app-fallback">APP_FALLBACK</div>}>
        {node}
      </Suspense>
    </MetadataDefaultsProvider>,
  );
  return { getByText, queryByText };
}

describe("RouteOutlet — slot suspension isolation (white-flash fix)", () => {
  test("a suspending slot does NOT trip the App-level Suspense fallback (main view stays visible)", () => {
    // Repro of the user-reported bug:
    // - User on `/orders/abc-123` (main = orders/[id], LOADED).
    // - User clicks "+New Order" → soft nav to `/orders/new`.
    // - Resolver: intercept matches → main preserved (orders/[id]).
    // - Slot's chunk hasn't loaded yet → PageRenderer suspends.
    // BEFORE THE FIX: App-level <Suspense fallback={<DefaultLoading/>}>
    // catches → main view unmounts → entire page goes white until the
    // slot's chunk + queries resolve.
    // AFTER THE FIX: slot has its own Suspense (fallback=null) → main
    // keeps rendering, dialog area is empty briefly, no white flash.
    const Main: PageComponent = () => <div>MAIN_CONTENT</div>;
    const mainRoute = makeRoute("/orders/[id]", makeEntrypoint(Main));
    const mainMatch = makeMatch(mainRoute);
    const slotRoute = makeRoute("/orders/new", makeSuspendingEntrypoint(), {
      slot: "dialog",
      intercept: ".",
    });
    const slotMatch = makeMatch(slotRoute);

    const resolution = {
      main: mainMatch,
      mainLoaded: makeLoaded(mainMatch),
      slotMatches: new Map<string, Match | null>([["dialog", slotMatch]]),
      slotLoaded: new Map<string, LoadedEntrypoint>([
        ["dialog", makeLoaded(slotMatch)],
      ]),
    };

    const { getByText, queryByText } = renderInAppShell(
      <RouteOutlet
        resolution={resolution}
        rawSearch={new URLSearchParams()}
        onError={() => {}}
      />,
    );

    // Main content rendered — the slot's suspension was caught at the
    // slot's boundary, NOT the App-level boundary.
    expect(getByText("MAIN_CONTENT")).toBeDefined();
    // App-level fallback did NOT fire. This is the assertion that pins
    // the bug fix: if the slot's suspension ever bubbles up again, this
    // test fails because the App fallback would replace MAIN_CONTENT.
    expect(queryByText("APP_FALLBACK")).toBeNull();
  });

  test("a non-suspending slot renders alongside the main (no regression)", () => {
    // Sanity check: when both main and slot are loaded, both render.
    const Main: PageComponent = () => <div>MAIN</div>;
    const Slot: PageComponent = () => <div>SLOT</div>;
    // Layout receives the dialog slot as a named prop and renders it
    // adjacent to children — mirrors Crucible's root layout shape.
    const Layout = ({
      children,
      dialog,
    }: {
      children: ReactNode;
      dialog?: ReactNode;
    }) => (
      <div>
        {children}
        <div data-testid="dialog-slot">{dialog ?? null}</div>
      </div>
    );
    const layoutResource = eagerResource<LayoutModule>({ default: Layout });
    const mainRoute: RouteRecord = {
      path: "/",
      segments: [],
      frames: [
        {
          layout: layoutResource,
          slots: ["dialog"],
        },
      ],
      entrypoint: makeEntrypoint(Main),
    };
    const mainMatch = makeMatch(mainRoute);
    const slotRoute = makeRoute("/orders/new", makeEntrypoint(Slot), {
      slot: "dialog",
      intercept: ".",
    });
    const slotMatch = makeMatch(slotRoute);
    const resolution = {
      main: mainMatch,
      mainLoaded: makeLoaded(mainMatch),
      slotMatches: new Map<string, Match | null>([["dialog", slotMatch]]),
      slotLoaded: new Map<string, LoadedEntrypoint>([
        ["dialog", makeLoaded(slotMatch)],
      ]),
    };
    const { getByText, queryByText } = renderInAppShell(
      <RouteOutlet
        resolution={resolution}
        rawSearch={new URLSearchParams()}
        onError={() => {}}
      />,
    );
    expect(getByText("MAIN")).toBeDefined();
    expect(getByText("SLOT")).toBeDefined();
    expect(queryByText("APP_FALLBACK")).toBeNull();
  });
});
