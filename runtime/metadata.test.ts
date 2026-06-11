import { test, expect, describe } from "bun:test";
import {
    mergeMetadata,
    type Metadata,
    type MetadataDefaults,
} from "./metadata.tsx";

const DEFAULTS: MetadataDefaults = {
    themeColor: "#000000",
    backgroundColor: "#ffffff",
    statusBarStyle: "default",
    manifest: "/manifest.webmanifest",
    defaultTitle: "App",
};

describe("mergeMetadata — title", () => {
    test("no layers → defaultTitle", () => {
        expect(mergeMetadata(DEFAULTS, []).title).toBe("App");
    });

    test("string title overrides default", () => {
        expect(mergeMetadata(DEFAULTS, [{ title: "Home" }]).title).toBe("Home");
    });

    test("template applied to descendant string title", () => {
        const layers: Metadata[] = [
            { title: { template: "%s · App", default: "Welcome" } },
            { title: "Orders" },
        ];
        expect(mergeMetadata(DEFAULTS, layers).title).toBe("Orders · App");
    });

    test("template with no descendant uses its default", () => {
        // When the defaults' title is itself a TitleTemplate (no string title
        // ever set), an inner template's `default` fills its own slot.
        const d: MetadataDefaults = {
            ...DEFAULTS,
            defaultTitle: { template: "%s", default: "X" },
        };
        const layers: Metadata[] = [
            { title: { template: "%s · App", default: "Welcome" } },
        ];
        expect(mergeMetadata(d, layers).title).toBe("Welcome · App");
    });

    test("string defaultTitle fills a descendant template's slot", () => {
        // Documented behavior: the resolver treats every string title (including
        // the defaults') as "the slot text". An inner template applies to it.
        const layers: Metadata[] = [
            { title: { template: "%s · App", default: "Welcome" } },
        ];
        expect(mergeMetadata(DEFAULTS, layers).title).toBe("App · App");
    });

    test("inner template wins over outer template", () => {
        const layers: Metadata[] = [
            { title: { template: "%s · App", default: "X" } },
            { title: { template: "[%s]", default: "Y" } },
            { title: "Inner" },
        ];
        expect(mergeMetadata(DEFAULTS, layers).title).toBe("[Inner]");
    });
});

describe("mergeMetadata — colors and statusbar", () => {
    test("themeColor overrides default", () => {
        expect(
            mergeMetadata(DEFAULTS, [{ themeColor: "#ff0000" }]).themeColor,
        ).toBe("#ff0000");
    });

    test("inner layer wins", () => {
        const layers: Metadata[] = [
            { themeColor: "#aaaaaa" },
            { themeColor: "#bbbbbb" },
        ];
        expect(mergeMetadata(DEFAULTS, layers).themeColor).toBe("#bbbbbb");
    });

    test("backgroundColor and statusBarStyle merge independently", () => {
        const layers: Metadata[] = [
            { backgroundColor: "#222222" },
            { statusBarStyle: "black-translucent" },
        ];
        const r = mergeMetadata(DEFAULTS, layers);
        expect(r.backgroundColor).toBe("#222222");
        expect(r.statusBarStyle).toBe("black-translucent");
    });
});

describe("mergeMetadata — Open Graph", () => {
    test("layers shallow-merge OG fields", () => {
        const layers: Metadata[] = [
            { openGraph: { title: "Outer", siteName: "Crucible" } },
            { openGraph: { title: "Inner", description: "Sale" } },
        ];
        const og = mergeMetadata(DEFAULTS, layers).openGraph;
        expect(og.title).toBe("Inner");
        expect(og.siteName).toBe("Crucible");
        expect(og.description).toBe("Sale");
    });

    test("no layers → empty OG object", () => {
        expect(mergeMetadata(DEFAULTS, []).openGraph).toEqual({});
    });
});

describe("mergeMetadata — Twitter", () => {
    test("layers shallow-merge Twitter fields", () => {
        const layers: Metadata[] = [
            { twitter: { card: "summary", site: "@Crucible" } },
            { twitter: { card: "summary_large_image" } },
        ];
        const t = mergeMetadata(DEFAULTS, layers).twitter;
        expect(t.card).toBe("summary_large_image");
        expect(t.site).toBe("@Crucible");
    });
});

describe("mergeMetadata — robots", () => {
    test("undefined → undefined", () => {
        expect(mergeMetadata(DEFAULTS, []).robots).toBeUndefined();
    });
    test("true → 'index, follow'", () => {
        expect(mergeMetadata(DEFAULTS, [{ robots: true }]).robots).toBe(
            "index, follow",
        );
    });
    test("false → 'noindex, nofollow'", () => {
        expect(mergeMetadata(DEFAULTS, [{ robots: false }]).robots).toBe(
            "noindex, nofollow",
        );
    });
    test("string used verbatim", () => {
        expect(
            mergeMetadata(DEFAULTS, [{ robots: "noindex, max-snippet:-1" }])
                .robots,
        ).toBe("noindex, max-snippet:-1");
    });
    test("inner overrides outer", () => {
        const layers: Metadata[] = [{ robots: false }, { robots: true }];
        expect(mergeMetadata(DEFAULTS, layers).robots).toBe("index, follow");
    });
});

describe("mergeMetadata — other / manifest", () => {
    test("other entries concat across layers", () => {
        const layers: Metadata[] = [
            { other: [{ name: "a", content: "1" }] },
            { other: [{ name: "b", content: "2" }] },
        ];
        expect(mergeMetadata(DEFAULTS, layers).other).toEqual([
            { name: "a", content: "1" },
            { name: "b", content: "2" },
        ]);
    });

    test("missing other does NOT allocate a new array (stable empty)", () => {
        const r1 = mergeMetadata(DEFAULTS, []);
        const r2 = mergeMetadata(DEFAULTS, []);
        expect(r1.other).toBe(r2.other); // same reference
    });

    test("manifest:false hides the link", () => {
        expect(mergeMetadata(DEFAULTS, [{ manifest: false }]).manifest).toBe(
            false,
        );
    });

    test("description bubbles through", () => {
        expect(
            mergeMetadata(DEFAULTS, [{ description: "hi" }]).description,
        ).toBe("hi");
    });
});
