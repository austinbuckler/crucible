import { test, expect, describe } from "bun:test";
import {
    assertRouterTarget,
    isRouterTarget,
    isSafeHref,
} from "./url-safety.ts";

const BASE = "https://Crucible.example/";

describe("isSafeHref — accept", () => {
    test("absolute paths", () => {
        expect(isSafeHref("/orders/123", BASE)).toBe(true);
        expect(isSafeHref("/", BASE)).toBe(true);
    });
    test("query-only and hash-only", () => {
        expect(isSafeHref("?tab=a", BASE)).toBe(true);
        expect(isSafeHref("#section", BASE)).toBe(true);
    });
    test("relative", () => {
        expect(isSafeHref("./foo", BASE)).toBe(true);
        expect(isSafeHref("../foo", BASE)).toBe(true);
    });
    test("same-origin and cross-origin http(s)", () => {
        expect(isSafeHref("https://Crucible.example/x", BASE)).toBe(true);
        expect(isSafeHref("https://example.com/x", BASE)).toBe(true);
        expect(isSafeHref("http://example.com/x", BASE)).toBe(true);
    });
    test("mailto: and tel:", () => {
        expect(isSafeHref("mailto:user@Crucible.com", BASE)).toBe(true);
        expect(isSafeHref("tel:+15551234", BASE)).toBe(true);
    });
});

describe("isSafeHref — reject", () => {
    test("javascript: scheme (with whitespace, mixed case)", () => {
        expect(isSafeHref("javascript:alert(1)", BASE)).toBe(false);
        expect(isSafeHref("  JavaScript:alert(1)", BASE)).toBe(false);
        expect(isSafeHref("\tjavascript:alert(1)", BASE)).toBe(false);
    });
    test("data: scheme", () => {
        expect(
            isSafeHref("data:text/html,<script>alert(1)</script>", BASE),
        ).toBe(false);
    });
    test("vbscript: and file:", () => {
        expect(isSafeHref("vbscript:msgbox(1)", BASE)).toBe(false);
        expect(isSafeHref("file:///etc/passwd", BASE)).toBe(false);
    });
    test("non-string and empty", () => {
        expect(isSafeHref("", BASE)).toBe(false);
        expect(isSafeHref("   ", BASE)).toBe(false);
        expect(isSafeHref(null, BASE)).toBe(false);
        expect(isSafeHref(undefined, BASE)).toBe(false);
    });
    test("custom protocol handlers", () => {
        expect(isSafeHref("intent://foo", BASE)).toBe(false);
        expect(isSafeHref("steam://foo", BASE)).toBe(false);
    });
});

describe("isRouterTarget — accept", () => {
    test("relative paths and fragments", () => {
        expect(isRouterTarget("/orders/123", BASE)).toBe(true);
        expect(isRouterTarget("?tab=a", BASE)).toBe(true);
        expect(isRouterTarget("#section", BASE)).toBe(true);
        expect(isRouterTarget("./foo", BASE)).toBe(true);
        expect(isRouterTarget("../foo", BASE)).toBe(true);
    });
    test("same-origin absolute http(s)", () => {
        expect(isRouterTarget("https://Crucible.example/x", BASE)).toBe(true);
        expect(isRouterTarget("https://Crucible.example/", BASE)).toBe(true);
    });
});

describe("isRouterTarget — reject", () => {
    test("cross-origin http(s) — even when href-safe", () => {
        expect(isRouterTarget("https://example.com/x", BASE)).toBe(false);
        expect(isRouterTarget("http://example.com/x", BASE)).toBe(false);
        expect(isRouterTarget("https://evil.com/phishing", BASE)).toBe(false);
    });
    test("mailto: and tel: — href-only, not routable", () => {
        expect(isRouterTarget("mailto:user@Crucible.com", BASE)).toBe(false);
        expect(isRouterTarget("tel:+15551234", BASE)).toBe(false);
    });
    test("javascript: / data: / vbscript: / file:", () => {
        expect(isRouterTarget("javascript:alert(1)", BASE)).toBe(false);
        expect(isRouterTarget("data:text/html,foo", BASE)).toBe(false);
        expect(isRouterTarget("vbscript:msgbox(1)", BASE)).toBe(false);
        expect(isRouterTarget("file:///etc/passwd", BASE)).toBe(false);
    });
    test("non-string and empty", () => {
        expect(isRouterTarget("", BASE)).toBe(false);
        expect(isRouterTarget(null, BASE)).toBe(false);
        expect(isRouterTarget(undefined, BASE)).toBe(false);
    });
});

