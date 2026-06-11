import { test, expect, describe, mock } from "bun:test";
import vm from "node:vm";
import { computeAssetVersion, generateSwSource, shouldPrecache } from "./sw.ts";
import { resolvePWA } from "./pwa.ts";

describe("computeAssetVersion", () => {
    test("identical input produces identical version", () => {
        const a = computeAssetVersion([
            { filename: "index.js", size: 1234 },
            { filename: "main.css", size: 89 },
        ]);
        const b = computeAssetVersion([
            { filename: "main.css", size: 89 },
            { filename: "index.js", size: 1234 },
        ]);
        expect(a).toBe(b);
    });

    test("changed file size produces a different version", () => {
        const a = computeAssetVersion([{ filename: "index.js", size: 1234 }]);
        const b = computeAssetVersion([{ filename: "index.js", size: 1235 }]);
        expect(a).not.toBe(b);
    });

    test("changed filename produces a different version", () => {
        const a = computeAssetVersion([
            { filename: "index.abc.js", size: 100 },
        ]);
        const b = computeAssetVersion([
            { filename: "index.def.js", size: 100 },
        ]);
        expect(a).not.toBe(b);
    });

    test("output is a stable 8-char hex string", () => {
        const v = computeAssetVersion([{ filename: "x.js", size: 10 }]);
        expect(v).toMatch(/^[0-9a-f]{8}$/);
    });
});

describe("generateSwSource", () => {
    test("inlines version + asset list verbatim", () => {
        const sw = generateSwSource("abcd1234", ["/index.js", "/main.css"]);
        expect(sw).toContain('"abcd1234"');
        expect(sw).toContain('"/index.js"');
        expect(sw).toContain('"/main.css"');
    });

    test("emitted SW registers install/activate/fetch handlers", () => {
        const sw = generateSwSource("v", []);
        expect(sw).toContain("addEventListener");
        expect(sw).toMatch(/install/);
        expect(sw).toMatch(/activate/);
        expect(sw).toMatch(/fetch/);
    });

    test("activate handler clears outdated crucible caches", () => {
        const sw = generateSwSource("v", []);
        expect(sw).toContain("crucible-");
        expect(sw).toContain("caches.delete");
    });
});

describe("shouldPrecache", () => {
    test("excludes the SW itself", () => {
        expect(shouldPrecache("sw.js")).toBe(false);
    });
    test("excludes sourcemaps", () => {
        expect(shouldPrecache("index.js.map")).toBe(false);
    });
    test("excludes the manifest (served pass-through)", () => {
        expect(shouldPrecache("manifest.webmanifest")).toBe(false);
    });
    test("includes hashed JS/CSS chunks", () => {
        expect(shouldPrecache("assets/index-DEADBEEF.js")).toBe(true);
        expect(shouldPrecache("assets/main-CAFEFACE.css")).toBe(true);
    });
});

describe("resolvePWA — manifest generation", () => {
    test("emits a webmanifest with required fields", () => {
        const r = resolvePWA({
            name: "Crucible",
            themeColor: "#000000",
            backgroundColor: "#ffffff",
            icons: [{ src: "/icon.png", sizes: "192x192" }],
        });
        const m = JSON.parse(r.manifestJson);
        expect(m.name).toBe("Crucible");
        expect(m.short_name).toBe("Crucible");
        expect(m.theme_color).toBe("#000000");
        expect(m.background_color).toBe("#ffffff");
        expect(m.display).toBe("standalone");
        expect(m.start_url).toBe("/");
        expect(m.scope).toBe("/");
    });

    test("shortName overrides name when set", () => {
        const r = resolvePWA({
            name: "Crucible App",
            shortName: "Crucible",
            themeColor: "#000000",
            backgroundColor: "#ffffff",
            icons: [],
        });
        expect(JSON.parse(r.manifestJson).short_name).toBe("Crucible");
    });

    test("infers icon type from extension", () => {
        const r = resolvePWA({
            name: "x",
            themeColor: "#000000",
            backgroundColor: "#ffffff",
            icons: [
                { src: "/icon.png", sizes: "192x192" },
                { src: "/icon.svg", sizes: "any" },
                { src: "/icon.webp", sizes: "512x512" },
            ],
        });
        const m = JSON.parse(r.manifestJson);
        expect(m.icons[0].type).toBe("image/png");
        expect(m.icons[1].type).toBe("image/svg+xml");
        expect(m.icons[2].type).toBe("image/webp");
    });

    test("picks 180x180 icon as apple-touch-icon when present", () => {
        const r = resolvePWA({
            name: "x",
            themeColor: "#000000",
            backgroundColor: "#ffffff",
            icons: [
                { src: "/icon-192.png", sizes: "192x192" },
                { src: "/icon-180.png", sizes: "180x180" },
                { src: "/icon-512.png", sizes: "512x512" },
            ],
        });
        expect(r.appleTouchIcon).toBe("/icon-180.png");
    });

    test("falls back to first ≥180x180 icon when no exact 180 exists", () => {
        const r = resolvePWA({
            name: "x",
            themeColor: "#000000",
            backgroundColor: "#ffffff",
            icons: [
                { src: "/icon-128.png", sizes: "128x128" },
                { src: "/icon-256.png", sizes: "256x256" },
            ],
        });
        expect(r.appleTouchIcon).toBe("/icon-256.png");
    });

    test("htmlInjections always includes the manifest link", () => {
        const r = resolvePWA({
            name: "x",
            themeColor: "#000000",
            backgroundColor: "#ffffff",
            icons: [],
        });
        const manifestLink = r.htmlInjections.find(
            (t) => t.attrs.rel === "manifest",
        );
        expect(manifestLink).toBeDefined();
        expect(manifestLink!.attrs.href).toBe("/manifest.webmanifest");
    });

    test("skips maskable icons from <link rel='icon'> injections (only `any`)", () => {
        const r = resolvePWA({
            name: "x",
            themeColor: "#000000",
            backgroundColor: "#ffffff",
            icons: [
                { src: "/icon.png", sizes: "192x192" },
                {
                    src: "/icon-mask.png",
                    sizes: "512x512",
                    purpose: "maskable",
                },
            ],
        });
        const iconLinks = r.htmlInjections.filter(
            (t) => t.attrs.rel === "icon",
        );
        expect(iconLinks).toHaveLength(1);
        expect(iconLinks[0]!.attrs.href).toBe("/icon.png");
    });
});

