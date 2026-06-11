import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { scanRoutes, scanServerRoutes } from "./scan.ts";
import { parsePage } from "./parse.ts";
import {
    emitAll,
    emitMainEntry,
    emitServerRoutes,
    DEFAULT_CRUCIBLE_SPECIFIER,
    type EmitContext,
    type RouteWithPage,
} from "./emit.ts";
import {
    emitIndexHtml,
    extractRootLayoutBackgroundColor,
    extractRootLayoutThemeColor,
    extractRootLayoutTitle,
    installCodegenGlobals,
    type ThemeStorage,
} from "./index-html.ts";

export type CodegenOptions = {
    appRoot: string;
    // npm specifier for the crucible package, embedded into generated
    // import statements. Defaults to "react-crucible". Set this when the
    // package is published or aliased under a different name.
    crucibleSpecifier?: string;
    // Extra origins to append to the emitted index.html's CSP `connect-src`
    // directive, on top of the default `'self' ws: wss:`.
    connectSrcAllowlist?: ReadonlyArray<string>;
    // Theme storage convention used by the boot-theme script when the
    // consumer's root-layout metadata declares a dual-form
    // `backgroundColor: { light, dark }`. Defaults to `{ storageKey:
    // "theme", attribute: "class" }` which matches next-themes default
    // storage key + the shadcn/Tailwind v4 `.dark` class convention.
    // Apps using a different storage key (e.g. shadcn's hand-rolled
    // provider's `"vite-ui-theme"`) override here.
    themeStorage?: ThemeStorage;
};

// Async codegen runs ONLY from the CLI (under Bun, where dynamic-importing
// .ts files works). It produces JSON snapshots in `.crucible/_internal/`
// that the Vite plugin then reads at any runtime — Node, Bun, whatever
// `vp dev` / `concurrently` end up using internally.
export async function runCodegenAsync(
    opts: CodegenOptions,
): Promise<{ routeCount: number }> {
    const result = runCodegen(opts);
    await emitManifestSnapshot(opts.appRoot);
    await emitIndexHtml({
        appRoot: opts.appRoot,
        fallbackTitle: extractRootLayoutTitle(opts.appRoot),
        fallbackThemeColor: extractRootLayoutThemeColor(opts.appRoot),
        fallbackBackgroundColor: extractRootLayoutBackgroundColor(opts.appRoot),
        themeStorage: opts.themeStorage,
        connectSrcAllowlist: opts.connectSrcAllowlist,
    });
    return result;
}

// Resolves `src/app/manifest.ts` (if present) and writes the resolved
// config to `.crucible/_internal/manifest.json`. The plugin reads that
// JSON synchronously — no .ts evaluation in any non-Bun runtime.
async function emitManifestSnapshot(appRoot: string): Promise<void> {
    const manifestPath = join(appRoot, "src", "app", "manifest.ts");
    const out = join(appRoot, ".crucible", "_internal", "manifest.json");
    mkdirSync(join(appRoot, ".crucible", "_internal"), { recursive: true });

    if (!existsSync(manifestPath)) {
        writeFileSync(out, "null\n", "utf8");
        return;
    }
    installCodegenGlobals();
    try {
        const mod = await import(
            `${pathToFileURL(manifestPath).href}?t=${Date.now()}`
        );
        const fn = mod.default;
        const value = typeof fn === "function" ? await fn() : fn;
        if (!value || typeof value !== "object") {
            writeFileSync(out, "null\n", "utf8");
            return;
        }
        writeFileSync(out, JSON.stringify(value, null, 2) + "\n", "utf8");
    } catch (err) {
        console.error(`[crucible] failed to evaluate ${manifestPath}:`, err);
        writeFileSync(out, "null\n", "utf8");
    }
}

export function runCodegen(opts: CodegenOptions): { routeCount: number } {
    const ctx: EmitContext = {
        appRoot: opts.appRoot,
        outDir: join(opts.appRoot, ".crucible"),
        crucibleSpecifier: opts.crucibleSpecifier ?? DEFAULT_CRUCIBLE_SPECIFIER,
    };
    const appDir = join(opts.appRoot, "src", "app");
    const discovered = scanRoutes(appDir);
    const routes: RouteWithPage[] = discovered.map((route) => ({
        route,
        parsed: parsePage(route.pageFile),
    }));
    emitAll(ctx, routes);

    // Emit `.crucible/server-routes.ts` — a Hono router that mounts
    // every `route.ts` file under `src/app/`. The user's `server.ts`
    // imports it (or doesn't, if they ship SPA-only). Empty when no
    // route.ts files exist; the file is always emitted so server.ts's
    // import resolves either way.
    const serverRoutes = scanServerRoutes(appDir);
    emitServerRoutes(ctx, serverRoutes);

    // Generate `.crucible/main.tsx` so user code never has to wire up
    // createRoot / StrictMode / AppShell / environment. App-wide overrides
    // (theme color, default title, etc.) come from the root layout's
    // metadata export.
    emitMainEntry(ctx);

    // Vite imports persisted-queries.json statically. relay-compiler only
    // writes the file when the project actually contains operations, so seed
    // an empty map so the first build (no queries yet) still resolves.
    const persisted = join(opts.appRoot, "persisted-queries.json");
    if (!existsSync(persisted)) {
        writeFileSync(persisted, "{}\n", "utf8");
    }

    return { routeCount: routes.length };
}
