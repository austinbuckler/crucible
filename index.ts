import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { runCodegen } from "./codegen/run.ts";
export {
    isRelayGeneratedArtifact,
    stripRelayResolverTypeAssertions,
} from "./relay-artifacts.ts";
import {
    isRelayGeneratedArtifact,
    stripRelayResolverTypeAssertions,
} from "./relay-artifacts.ts";
import {
    resolvePWA,
    writeManifestFile,
    type PWAConfig,
    type ResolvedPWA,
} from "./pwa.ts";
import { computeAssetVersion, generateSwSource, shouldPrecache } from "./sw.ts";
// Cheap content hash for `schema.graphql`. FNV-1a — same algorithm we use
// for SW asset versioning. Returns a stable 8-char hex string the client
// embeds in its localStorage cache key. Identical schema → identical hash
// → cache survives deploys; any schema edit → fresh key, old records
// orphaned and swept on next boot.
function computeSchemaHash(appRoot: string): string {
    const schemaPath = join(appRoot, "schema.graphql");
    if (!existsSync(schemaPath)) return "noschema";
    let h = 0x811c9dc5;
    const text = readFileSync(schemaPath, "utf8");
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}

export function isAppPageModule(id: string, appRoot: string): boolean {
    const normalized = id.split(sep).join("/");
    const appDir = join(appRoot, "src", "app").split(sep).join("/");
    return normalized.startsWith(`${appDir}/`) &&
        (normalized.endsWith("/page.tsx") || normalized.endsWith("/default.tsx"));
}

export function stripPageQueryExport(code: string): string {
    const exportDecl = /(^[ \t]*)export\s+const\s+query\b/gm;
    let out = "";
    let cursor = 0;

    for (const match of code.matchAll(exportDecl)) {
        const start = match.index;
        if (isInsideStringOrComment(code, start)) continue;
        const statement = readConstStatement(code, start);
        if (!statement || hasTopLevelComma(statement.declarator)) continue;
        out += code.slice(cursor, start);
        out += `${match[1] ?? ""}const query${statement.afterName}`;
        cursor = statement.end;
    }

    return cursor === 0 ? code : out + code.slice(cursor);
}

function isInsideStringOrComment(code: string, offset: number): boolean {
    let quote: '"' | "'" | "`" | null = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;

    for (let i = 0; i < offset; i++) {
        const ch = code[i];
        const next = code[i + 1];
        if (lineComment) {
            if (ch === "\n") lineComment = false;
            continue;
        }
        if (blockComment) {
            if (ch === "*" && next === "/") {
                blockComment = false;
                i++;
            }
            continue;
        }
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "/" && next === "/") {
            lineComment = true;
            i++;
            continue;
        }
        if (ch === "/" && next === "*") {
            blockComment = true;
            i++;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    }

    return quote != null || lineComment || blockComment;
}

function readConstStatement(
    code: string,
    start: number,
): { afterName: string; declarator: string; end: number } | null {
    const nameStart = code.indexOf("query", start);
    if (nameStart < 0) return null;
    const afterNameStart = nameStart + "query".length;
    const equals = code.indexOf("=", afterNameStart);
    if (equals < 0) return null;

    let depth = 0;
    let quote: '"' | "'" | "`" | null = null;
    let escaped = false;
    for (let i = equals + 1; i < code.length; i++) {
        const ch = code[i];
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            quote = ch;
            continue;
        }
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
        if (depth === 0 && ch === ";") {
            const afterName = code.slice(afterNameStart, i + 1);
            return {
                afterName,
                declarator: code.slice(equals + 1, i),
                end: i + 1,
            };
        }
        if (depth === 0 && ch === "\n") {
            const rest = code.slice(i + 1);
            if (/^\s*(?:export|import|const|let|var|function|type|interface)\b/.test(rest)) {
                const afterName = code.slice(afterNameStart, i);
                return {
                    afterName,
                    declarator: code.slice(equals + 1, i),
                    end: i,
                };
            }
        }
    }
    const afterName = code.slice(afterNameStart);
    return { afterName, declarator: code.slice(equals + 1), end: code.length };
}

function hasTopLevelComma(source: string): boolean {
    let depth = 0;
    let quote: '"' | "'" | "`" | null = null;
    let escaped = false;
    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            quote = ch;
            continue;
        }
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
        if (depth === 0 && ch === ",") return true;
    }
    return false;
}

