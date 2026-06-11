// Generates the service worker source. The plugin embeds the build's asset
// list and a version string derived from a content-stable hash of those
// assets. Whenever any precached file's content changes, the version bumps;
// the activated SW deletes the prior cache and precaches the new set.

const TEMPLATE = `/* Crucible service worker — generated; do not edit. */
const VERSION = "__VERSION__";
const CACHE_NAME = "crucible-" + VERSION;
const ASSETS = __ASSETS__;

self.addEventListener("install", (event) => {
  // Pre-cache the asset list and let the new SW go to "waiting".
  // Activation is deferred — the runtime (sw-update.ts) decides when to
  // promote the waiting SW: either on user idle (auto), via the
  // 'crucible:update-ready' event handler the consumer wires up, or
  // imperatively through useCrucibleUpdate(). This avoids surprise
  // mid-session controller swaps that could break in-flight workflows
  // (half-filled forms, in-flight uploads, etc.).
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(ASSETS);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("crucible-") && k !== CACHE_NAME)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // SPA navigation: network-first, fall back to the cached app shell so the
  // app boots offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/index.html")),
    );
    return;
  }

  // Hashed bundle assets: cache-first. Vite content-hashes filenames
  // under /assets/, so those URLs are immutable. Cache-on-miss is only
  // safe for immutable URLs — dynamic responses (API calls, generated
  // files) would accumulate forever otherwise. Filter the cache.put gate
  // on the /assets/ pathname; everything else is fetched but not stored.
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (
        res &&
        res.status === 200 &&
        res.type === "basic" &&
        url.pathname.startsWith("/assets/")
      ) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, res.clone());
      }
      return res;
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "crucible:skip-waiting") self.skipWaiting();
});
`;

export function generateSwSource(
  version: string,
  assets: ReadonlyArray<string>,
): string {
  return TEMPLATE.replace("__VERSION__", version).replace(
    "__ASSETS__",
    JSON.stringify(assets, null, 2),
  );
}

// Heuristic: hash the sorted list of `filename::size` for every emitted
// asset. Bumps the version when any precached file changes; quiet when
// nothing did. Vite's content-hashed filenames already make most edits
// produce new filenames, so the version usually rolls forward only when the
// build actually moved.
export function computeAssetVersion(
  entries: ReadonlyArray<{ filename: string; size: number }>,
): string {
  const sorted = [...entries].sort((a, b) =>
    a.filename.localeCompare(b.filename),
  );
  const repr = sorted.map((a) => `${a.filename}::${a.size}`).join("|");
  return fnv1a(repr);
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Files we don't want to precache: the SW itself, sourcemaps, the manifest
// (served stale-while-revalidate is overkill for now; let it pass through).
export function shouldPrecache(filename: string): boolean {
  if (filename === "sw.js") return false;
  if (filename.endsWith(".map")) return false;
  if (filename === "manifest.webmanifest") return false;
  return true;
}