// ---------------------------------------------------------------------------
// SW lifecycle — VM harness
//
// Evaluates the generated SW source string in a vm.createContext with stubbed
// SW globals (self, caches, fetch, URL). Captures the install/activate/fetch/
// message handlers on `self.addEventListener` and invokes them directly to
// verify the lifecycle.
// ---------------------------------------------------------------------------

type EventLike = { waitUntil?: (p: Promise<unknown>) => void };

type CacheStub = {
    addAll: ReturnType<typeof mock>;
    put: ReturnType<typeof mock>;
    match: ReturnType<typeof mock>;
};

function makeCachesStub(): {
    caches: {
        open: ReturnType<typeof mock>;
        keys: ReturnType<typeof mock>;
        match: ReturnType<typeof mock>;
        delete: ReturnType<typeof mock>;
    };
    cacheStub: CacheStub;
    setCacheKeys: (keys: string[]) => void;
    setMatchResponse: (req: unknown, res: unknown) => void;
} {
    const cacheStub: CacheStub = {
        addAll: mock(async (_urls: string[]) => {}),
        put: mock(async (_req: unknown, _res: unknown) => {}),
        match: mock(async (_req: unknown) => undefined),
    };
    let cacheKeys: string[] = [];
    const matchTable = new Map<string, unknown>();
    const caches = {
        open: mock(async (_name: string) => cacheStub),
        keys: mock(async () => cacheKeys),
        match: mock(async (req: unknown) => {
            const key =
                typeof req === "string"
                    ? req
                    : ((req as { url?: string }).url ?? "");
            return matchTable.get(key);
        }),
        delete: mock(async (_name: string) => true),
    };
    return {
        caches,
        cacheStub,
        setCacheKeys: (keys) => {
            cacheKeys = keys;
        },
        setMatchResponse: (req, res) => {
            const key =
                typeof req === "string"
                    ? req
                    : ((req as { url?: string }).url ?? "");
            matchTable.set(key, res);
        },
    };
}

function evalSwSource(source: string) {
    const handlers: Record<string, (e: EventLike) => void | Promise<void>> = {};
    const self_ = {
        addEventListener: (
            event: string,
            cb: (e: EventLike) => void | Promise<void>,
        ) => {
            handlers[event] = cb;
        },
        skipWaiting: mock(async () => {}),
        clients: { claim: mock(async () => {}) },
        location: { origin: "https://app.test" },
        registration: { unregister: mock(async () => true) },
    };
    const cachesHarness = makeCachesStub();
    const fetchMock = mock(async (_req: unknown) => ({
        status: 200,
        type: "basic",
        clone: () => ({ status: 200, type: "basic" }),
    }));
    const ctx = vm.createContext({
        self: self_,
        caches: cachesHarness.caches,
        fetch: fetchMock,
        URL,
    });
    vm.runInContext(source, ctx);
    return { handlers, self: self_, ...cachesHarness, fetch: fetchMock };
}

