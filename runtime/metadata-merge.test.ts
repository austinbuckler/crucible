import { test, expect, describe } from "bun:test";
import {
    mergeMetadata,
    type Metadata,
    type MetadataDefaults,
} from "./metadata.tsx";

const baseDefaults: MetadataDefaults = {
    themeColor: "#ffffff",
    backgroundColor: "#ffffff",
    statusBarStyle: "black-translucent",
    manifest: false,
    defaultTitle: "Crucible",
};

describe("mergeMetadata title resolution", () => {
    test("uses defaults.defaultTitle when no layer sets one", () => {
        const result = mergeMetadata(baseDefaults, []);
        expect(result.title).toBe("Crucible");
    });

    test("layer string title overrides default", () => {
        const result = mergeMetadata(baseDefaults, [{ title: "Settings" }]);
        expect(result.title).toBe("Settings");
    });

    test("inner layer string title wins over outer layer string", () => {
        const result = mergeMetadata(baseDefaults, [
            { title: "Outer" },
            { title: "Inner" },
        ]);
        expect(result.title).toBe("Inner");
    });

    test("default template + descendant string slots into template", () => {
        const defaults: MetadataDefaults = {
            ...baseDefaults,
            defaultTitle: { template: "%s | Crucible", default: "Crucible" },
        };
        const result = mergeMetadata(defaults, [{ title: "Settings" }]);
        expect(result.title).toBe("Settings | Crucible");
    });

    test("default template alone uses its `default` field", () => {
        const defaults: MetadataDefaults = {
            ...baseDefaults,
            defaultTitle: { template: "%s | Crucible", default: "Home" },
        };
        const result = mergeMetadata(defaults, []);
        expect(result.title).toBe("Home | Crucible");
    });

    test("layer template overrides default template", () => {
        const defaults: MetadataDefaults = {
            ...baseDefaults,
            defaultTitle: { template: "%s | Crucible", default: "Crucible" },
        };
        const result = mergeMetadata(defaults, [
            { title: { template: "(beta) %s", default: "Crucible" } },
            { title: "Settings" },
        ]);
        expect(result.title).toBe("(beta) Settings");
    });

    test("inner template wins over outer template", () => {
        const result = mergeMetadata(baseDefaults, [
            { title: { template: "%s — One", default: "x" } },
            { title: { template: "%s — Two", default: "x" } },
            { title: "Page" },
        ]);
        expect(result.title).toBe("Page — Two");
    });
});

describe("mergeMetadata field overrides", () => {
    test("themeColor follows latest layer that sets it", () => {
        const result = mergeMetadata(baseDefaults, [
            { themeColor: "#aaaaaa" },
            {},
            { themeColor: "#000000" },
        ]);
        expect(result.themeColor).toBe("#000000");
    });

    test("missing fields fall back to defaults", () => {
        const result = mergeMetadata(baseDefaults, [{ title: "X" }]);
        expect(result.themeColor).toBe("#ffffff");
        expect(result.statusBarStyle).toBe("black-translucent");
        expect(result.manifest).toBe(false);
    });

    test("undefined layers are skipped without error", () => {
        const result = mergeMetadata(baseDefaults, [
            undefined,
            { title: "X" },
            undefined,
        ]);
        expect(result.title).toBe("X");
    });

    test("manifest can be set to false explicitly to override default URL", () => {
        const defaults: MetadataDefaults = {
            ...baseDefaults,
            manifest: "/manifest.webmanifest",
        };
        const result = mergeMetadata(defaults, [{ manifest: false }]);
        expect(result.manifest).toBe(false);
    });

    test("`other` arrays from layers concatenate", () => {
        const result = mergeMetadata(baseDefaults, [
            { other: [{ name: "og:title", content: "A" }] },
            { other: [{ name: "og:description", content: "B" }] },
        ]);
        expect(result.other).toHaveLength(2);
        expect(result.other.map((o) => o.name).sort()).toEqual([
            "og:description",
            "og:title",
        ]);
    });
});

describe("mergeMetadata edge cases", () => {
    test("pass-through Metadata typing accepts layers with arbitrary subset", () => {
        const layers: ReadonlyArray<Metadata | undefined> = [
            { title: "A" },
            { description: "desc" },
            { themeColor: "#222222" },
        ];
        const result = mergeMetadata(baseDefaults, layers);
        expect(result.title).toBe("A");
        expect(result.description).toBe("desc");
        expect(result.themeColor).toBe("#222222");
    });

    test("empty layer array yields default field values", () => {
        const result = mergeMetadata(baseDefaults, []);
        expect(result.title).toBe("Crucible");
        expect(result.themeColor).toBe("#ffffff");
        expect(result.other).toEqual([]);
    });
});
