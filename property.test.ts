// Property-based / fuzz tests for Crucible's pure encoder/parser/hash
// surface. fast-check generates thousands of random inputs per property
// and shrinks counterexamples down to a minimal failing case.
//
// Targets are chosen for: pure functions, well-defined invariants, and
// bug classes a hand-written example test would miss. Routing matchers,
// URL safety (XSS gate), and the SW asset hasher are all places where
// an unexpected input class (malformed percent-encoding, scheme
// confusion, list reordering) would silently break user apps.
//
// fc.assert defaults to 100 runs/property; we bump to 200 on the
// security-critical XSS gate.

import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { isSafeHref, isRouterTarget } from "./runtime/url-safety.ts";
import { matchRoute, matchDefault } from "./runtime/router/match.ts";
import { computeAssetVersion, shouldPrecache } from "./sw.ts";
import { segmentValue } from "./runtime/router/segment.ts";
import { makeRoute } from "./runtime/router/test-fixtures.ts";
import type { RouteSegment } from "./runtime/router/types.ts";

const BASE = "https://app.example.com/";

describe("property: isSafeHref — XSS gate never lets unsafe schemes through", () => {
  test("any prefix of `javascript:` (case-insensitive, with leading whitespace) is rejected", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          // Random whitespace prefix — \t \n \r " " — is what attackers
          // sometimes use to slip past naive scheme checks.
          fc.stringMatching(/^[\t\n\r ]*$/),
          // Random casing of "javascript".
          fc.string({ minLength: 1, maxLength: 30 }),
        ),
        ([ws, payload]) => {
          const tries = ["javascript:", "JaVaScRiPt:", "JAVASCRIPT:"];
          for (const scheme of tries) {
            const input = ws + scheme + payload;
            // Whitespace-prefixed schemes get past .trim(); unsafe scheme
            // regex is anchored at ^ so leading whitespace technically
            // bypasses scheme matching IF .trim() doesn't run first.
            // The actual code DOES trim first, so this should still reject.
            if (isSafeHref(input, BASE)) {
              throw new Error(
                `unsafe input passed isSafeHref: ${JSON.stringify(input)}`,
              );
            }
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  test("data: and vbscript: schemes are rejected for any payload", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.constantFrom("data:", "DATA:", "vbscript:", "VbScript:"),
        (payload, scheme) => {
          if (isSafeHref(scheme + payload, BASE)) {
            throw new Error(
              `unsafe scheme accepted: ${JSON.stringify(scheme + payload)}`,
            );
          }
          return true;
        },
      ),
    );
  });

  test("file: scheme is rejected", () => {
    fc.assert(
      fc.property(fc.string(), (payload) => {
        if (isSafeHref("file://" + payload, BASE)) {
          throw new Error(`file: accepted: ${payload}`);
        }
        return true;
      }),
    );
  });

  test("non-string inputs return false (no throw)", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.integer(),
          fc.boolean(),
          fc.array(fc.string()),
          fc.object(),
        ),
        (notString) => {
          // Should return false, not throw.
          return isSafeHref(notString, BASE) === false;
        },
      ),
    );
  });

  test("relative paths starting with /, ?, #, . are accepted (when nonempty)", () => {
    fc.assert(
      fc.property(
        // Restrict character set so we don't accidentally generate strings
        // whose URL parse fails. We're testing the prefix-recognition
        // branch, not URL validity.
        fc.constantFrom("/", "?", "#", "."),
        fc.stringMatching(/^[A-Za-z0-9_\-/?=#.]*$/),
        (prefix, suffix) => {
          const input = prefix + suffix;
          // The prefix-recognition branch returns true unconditionally
          // for trimmed, nonempty inputs starting with one of these chars
          // (after the unsafe-scheme regex check, which can't match these
          // — none start with a scheme).
          return isSafeHref(input, BASE) === true;
        },
      ),
    );
  });
});

describe("property: isRouterTarget — cross-origin must be rejected", () => {
  test("never accepts a URL whose origin differs from the base", () => {
    fc.assert(
      fc.property(
        fc.webUrl({ validSchemes: ["http", "https"] }),
        (url) => {
          // Force base to a different origin than the input.
          const u = new URL(url);
          const otherBase =
            u.origin === "https://other.example"
              ? "https://different.example/"
              : "https://other.example/";

          // Cross-origin must be rejected.
          if (isRouterTarget(url, otherBase)) {
            throw new Error(
              `cross-origin accepted: input=${url} base=${otherBase}`,
            );
          }
          return true;
        },
      ),
    );
  });

  test("mailto:/tel: are rejected even when scheme-safe-for-href", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("mailto:", "tel:"),
        fc.stringMatching(/^[A-Za-z0-9@.+\-]+$/),
        (scheme, addr) => {
          return isRouterTarget(scheme + addr, BASE) === false;
        },
      ),
    );
  });
});