describe("assertRouterTarget", () => {
    test("throws on cross-origin", () => {
        expect(() => assertRouterTarget("https://evil.com/x")).toThrow(
            /Refusing to route/,
        );
    });
    test("throws on mailto:", () => {
        expect(() => assertRouterTarget("mailto:foo@bar.com")).toThrow();
    });
    test("does not throw on same-origin path", () => {
        // assertRouterTarget uses `defaultBase()`, which falls back to
        // http://localhost/ in non-DOM environments. Same-origin pathname
        // strings always pass.
        expect(() => assertRouterTarget("/orders/123")).not.toThrow();
    });
});

describe("XSS gate — adversarial scheme bypass attempts", () => {
    // The XSS gate is a security boundary; "this works for the obvious
    // cases" isn't enough. These tests stress every variant a real
    // attacker would try, drawn from past CVEs in other URL parsers.

    test("javascript: with various whitespace prefixes — all rejected", () => {
        const inputs = [
            "javascript:alert(1)",
            "  javascript:alert(1)",
            "\tjavascript:alert(1)",
            "\njavascript:alert(1)",
            "\rjavascript:alert(1)",
            "\t\n javascript:alert(1)",
            "JaVaScRiPt:alert(1)",
            "JAVASCRIPT:alert(1)",
        ];
        for (const input of inputs) {
            expect(isSafeHref(input, BASE)).toBe(false);
            expect(isRouterTarget(input, BASE)).toBe(false);
        }
    });

    test("javascript: with unicode whitespace prefixes — rejected", () => {
        // `String.prototype.trim` strips Unicode whitespace per spec
        // (NBSP, BOM, etc.), so these resolve to plain "javascript:..."
        // and hit the unsafe-scheme regex.
        //
        // Note we don't test embedded NUL bytes (e.g. `java\0script:`).
        // Those don't match the scheme regex, and `new URL(...)` parses
        // them as a relative path (not a javascript: scheme), so a click
        // navigates somewhere harmless rather than executing — i.e.
        // returning `true` from `isSafeHref` is the correct behavior.
        const inputs = [
            " javascript:alert(1)", // non-breaking space (U+00A0)
            "﻿javascript:alert(1)", // zero-width no-break (BOM, U+FEFF)
        ];
        for (const input of inputs) {
            expect(isSafeHref(input, BASE)).toBe(false);
        }
    });

    test("data: with SVG payload — rejected", () => {
        expect(
            isSafeHref("data:image/svg+xml,<svg onload='alert(1)'/>", BASE),
        ).toBe(false);
    });

    test("URL with embedded scheme switcher in query string — accepted as href, rejected as router target", () => {
        // `https://evil.com/path?next=javascript:alert(1)` is valid https.
        // It's safe to render in href (browser handles cross-origin via
        // navigation, the query string is just data). It's NOT a valid
        // router target — cross-origin.
        const url = "https://evil.com/path?next=javascript:alert(1)";
        expect(isSafeHref(url, BASE)).toBe(true);
        expect(isRouterTarget(url, BASE)).toBe(false);
    });

    test("assertRouterTarget produces an actionable error for both XSS + cross-origin", () => {
        expect(() => assertRouterTarget("javascript:alert(1)")).toThrow(
            /Refusing to route/,
        );
        expect(() => assertRouterTarget("https://other.example/x")).toThrow(
            /Refusing to route/,
        );
    });
});
