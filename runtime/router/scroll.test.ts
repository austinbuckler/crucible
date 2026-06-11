/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  defaultScrollBehavior,
  readScrollFromState,
  saveCurrentScroll,
  SCROLL_KEY,
} from "./scroll.ts";

describe("saveCurrentScroll / readScrollFromState", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  test("save round-trips through readScrollFromState", () => {
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      get: () => 421,
    });
    saveCurrentScroll();
    expect(readScrollFromState()).toBe(421);
  });

  test("readScrollFromState returns null when no entry stored", () => {
    window.history.replaceState({}, "", "/");
    expect(readScrollFromState()).toBe(null);
  });

  test("save preserves other history.state keys", () => {
    window.history.replaceState({ tag: "x" }, "", "/");
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      get: () => 50,
    });
    saveCurrentScroll();
    expect(window.history.state.tag).toBe("x");
    expect(window.history.state[SCROLL_KEY]).toBe(50);
  });
});

describe("defaultScrollBehavior.apply", () => {
  let scrolledTo: { x: number; y: number } | null = null;
  beforeEach(() => {
    scrolledTo = null;
    window.scrollTo = ((x: number, y: number) => {
      scrolledTo = { x, y };
    }) as unknown as typeof window.scrollTo;
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    // Remove any test-mounted children without using innerHTML.
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
  });

  test("hash scrolls to element when present", () => {
    const el = document.createElement("section");
    el.id = "target";
    el.scrollIntoView = () => {
      scrolledTo = { x: -1, y: -1 };
    };
    document.body.appendChild(el);
    defaultScrollBehavior.apply(
      { pathname: "/", search: new URLSearchParams(), hash: "#target" },
      "soft",
    );
    expect(scrolledTo).toEqual({ x: -1, y: -1 });
  });

  test("pop restores from history.state", () => {
    window.history.replaceState({ [SCROLL_KEY]: 250 }, "", "/");
    defaultScrollBehavior.apply(
      { pathname: "/", search: new URLSearchParams(), hash: "" },
      "pop",
    );
    expect(scrolledTo).toEqual({ x: 0, y: 250 });
  });

  test("push (soft) scrolls to top", () => {
    defaultScrollBehavior.apply(
      { pathname: "/", search: new URLSearchParams(), hash: "" },
      "soft",
    );
    expect(scrolledTo).toEqual({ x: 0, y: 0 });
  });

  test("init does NOT scroll (let browser/deep-link handle)", () => {
    defaultScrollBehavior.apply(
      { pathname: "/", search: new URLSearchParams(), hash: "" },
      "init",
    );
    expect(scrolledTo).toBe(null);
  });

  test("pop with no stored scrollY falls through to scroll-to-top", () => {
    // Edge case: cold-load → user clicks back. There's no stored
    // scrollY for the entry we're landing on. We scroll to top rather
    // than leave scroll wherever the previous render left it.
    window.history.replaceState({}, "", "/");
    defaultScrollBehavior.apply(
      { pathname: "/", search: new URLSearchParams(), hash: "" },
      "pop",
    );
    expect(scrolledTo).toEqual({ x: 0, y: 0 });
  });
});