describe("property: matchRoute — never throws on malformed input", () => {
  test("malformed percent-encoding in path returns no match (does not throw)", () => {
    const r = makeRoute([
      { kind: "literal", value: "orders" },
      { kind: "param", name: "id" },
    ]);

    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        (anything) => {
          // We're not testing that random strings DO match — they may or
          // may not. We're testing that the matcher never throws,
          // including for inputs containing partial percent-encoding.
          const path = "/orders/" + anything;
          // Force-include some malformed encodings deterministically.
          const variants = [
            path,
            "/orders/%E0",
            "/orders/%FF%FE",
            "/orders/" + encodeURIComponent(anything) + "%",
            "/" + anything,
            anything,
          ];
          for (const p of variants) {
            // Should never throw; result can be Match or null.
            matchRoute([r], p);
          }
          return true;
        },
      ),
    );
  });

  test("first-match-wins is total: returns one result or null", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.array(
            fc.oneof(
              fc.record({ kind: fc.constant("literal"), value: fc.stringMatching(/^[a-z0-9]{1,8}$/) }) as fc.Arbitrary<RouteSegment>,
              fc.record({ kind: fc.constant("param"), name: fc.stringMatching(/^[a-z]{1,8}$/) }) as fc.Arbitrary<RouteSegment>,
            ),
            { maxLength: 4 },
          ),
          { maxLength: 5 },
        ),
        fc.stringMatching(/^[a-z0-9/]{0,30}$/),
        (segLists, path) => {
          const routes = segLists.map((segs) => makeRoute(segs as RouteSegment[]));
          const m = matchRoute(routes, path);
          // Total function: either a Match or null. params (if Match)
          // is always a plain object.
          if (m !== null) {
            if (typeof m.params !== "object") return false;
            if (Array.isArray(m.params)) return false;
          }
          return true;
        },
      ),
    );
  });
});

describe("property: matchDefault — prefix-match invariants", () => {
  test("never throws on malformed percent-encoding", () => {
    const r = makeRoute([{ kind: "literal", value: "admin" }], { kind: "default" });

    fc.assert(
      fc.property(fc.string({ maxLength: 50 }), (suffix) => {
        // Should not throw on any input.
        matchDefault([r], "/admin/" + suffix);
        matchDefault([r], suffix);
        return true;
      }),
    );
  });

  test("default with no segments matches any path (the root default)", () => {
    const root = makeRoute([], { kind: "default" });
    fc.assert(
      fc.property(
        fc.stringMatching(/^\/[a-z0-9/]{0,30}$/),
        (path) => {
          const m = matchDefault([root], path);
          return m !== null && m.route === root;
        },
      ),
    );
  });
});

describe("property: computeAssetVersion — asset hash invariants", () => {
  const entryArb = fc.record({
    filename: fc.stringMatching(/^[a-zA-Z0-9_\-./]{1,40}$/),
    size: fc.integer({ min: 0, max: 10_000_000 }),
  });

  test("output is always an 8-char hex string", () => {
    fc.assert(
      fc.property(fc.array(entryArb), (entries) => {
        const v = computeAssetVersion(entries);
        return /^[0-9a-f]{8}$/.test(v);
      }),
    );
  });

  test("hash is order-independent (sorts internally)", () => {
    fc.assert(
      fc.property(fc.uniqueArray(entryArb, { selector: (e) => e.filename, minLength: 1 }), (entries) => {
        const v1 = computeAssetVersion(entries);
        const shuffled = [...entries].reverse();
        const v2 = computeAssetVersion(shuffled);
        return v1 === v2;
      }),
    );
  });

  test("changing any single (filename, size) pair changes the hash", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(entryArb, { selector: (e) => e.filename, minLength: 1, maxLength: 6 }),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 1, max: 10_000_000 }),
        (entries, idxRaw, sizeDelta) => {
          if (entries.length === 0) return true;
          const idx = idxRaw % entries.length;
          const before = computeAssetVersion(entries);
          const mutated = entries.map((e, i) =>
            i === idx ? { ...e, size: e.size + sizeDelta } : e,
          );
          // Could collide by sheer FNV-1a luck on 32 bits — extremely
          // unlikely but possible. Test the strong-typical property.
          // 2^-32 ≈ 2.3e-10, with 100 runs effectively impossible.
          return computeAssetVersion(mutated) !== before;
        },
      ),
    );
  });

  test("empty list still produces a valid hex string", () => {
    const v = computeAssetVersion([]);
    if (!/^[0-9a-f]{8}$/.test(v)) {
      throw new Error(`empty input gave invalid hash: ${v}`);
    }
  });
});

describe("property: shouldPrecache — only excludes the documented set", () => {
  test("excludes sw.js, *.map, and manifest.webmanifest; everything else passes", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-zA-Z0-9_\-./]{1,40}$/),
        (filename) => {
          const expected =
            filename !== "sw.js" &&
            !filename.endsWith(".map") &&
            filename !== "manifest.webmanifest";
          return shouldPrecache(filename) === expected;
        },
      ),
    );
  });
});

describe("property: segmentValue — total function over segments + params", () => {
  test("literal segments return their literal value regardless of params", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.dictionary(fc.string(), fc.string()),
        (literal, params) => {
          return segmentValue(
            { kind: "literal", value: literal },
            params,
          ) === literal;
        },
      ),
    );
  });

  test("param segments return the bound value or null when missing", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,15}$/),
        fc.dictionary(fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,15}$/), fc.string()),
        (paramName, params) => {
          const result = segmentValue({ kind: "param", name: paramName }, params);
          if (paramName in params) {
            return result === params[paramName];
          }
          return result === null;
        },
      ),
    );
  });
});
