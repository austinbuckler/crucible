/// <reference types="vite/client" />

// Resolved by the Crucible Vite plugin against the consuming app's
// `persisted-queries.json` (relay-compiler output). Declared here so the
// runtime module's `import persistedQueries from "virtual:crucible/…"`
// type-checks; the plugin's resolveId/load hooks provide the real value.
declare module "virtual:crucible/persisted-queries" {
    const persistedQueries: Record<string, string>;
    export default persistedQueries;
}

// Crucible-injected build-time constants. The Vite plugin emits these via
// `define`, so TS sees them in user code as well.
interface ImportMetaEnv {
    readonly CRUCIBLE_SW_URL: string | null;
    readonly CRUCIBLE_MANIFEST_URL: string | null;
    // Content hash of `schema.graphql`, embedded by the Crucible plugin.
    // Used as part of the Relay store's localStorage cache key so a schema
    // change orphans stale records.
    readonly CRUCIBLE_SCHEMA_HASH: string;
    // Build-time API base URL. Empty string for web builds (relative
    // `/api/*` resolves same-origin); set by `vite.config.ts`'s `define`
    // for desktop builds so the SPA loaded from `app://app` reaches the
    // prod API at e.g. `https://app.example.com/api/*`. Read by the
    // Crucible runtime's GraphQL endpoint resolver and by consumer
    // network handlers (see `src/app/crucible.config.ts`).
    readonly CRUCIBLE_API_BASE_URL: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

// Crucible-dispatched custom events on `window`. Augment WindowEventMap
// so `window.addEventListener('crucible:update-ready', e => …)` types
// `e` as `CustomEvent<SwUpdateReadyEventDetail>` — `e.detail.activate`
// is then a known function, not `unknown`.
interface CrucibleSwUpdateReadyEventDetail {
    readonly activate: () => void;
}

interface WindowEventMap {
    "crucible:update-ready": CustomEvent<CrucibleSwUpdateReadyEventDetail>;
}

// Globals available inside files the codegen dynamic-imports
// (`src/app/splash.tsx`, `src/app/manifest.ts`). Declared as ambients so
// user code doesn't need a `from "crucible"` module import — Bun's
// resolver isn't pointed at the framework alias when running these files
// directly, so any module import would fail. The framework also installs
// runtime no-op stubs on `globalThis` before each import, so module
// evaluation doesn't ReferenceError.
declare function beforeCrucibleMount(callback: () => void): void;

// Identity helper for typed manifest authoring. Author your manifest as
// `export default defineManifest({…})` to get IDE completion against the
// `Manifest` type without an import.
declare function defineManifest(manifest: Manifest): Manifest;

// PWA manifest shape — see plugin/pwa.ts for the source of truth.
type ManifestIcon = {
    src: string;
    sizes: string;
    type?: string;
    purpose?: "any" | "maskable" | "monochrome";
};

type Manifest = {
    name: string;
    shortName?: string;
    description?: string;
    themeColor: `#${string}`;
    backgroundColor: `#${string}`;
    display?: "standalone" | "fullscreen" | "minimal-ui" | "browser";
    startUrl?: string;
    scope?: string;
    orientation?: "portrait" | "landscape" | "any";
    categories?: ReadonlyArray<string>;
    icons: ReadonlyArray<ManifestIcon>;
    appleTouchIcon?: string;
};
