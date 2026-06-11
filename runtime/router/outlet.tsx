import { type ErrorInfo, type ReactNode, Suspense, use } from "react";
import { ErrorBoundary } from "react-error-boundary";
import type { JSResource } from "../entrypoint.ts";
import { NotFoundBoundary, notFound } from "../not-found.tsx";
import { LayoutSegmentContext } from "./context.ts";
import { readResource } from "./load.ts";
import { PageRenderer } from "./page-renderer.tsx";
import type {
  Frame,
  LayoutModule,
  LoadedEntrypoint,
  Match,
} from "./types.ts";

// Top-level outlet that renders the active main route + its slot routes.
// Receives the resolution from `<App>` (which computed it at navigation
// time) and walks the frame chain top-down to assemble the visible tree.
export function RouteOutlet({
  resolution,
  rawSearch,
  onError,
}: {
  resolution: {
    main: Match | null;
    slotMatches: ReadonlyMap<string, Match | null>;
    mainLoaded: LoadedEntrypoint | null;
    slotLoaded: ReadonlyMap<string, LoadedEntrypoint>;
  };
  rawSearch: URLSearchParams;
  onError: (error: unknown, info: ErrorInfo) => void;
}) {
  const main = resolution.main;
  if (!main || !resolution.mainLoaded) {
    notFound();
  }
  // Top-level LayoutSegmentContext: descendants reading the context see
  // the active main match + slot matches. Each frame's layout pushes a
  // nested context that updates `urlDepth` to its own directory's depth,
  // so `useSelectedLayoutSegment` inside that layout reads the segment
  // immediately below it. Default depth is 0 so a hook called in a tree
  // above any layout (or in components mounted in the App body itself)
  // resolves against the root.
  return (
    <LayoutSegmentContext
      value={{
        mainMatch: main,
        slotMatches: resolution.slotMatches,
        urlDepth: 0,
      }}
    >
      <FrameChain
        frames={main.route.frames}
        slotLoaded={resolution.slotLoaded}
        slotMatches={resolution.slotMatches}
        rawSearch={rawSearch}
        onError={onError}
      >
        <PageRenderer
          loaded={resolution.mainLoaded}
          params={main.params}
          rawSearch={rawSearch}
        />
      </FrameChain>
    </LayoutSegmentContext>
  );
}

type FrameChainProps = {
  frames: ReadonlyArray<Frame>;
  children: ReactNode;
  slotLoaded: ReadonlyMap<string, LoadedEntrypoint>;
  slotMatches: ReadonlyMap<string, Match | null>;
  rawSearch: URLSearchParams;
  onError: (error: unknown, info: ErrorInfo) => void;
};

// Walks the frame array right-to-left so the OUTERMOST frame ends up
// wrapping everything else. Each frame contributes:
//   - its layout (if any), wrapping the existing tree
//   - a Suspense boundary (if a `loading.tsx` was authored at this level)
//   - a NotFoundBoundary (if `not-found.tsx`)
//   - an ErrorBoundary (if `error.tsx`)
// The `error.tsx` wrap is OUTERMOST per-frame so it catches errors thrown
// by the layout itself, not just children.
export function FrameChain(props: FrameChainProps) {
  return props.frames.reduceRight<ReactNode>(
    (acc, frame) => renderFrame(frame, acc, props),
    props.children,
  );
}

function renderFrame(
  frame: Frame,
  children: ReactNode,
  ctx: FrameChainProps,
): ReactNode {
  // Layouts are wrapped in their own child component so a layout's
  // JSResource-suspension is caught by the per-frame Suspense below —
  // not by a parent boundary above this frame.
  let node: ReactNode;
  if (frame.layout) {
    const slotProps = buildSlotProps(frame.slots, ctx);
    node = (
      <FrameLayout
        layout={frame.layout}
        slotProps={slotProps}
        urlDepth={frame.urlDepth ?? 0}
      >
        {children}
      </FrameLayout>
    );
  } else {
    node = children;
  }
  if (frame.loading) {
    const Loading = frame.loading;
    node = <Suspense fallback={<Loading />}>{node}</Suspense>;
  }
  if (frame.notFound) {
    const NotFound = frame.notFound;
    node = (
      <NotFoundBoundary fallback={<NotFound />}>{node}</NotFoundBoundary>
    );
  }
  if (frame.error) {
    node = (
      <ErrorBoundary FallbackComponent={frame.error} onError={ctx.onError}>
        {node}
      </ErrorBoundary>
    );
  }
  return node;
}