describe("SW lifecycle — install (deferred skipWaiting)", () => {
    test("install handler precaches the asset list", async () => {
        const sw = evalSwSource(
            generateSwSource("v1", ["/index.html", "/assets/main.js"]),
        );
        let waited: Promise<unknown> | null = null;
        await sw.handlers.install?.({ waitUntil: (p) => (waited = p) });
        await waited;
        expect(sw.caches.open).toHaveBeenCalledWith("crucible-v1");
        expect(sw.cacheStub.addAll).toHaveBeenCalledWith([
            "/index.html",
            "/assets/main.js",
        ]);
    });

    test("install handler does NOT call skipWaiting() (deferred activation)", async () => {
        const sw = evalSwSource(generateSwSource("v1", []));
        let waited: Promise<unknown> | null = null;
        await sw.handlers.install?.({ waitUntil: (p) => (waited = p) });
        await waited;
        expect(sw.self.skipWaiting).not.toHaveBeenCalled();
    });
});

describe("SW lifecycle — activate", () => {
    test("activate handler purges prior crucible-* caches", async () => {
        const sw = evalSwSource(generateSwSource("v2", []));
        sw.setCacheKeys(["crucible-v1", "crucible-v2", "other-app-cache"]);
        let waited: Promise<unknown> | null = null;
        await sw.handlers.activate?.({ waitUntil: (p) => (waited = p) });
        await waited;
        // Only the prior crucible-v1 should be deleted; the current cache
        // and unrelated caches are kept.
        expect(sw.caches.delete).toHaveBeenCalledTimes(1);
        expect(sw.caches.delete).toHaveBeenCalledWith("crucible-v1");
        expect(sw.self.clients.claim).toHaveBeenCalledTimes(1);
    });
});

describe("SW lifecycle — fetch handler", () => {
    function makeReq(input: {
        url: string;
        method?: string;
        mode?: RequestMode;
    }): Request {
        return {
            url: input.url,
            method: input.method ?? "GET",
            mode: input.mode ?? ("cors" as RequestMode),
        } as unknown as Request;
    }

    function makeFetchEvent(req: Request): {
        request: Request;
        respondWith: ReturnType<typeof mock>;
        _response: Promise<unknown> | null;
    } {
        let captured: Promise<unknown> | null = null;
        return {
            request: req,
            respondWith: mock((p: Promise<unknown>) => {
                captured = p;
            }),
            get _response() {
                return captured;
            },
        };
    }

    test("non-GET requests pass through (browser handles)", () => {
        const sw = evalSwSource(generateSwSource("v1", []));
        const ev = makeFetchEvent(
            makeReq({ url: "https://app.test/api/foo", method: "POST" }),
        );
        sw.handlers.fetch?.(ev as unknown as EventLike);
        expect(ev.respondWith).not.toHaveBeenCalled();
    });

    test("cross-origin requests pass through", () => {
        const sw = evalSwSource(generateSwSource("v1", []));
        const ev = makeFetchEvent(makeReq({ url: "https://other.example/x" }));
        sw.handlers.fetch?.(ev as unknown as EventLike);
        expect(ev.respondWith).not.toHaveBeenCalled();
    });

    test("navigation requests: network-first, /index.html fallback", async () => {
        const sw = evalSwSource(generateSwSource("v1", ["/index.html"]));
        const ev = makeFetchEvent(
            makeReq({ url: "https://app.test/orders/1", mode: "navigate" }),
        );
        sw.handlers.fetch?.(ev as unknown as EventLike);
        expect(ev.respondWith).toHaveBeenCalledTimes(1);
        // Network-first: fetch is called; if it succeeds, that response wins.
        await ev._response;
        expect(sw.fetch).toHaveBeenCalledTimes(1);
    });

    test("/assets/<hash>.js: cache-first, populates on miss", async () => {
        const sw = evalSwSource(generateSwSource("v1", []));
        const ev = makeFetchEvent(
            makeReq({ url: "https://app.test/assets/index-DEADBEEF.js" }),
        );
        sw.handlers.fetch?.(ev as unknown as EventLike);
        expect(ev.respondWith).toHaveBeenCalledTimes(1);
        await ev._response;
        expect(sw.fetch).toHaveBeenCalledTimes(1);
        // Cache miss → cache.put called with the fetched response.
        expect(sw.cacheStub.put).toHaveBeenCalledTimes(1);
    });

    test("non-/assets/ same-origin GET: fetched but NOT cached (P2-A filter)", async () => {
        const sw = evalSwSource(generateSwSource("v1", []));
        const ev = makeFetchEvent(
            makeReq({ url: "https://app.test/api/orders/list" }),
        );
        sw.handlers.fetch?.(ev as unknown as EventLike);
        expect(ev.respondWith).toHaveBeenCalledTimes(1);
        await ev._response;
        expect(sw.fetch).toHaveBeenCalledTimes(1);
        // The new filter blocks cache.put for non-/assets/ paths.
        expect(sw.cacheStub.put).not.toHaveBeenCalled();
    });
});

