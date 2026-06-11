// Omakase page contract — `Crucible.Route(...)` returns a typed Route
// object whose `.page(fn)` becomes the page's default export and whose
// `.Entrypoint.<Name>` namespace exposes the file's sub-entrypoints.
// `Crucible.Entrypoint(component)` marks a sibling file as an
// entrypoint (no-op at runtime; the codegen reads the call site).
export { Route, Entrypoint } from "./runtime/route.ts";
export type {
  RouteConfig,
  RouteObject,
  RoutePageProps,
  SearchSpec,
  InferSearch,
  InferParams,
} from "./runtime/route.ts";

export { App } from "./runtime/router/app.tsx";
export { EntryPointContainer } from "./runtime/router/page-renderer.tsx";
export {
  useNavigate,
  useLocation,
  useParams,
  useSearchParams,
  useDeferredSearchParams,
  usePrefetch,
  useIsNavigating,
  useSelectedLayoutSegment,
} from "./runtime/router/context.ts";
export type { LoadedSubEntrypoint } from "./runtime/router/types.ts";
export { Link } from "./runtime/link.tsx";
export {
  Window,
  type WindowProps,
  type WindowOptions,
} from "./runtime/window.tsx";
export {
  openAppWindow,
  type AppWindowHandle,
} from "./runtime/open-window.ts";
export {
  usePlatform,
  isElectron,
  getRuntimeType,
} from "./runtime/platform.ts";
export { useAsyncDispatch } from "./runtime/use-async-dispatch.ts";
export { dismissSplashScreen } from "./runtime/splash.ts";
export type {
  PlatformRuntime,
  CrucibleRuntime,
  RuntimeType,
  PlatformCapability,
} from "./runtime/platform.ts";
export { notFound } from "./runtime/not-found.tsx";
export {
  createEnvironment,
  type CreateEnvironmentOptions,
  type Environment,
  type FetchLike,
} from "./runtime/environment.ts";

/**
 * Shape of `src/app/crucible.config.ts`. The codegen-emitted main.tsx
 * imports each named export (when present) and wires it into the
 * matching framework primitive at boot:
 *
 *   - `network` → `createEnvironment({ fetch: network.fetch })` (#46)
 *   - `swUpdate` → `<AppShell swUpdate={swUpdate}>` (#53)
 *
 * Each export is independently optional. Apps that ship no config
 * file get the original zero-config bundle. Apps that export only
 * `network` get a bare AppShell; apps that export only `swUpdate`
 * get a default-fetch environment. Keep the export shape stable —
 * this is the canonical user surface for boot-time Crucible config;
 * future fields land here rather than in parallel mechanisms.
 *
 * @example
 *   // src/app/crucible.config.ts
 *   import type { CrucibleConfig, FetchLike } from "crucible";
 *
 *   const idempotencyFetch: FetchLike = (url, init) => {
 *     const headers = new Headers(init.headers);
 *     if (!headers.has("Idempotency-Key")) {
 *       headers.set("Idempotency-Key", crypto.randomUUID());
 *     }
 *     return fetch(url, { ...init, headers });
 *   };
 *
 *   export const network: CrucibleConfig["network"] = {
 *     fetch: idempotencyFetch,
 *   };
 *
 *   export const swUpdate: CrucibleConfig["swUpdate"] = {
 *     idleThresholdMs: 60_000,
 *     onUpdateReady: (event) => {
 *       // Show a "Refresh to update" toast; user clicks → event.activate()
 *     },
 *     onSwError: (err) => Sentry.captureException(err),
 *   };
 */
export type CrucibleConfig = {
  /**
   * Configuration for Crucible's Relay network handler. `fetch` is
   * called per attempt (initial + retries) with the same `(url, init)`
   * shape as platform `fetch`. Composes inside Crucible's transient
   * 429/503 retry layer (#8) and AbortSignal plumbing (#18).
   */
  network?: {
    fetch?: import("./runtime/environment.ts").FetchLike;
  };
  /**
   * Configuration for the service-worker update lifecycle managed by
   * `<AppShell>` (see #29). Tunes idle auto-activate timing and wires
   * observability callbacks (`onUpdateReady`, `onSwError`). The
   * bug-fix mechanics (`updateViaCache: 'none'`, registration
   * polling, deferred `skipWaiting`, `controllerchange` reload, etc.)
   * are framework defaults and are NOT configurable from here.
   *
   * Omit to get the documented defaults: 5-minute idle threshold,
   * window-event-only signaling, `console.error` for SW registration
   * failures.
   */
  swUpdate?: import("./ui/app-shell.tsx").SwUpdateBehavior;
};
export {
  AppShell,
  type AppShellProps,
  type AppleStatusBarStyle,
  type HexColor,
  type SwUpdateBehavior,
} from "./ui/app-shell.tsx";
export {
  useCrucibleUpdate,
  type CrucibleUpdateHandle,
  type SwUpdateStatus,
} from "./runtime/use-crucible-update.ts";
export type {
  SwUpdateReadyEvent,
  SwUpdateReadyEventDetail,
} from "./runtime/sw-update.ts";
export type { Metadata, TitleTemplate } from "./runtime/metadata.tsx";
export { useDocumentTitle, useMetadata } from "./runtime/metadata.tsx";

// `beforeCrucibleMount`, `defineManifest`, and the `Manifest` type are
// declared as global ambients (see plugin/crucible-env.d.ts). User files
// the codegen dynamic-imports at build time (splash.tsx, manifest.ts) use
// these globals so the file has no `from "crucible"` imports — Bun's
// resolver doesn't follow Vite aliases at codegen time.