function buildSlotProps(
  slots: ReadonlyArray<string> | undefined,
  ctx: FrameChainProps,
): Record<string, ReactNode> {
  const out: Record<string, ReactNode> = {};
  if (!slots || slots.length === 0) return out;
  for (const slotName of slots) {
    const loaded = ctx.slotLoaded.get(slotName);
    const match = ctx.slotMatches.get(slotName);
    if (!loaded || !match) {
      out[slotName] = null;
      continue;
    }
    out[slotName] = (
      <SlotOutlet
        loaded={loaded}
        match={match}
        rawSearch={ctx.rawSearch}
        onError={ctx.onError}
      />
    );
  }
  return out;
}

function SlotOutlet({
  loaded,
  match,
  rawSearch,
  onError,
}: {
  loaded: LoadedEntrypoint;
  match: Match;
  rawSearch: URLSearchParams;
  onError: (error: unknown, info: ErrorInfo) => void;
}) {
  // A slot's render tree is independent of the main outlet's chain — it
  // has its own (typically small) frame chain inside the @<slot>/ subtree.
  //
  // Inside the slot, `useSelectedLayoutSegment("children")` should walk
  // the slot's own segments — the slot's match becomes the new
  // `mainMatch`. Slots can't host nested slots in v1, so `slotMatches`
  // is empty.
  //
  // SLOT ISOLATION: wrap the slot's content in its own Suspense
  // boundary. Without this, the slot's chunk-loading suspension would
  // bubble to the App-level Suspense (`app.tsx:391`), unmounting the
  // main view as well — visually, the entire page goes white the first
  // time an intercept route opens (its chunk + queries are loading).
  // The boundary's fallback is `null` because intercept dialogs
  // typically render `null` while loading and let their content fade
  // in. Slot routes that want a richer fallback can author a
  // `loading.tsx` at the slot's frame level — the per-frame Suspense
  // in `renderFrame` catches first. React 19 Suspense semantics: "If
  // part of your component tree suspends, by default React will show
  // the closest Suspense boundary's fallback." (cite:
  // https://react.dev/reference/react/Suspense — Suspense
  // hierarchy / "Closest boundary wins").
  return (
    <Suspense fallback={null}>
      <LayoutSegmentContext
        value={{
          mainMatch: match,
          slotMatches: EMPTY_SLOT_MATCHES,
          urlDepth: 0,
        }}
      >
        <FrameChain
          frames={loaded.route.frames}
          slotLoaded={EMPTY_SLOT_LOADED}
          slotMatches={EMPTY_SLOT_MATCHES}
          rawSearch={rawSearch}
          onError={onError}
        >
          <PageRenderer
            loaded={loaded}
            params={match.params}
            rawSearch={rawSearch}
          />
        </FrameChain>
      </LayoutSegmentContext>
    </Suspense>
  );
}

const EMPTY_SLOT_LOADED: ReadonlyMap<string, LoadedEntrypoint> = new Map();
const EMPTY_SLOT_MATCHES: ReadonlyMap<string, Match | null> = new Map();

function FrameLayout({
  layout,
  slotProps,
  urlDepth,
  children,
}: {
  layout: JSResource<LayoutModule>;
  slotProps: Record<string, ReactNode>;
  urlDepth: number;
  children: ReactNode;
}) {
  const Layout = readResource(layout).default;
  // Push a new LayoutSegmentContext value that updates `urlDepth` to
  // this layout's directory. `useSelectedLayoutSegment` called inside
  // the layout (and its descendants, until a deeper layout pushes its
  // own depth) reads the segment immediately below this URL position.
  // `mainMatch` / `slotMatches` are inherited unchanged.
  const parent = use(LayoutSegmentContext);
  const inner = <Layout {...slotProps}>{children}</Layout>;
  if (!parent) return inner;
  return (
    <LayoutSegmentContext
      value={{
        mainMatch: parent.mainMatch,
        slotMatches: parent.slotMatches,
        urlDepth,
      }}
    >
      {inner}
    </LayoutSegmentContext>
  );
}