describe("SW lifecycle — message handler", () => {
    test("crucible:skip-waiting message triggers skipWaiting()", () => {
        const sw = evalSwSource(generateSwSource("v1", []));
        sw.handlers.message?.({
            data: "crucible:skip-waiting",
        } as unknown as EventLike);
        expect(sw.self.skipWaiting).toHaveBeenCalledTimes(1);
    });

    test("unrelated messages do NOT trigger skipWaiting()", () => {
        const sw = evalSwSource(generateSwSource("v1", []));
        sw.handlers.message?.({
            data: "something-else",
        } as unknown as EventLike);
        expect(sw.self.skipWaiting).not.toHaveBeenCalled();
    });
});

describe("computeAssetVersion — adversarial inputs", () => {
    // The asset version is the SW cache-bust key. A regression that
    // makes it order-sensitive or collision-prone causes silent stale
    // bundles for users on a deploy where assets reordered but content
    // was the same — never fixed without a hard reload.

    test("identical entries in different orders → identical hash", () => {
        const a = [
            { filename: "main.js", size: 1234 },
            { filename: "vendor.js", size: 56789 },
            { filename: "style.css", size: 4321 },
        ];
        const b = [...a].reverse();
        const c = [...a].sort(() => Math.random() - 0.5);
        expect(computeAssetVersion(a)).toBe(computeAssetVersion(b));
        expect(computeAssetVersion(a)).toBe(computeAssetVersion(c));
    });

    test("a single-byte size change anywhere in the list bumps the hash", () => {
        const before = computeAssetVersion([
            { filename: "x.js", size: 100 },
            { filename: "y.js", size: 200 },
        ]);
        const after = computeAssetVersion([
            { filename: "x.js", size: 100 },
            { filename: "y.js", size: 201 },
        ]);
        expect(before).not.toBe(after);
    });

    test("10k-entry list hashes in linear time + valid 8-hex output", () => {
        const huge = Array.from({ length: 10_000 }, (_, i) => ({
            filename: `chunk-${i}.js`,
            size: i,
        }));
        const start = Date.now();
        const v = computeAssetVersion(huge);
        expect(v).toMatch(/^[0-9a-f]{8}$/);
        expect(Date.now() - start).toBeLessThan(500);
    });

    test("empty list still produces a stable hex hash", () => {
        expect(computeAssetVersion([])).toMatch(/^[0-9a-f]{8}$/);
    });
});

describe("resolvePWA — edge-case icon configs", () => {
    test("zero icons: produces only the manifest <link>, no icon tags", () => {
        const r = resolvePWA({
            name: "App",
            themeColor: "#ffffff",
            backgroundColor: "#000000",
            icons: [],
        });
        expect(r.appleTouchIcon).toBeUndefined();
        expect(r.htmlInjections.length).toBe(1);
        expect(r.htmlInjections[0]?.attrs.rel).toBe("manifest");
    });

    test("only maskable icons: no <link rel='icon'> emitted", () => {
        // Maskable icons would clip horribly if used as a favicon, so
        // they go in the manifest array but NOT into <link rel="icon">.
        const r = resolvePWA({
            name: "App",
            themeColor: "#ffffff",
            backgroundColor: "#000",
            icons: [
                { src: "/192.png", sizes: "192x192", purpose: "maskable" },
                { src: "/512.png", sizes: "512x512", purpose: "maskable" },
            ],
        });
        const iconLinks = r.htmlInjections.filter(
            (l) => l.attrs.rel === "icon",
        );
        expect(iconLinks.length).toBe(0);
    });

    test("malformed sizes string: doesn't crash; no apple-touch picked", () => {
        const r = resolvePWA({
            name: "App",
            themeColor: "#ffffff",
            backgroundColor: "#000",
            icons: [
                { src: "/x.png", sizes: "garbage" },
                { src: "/y.png", sizes: "" },
                { src: "/z.png", sizes: "192" },
            ],
        });
        // findAppleTouchIcon's sideLength regex returns 0 for bad input;
        // no icon ≥180 → no apple-touch-icon injected.
        expect(r.appleTouchIcon).toBeUndefined();
    });

    test("unknown icon extension defaults to image/png type", () => {
        const r = resolvePWA({
            name: "App",
            themeColor: "#ffffff",
            backgroundColor: "#000",
            icons: [{ src: "/icon.weird", sizes: "192x192" }],
        });
        const m = JSON.parse(r.manifestJson);
        expect(m.icons[0].type).toBe("image/png");
    });
});
