/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  supportsViewTransitions,
  withViewTransition,
} from "./view-transitions.ts";

let originalStartViewTransition:
  | ((cb: () => void) => { finished: Promise<void> })
  | undefined;

beforeEach(() => {
  originalStartViewTransition = (
    document as Document & {
      startViewTransition?: (cb: () => void) => { finished: Promise<void> };
    }
  ).startViewTransition;
});

afterEach(() => {
  (document as Document & {
    startViewTransition?: unknown;
  }).startViewTransition =
    originalStartViewTransition as typeof document.startViewTransition;
});

describe("supportsViewTransitions", () => {
  test("returns false when API absent", () => {
    delete (document as { startViewTransition?: unknown }).startViewTransition;
    expect(supportsViewTransitions()).toBe(false);
  });

  test("returns true when API present", () => {
    (document as { startViewTransition?: unknown }).startViewTransition = () =>
      ({ finished: Promise.resolve() });
    expect(supportsViewTransitions()).toBe(true);
  });
});

describe("withViewTransition", () => {
  test("runs callback directly when not enabled", () => {
    let ran = false;
    withViewTransition(() => {
      ran = true;
    }, false);
    expect(ran).toBe(true);
  });

  test("runs callback directly when API absent", () => {
    delete (document as { startViewTransition?: unknown }).startViewTransition;
    let ran = false;
    withViewTransition(() => {
      ran = true;
    }, true);
    expect(ran).toBe(true);
  });

  test("calls startViewTransition when supported + enabled", () => {
    let received: (() => void) | null = null;
    (document as { startViewTransition?: unknown }).startViewTransition = (
      cb: () => void,
    ) => {
      received = cb;
      return { finished: Promise.resolve() };
    };
    let ran = false;
    withViewTransition(() => {
      ran = true;
    }, true);
    expect(received).not.toBeNull();
    received!();
    expect(ran).toBe(true);
  });
});