export type CrucibleOptions = {
    appRoot?: string;
    // PWA configuration fallback. Prefer authoring `src/app/manifest.ts` at
    // the app root and exporting a default Manifest (or a function returning
    // one). The file-based manifest is picked up automatically; this option
    // is only used when the file isn't present.
    pwa?: PWAConfig;
    // npm specifier for the crucible package itself, embedded into the
    // generated import statements under `.crucible/`. Defaults to
    // "react-crucible". Override when the package is published or
    // aliased under a different name.
    crucibleSpecifier?: string;
    // Extra origins to append to the generated `index.html`'s CSP
    // `connect-src` directive, on top of the tight default of
    // `'self' ws: wss:`. Pass full schemes — e.g.
    // `["https://api.example.com", "https://*.sentry.io"]`.
    connectSrcAllowlist?: ReadonlyArray<string>;
    experimental?: {
        // Enables React's optional `<ViewTransition>` integration for route
        // swaps. Requires a React runtime that exports `ViewTransition`;
        // older React 19 releases fall back to regular Transition + Suspense.
        reactViewTransitions?: boolean;
    };
};

export type { PWAConfig, PWAIcon } from "./pwa.ts";

export function crucible(options: CrucibleOptions = {}): Plugin {
    let appRoot = options.appRoot ?? process.cwd();
    let pwa: ResolvedPWA | null = null;

    // Read the manifest snapshot the codegen CLI wrote at
    // `.crucible/_internal/manifest.json`. The plugin is runtime-agnostic
    // here — JSON reads work under Node-Vite, Bun-Vite, and anything in
    // between. The CLI (always run under Bun) is responsible for keeping
    // the snapshot fresh; `bun run codegen` regenerates it.
    function loadManifestConfig(): PWAConfig | null {
        const snapshot = join(
            appRoot,
            ".crucible",
            "_internal",
            "manifest.json",
        );
        if (existsSync(snapshot)) {
            try {
                const text = readFileSync(snapshot, "utf8").trim();
                if (text === "null" || text === "") return options.pwa ?? null;
                const value = JSON.parse(text);
                if (value && typeof value === "object")
                    return value as PWAConfig;
            } catch (err) {
                console.error(
                    "[crucible] failed to read .crucible/_internal/manifest.json:",
                    err,
                );
            }
        }
        return options.pwa ?? null;
    }

    const regen = (reason: string) => {
        try {
            const result = runCodegen({
                appRoot,
                crucibleSpecifier: options.crucibleSpecifier,
                connectSrcAllowlist: options.connectSrcAllowlist,
            });
            console.log(
                `[crucible] (${reason}) regenerated ${result.routeCount} route(s).`,
            );
        } catch (err) {
            console.error("[crucible] codegen failed:", err);
        }
    };

    // Virtual module IDs Crucible owns. Vite's convention prefixes the
    // resolved id with `\0` so other plugins know to leave it alone.
    const PERSISTED_QUERIES_ID = "virtual:crucible/persisted-queries";
    const RESOLVED_PERSISTED_QUERIES_ID =
        "\0virtual:crucible/persisted-queries";

    return {
        name: "crucible",
        enforce: "pre",
        // Native Rolldown pre-filters on resolveId/load so the JS handlers
        // only fire for our virtual module id. Without these, both hooks
        // ran for every module import in the bundle (~30k+ calls) just to
        // string-compare and bail out — measurable plugin overhead with
        // Vite 8/Rolldown's PLUGIN_TIMINGS check.
        resolveId: {
            filter: {
                id: { include: /^virtual:crucible\/persisted-queries$/ },
            },
            handler() {
                return RESOLVED_PERSISTED_QUERIES_ID;
            },
        },
        load: {
            filter: {
                id: { include: /^\0virtual:crucible\/persisted-queries$/ },
            },
            handler() {
                // Read from the consuming app's persisted-queries.json.
                // relay-compiler writes it; preflight seeds an empty `{}` if
                // it doesn't exist yet.
                const path = join(appRoot, "persisted-queries.json");
                try {
                    if (!existsSync(path)) return "export default {};";
                    const text = readFileSync(path, "utf8");
                    return `export default ${text};`;
                } catch {
                    return "export default {};";
                }
            },
        },
        config() {
            const manifestConfig = loadManifestConfig();
            const resolvedPwa = manifestConfig ? resolvePWA(manifestConfig) : null;
            // Expose build-time URL constants the AppShell reads. Both are null
            // when PWA isn't configured, so AppShell skips registering a SW and
            // skips emitting a `<link rel="manifest">` that would 404.
            //
            // CRUCIBLE_SCHEMA_HASH is a content hash of `schema.graphql` —
            // included in the Relay store cache key so a deploy that changes
            // the schema invalidates stale records (which would otherwise crash
            // returning users when a removed/renamed field is read from cache).
            return {
                define: {
                    "import.meta.env.CRUCIBLE_SW_URL": JSON.stringify(
                        resolvedPwa ? "/sw.js" : null,
                    ),
                    "import.meta.env.CRUCIBLE_MANIFEST_URL": JSON.stringify(
                        resolvedPwa ? "/manifest.webmanifest" : null,
                    ),
                    "import.meta.env.CRUCIBLE_SCHEMA_HASH": JSON.stringify(
                        computeSchemaHash(appRoot),
                    ),
                    "import.meta.env.CRUCIBLE_REACT_VIEW_TRANSITIONS": JSON.stringify(
                        options.experimental?.reactViewTransitions === true,
                    ),
                },
            };
        },
        configResolved(config) {
            // appRoot is the user-source root (where src/app/ lives). Vite's
            // own `config.root` may point at `.crucible/` (so the generated
            // index.html is the served entry); we DON'T want that as appRoot.
            // Explicit `options.appRoot` wins; otherwise default to cwd.
            appRoot = options.appRoot ?? process.cwd();
            void config;
            const manifestConfig = loadManifestConfig();
            pwa = manifestConfig ? resolvePWA(manifestConfig) : null;
            if (pwa) writeManifestFile(appRoot, pwa);
        },
        buildStart() {
            regen("buildStart");
            const manifestConfig = loadManifestConfig();
            pwa = manifestConfig ? resolvePWA(manifestConfig) : null;
            if (pwa) writeManifestFile(appRoot, pwa);
        },
        transformIndexHtml() {
            if (!pwa) return;
            return pwa.htmlInjections.map((entry) => ({
                tag: entry.tag,
                attrs: entry.attrs,
                injectTo: "head" as const,
            }));
        },
        transform(code, id) {
            let next = code;

            if (id.endsWith(".css") && /@import\s+["']tailwindcss["']/.test(next)) {
                const srcDir = join(appRoot, "src");
                const fromCssFile = relative(dirname(id), srcDir)
                    .split(sep)
                    .join("/");
                next +=
                    `\n/* injected by crucible: ensure src/ is in Tailwind's content scope */\n@source "${fromCssFile}/**/*.{ts,tsx,js,jsx,html}";\n`;
            }

            if (isAppPageModule(id, appRoot)) {
                // Keep the authoring contract (`export const query = graphql...`)
                // for Crucible codegen, but don't expose `query` at runtime.
                // Vite React Refresh treats non-component exports as refresh
                // boundary hazards; the page component only needs the local
                // binding for `usePreloadedQuery(query, data)`.
                next = stripPageQueryExport(next);
            }

            if (isRelayGeneratedArtifact(id)) {
                // Relay emits TS-only resolver implementation assertions like:
                //   (fooResolverType satisfies (...) => ...);
                // esbuild strips `import type`, but `satisfies` compiles to a
                // runtime identifier read, causing `ReferenceError` in the
                // browser. The assertions are compile-time only and safe to
                // remove before Vite transpiles the artifact.
                next = stripRelayResolverTypeAssertions(next);
            }

            return next === code ? null : { code: next, map: null };
        },
        generateBundle(_options, bundle) {
            if (!pwa) return;
            const entries: { filename: string; size: number }[] = [];
            const assetUrls: string[] = [];
            for (const key of Object.keys(bundle)) {
                if (!shouldPrecache(key)) continue;
                const item = bundle[key]!;
                const size =
                    item.type === "asset"
                        ? typeof item.source === "string"
                            ? item.source.length
                            : item.source.byteLength
                        : item.code.length;
                entries.push({ filename: key, size });
                assetUrls.push("/" + key);
            }
            // Always include the app shell at /index.html so navigations can fall
            // back to it offline.
            assetUrls.push("/index.html");
            entries.push({ filename: "index.html", size: 0 });

            const version = computeAssetVersion(entries);
            const source = generateSwSource(version, assetUrls);
            this.emitFile({ type: "asset", fileName: "sw.js", source });
            console.log(`[crucible] generated sw.js (version ${version}).`);
        },
        configureServer(server: ViteDevServer) {
            const appDir = join(appRoot, "src", "app");
            const manifestPath = join(appRoot, "src", "app", "manifest.ts");
            const configPath = join(appRoot, "src", "app", "crucible.config.ts");
            const persistedQueriesPath = join(
                appRoot,
                "persisted-queries.json",
            );
            server.watcher.add(appDir);
            server.watcher.add(persistedQueriesPath);

            // Persisted-queries.json is rewritten by `bun run codegen` (or any
            // standalone relay-compiler run). Without this, the virtual
            // module that bundles it stays cached at boot-time content, and
            // any newly-emitted operation hash 404s with
            // "No operation text or persisted query for X".
            const onPersistedQueriesChange = () => {
                const mod = server.moduleGraph.getModuleById(
                    RESOLVED_PERSISTED_QUERIES_ID,
                );
                if (mod) {
                    server.moduleGraph.invalidateModule(mod);
                    // Reload — the runtime imports the map at boot, not via HMR
                    // boundaries, so a full reload is the correct invalidation.
                    server.ws.send({ type: "full-reload" });
                }
            };

            // Structural changes (file added / removed) need codegen to
            // regenerate the routes manifest, and the page can't HMR through
            // a route-table change cleanly — so we full-reload. Plain content
            // edits go through Vite's normal HMR pipeline so React Fast
            // Refresh AND `@tailwindcss/vite`'s class-extraction can do their
            // thing — sending `full-reload` here would short-circuit them.
            const onStructural = (file: string) => {
                if (!file.startsWith(appDir)) return;
                if (!/\.(tsx|ts|graphql)$/.test(file)) return;
                if (file === manifestPath) {
                    const refreshed = loadManifestConfig();
                    if (refreshed) {
                        pwa = resolvePWA(refreshed);
                        writeManifestFile(appRoot, pwa);
                    }
                }
                regen("watch");
                server.ws.send({ type: "full-reload" });
            };
            const onContentChange = (file: string) => {
                if (file === persistedQueriesPath) {
                    onPersistedQueriesChange();
                    return;
                }
                if (!file.startsWith(appDir)) return;
                if (!/\.(tsx|ts|graphql)$/.test(file)) return;
                if (file === configPath) {
                    regen("config-change");
                    server.ws.send({ type: "full-reload" });
                    return;
                }
                if (file.endsWith(`${sep}page.tsx`) || file.endsWith(`${sep}default.tsx`)) {
                    regen("page-change");
                    server.ws.send({ type: "full-reload" });
                    return;
                }
                // Manifest file content changes still need a refresh.
                if (file === manifestPath) {
                    const refreshed = loadManifestConfig();
                    if (refreshed) {
                        pwa = resolvePWA(refreshed);
                        writeManifestFile(appRoot, pwa);
                    }
                    server.ws.send({ type: "full-reload" });
                }
                // Don't full-reload for plain content edits — Vite + Tailwind
                // + Fast Refresh handle the update natively.
            };
            server.watcher.on("add", onStructural);
            server.watcher.on("unlink", onStructural);
            server.watcher.on("change", onContentChange);

            // In dev, serve a no-op SW so registration doesn't 404 if the user
            // tests `<AppShell serviceWorker>` against the dev server. The
            // activate handler immediately calls `self.registration.unregister()`
            // so a stale dev SW never persists between branch switches — when
            // the user runs `bun dev` on a branch that uses a different SW
            // (or removes the PWA entirely), the prior dev SW tears itself
            // down on the next page load. Cache-Control: no-cache pairs with
            // the runtime's `updateViaCache: 'none'` to keep the dev SW
            // discovery loop tight.
            server.middlewares.use("/sw.js", (req, res, next) => {
                if (req.method !== "GET") return next();
                res.setHeader("Content-Type", "application/javascript");
                res.setHeader(
                    "Cache-Control",
                    "no-cache, no-store, must-revalidate",
                );
                res.end(
                    "/* dev no-op service worker */\n" +
                        "self.addEventListener('install', () => self.skipWaiting());\n" +
                        "self.addEventListener('activate', (e) => {\n" +
                        "  e.waitUntil((async () => {\n" +
                        "    await self.clients.claim();\n" +
                        "    await self.registration.unregister();\n" +
                        "  })());\n" +
                        "});\n",
                );
            });
        },
    };
}
