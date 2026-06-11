/// <reference lib="dom" />
import { afterEach, describe, expect, test } from "bun:test";
import { defaultFocusBehavior, findFocusTarget } from "./focus.ts";

afterEach(() => {
  // Clean up by removing children — innerHTML setters are flagged by the
  // package's security tooling.
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
});

describe("findFocusTarget", () => {
  test("prefers [data-crucible-focus-target]", () => {
    const explicit = document.createElement("div");
    explicit.setAttribute("data-crucible-focus-target", "");
    explicit.id = "explicit";
    const main = document.createElement("main");
    document.body.append(main, explicit);
    expect(findFocusTarget()).toBe(explicit);
  });

  test("falls back to <main>", () => {
    const main = document.createElement("main");
    document.body.append(main);
    expect(findFocusTarget()).toBe(main);
  });

  test("falls back to body when nothing else matches", () => {
    expect(findFocusTarget()).toBe(document.body);
  });
});

describe("defaultFocusBehavior.apply", () => {
  test("calls focus on the resolved target with preventScroll", () => {
    const main = document.createElement("main");
    let received: unknown = null;
    main.focus = ((opts: unknown) => {
      received = opts;
    }) as HTMLElement["focus"];
    document.body.append(main);
    defaultFocusBehavior.apply();
    expect(received).toEqual({ preventScroll: true });
  });

  test("sets tabindex=-1 on the target so .focus() actually moves focus", () => {
    const main = document.createElement("main");
    main.focus = () => {};
    document.body.append(main);
    expect(main.getAttribute("tabindex")).toBe(null);
    defaultFocusBehavior.apply();
    expect(main.getAttribute("tabindex")).toBe("-1");
  });

  test("does not overwrite an existing tabindex", () => {
    const explicit = document.createElement("div");
    explicit.setAttribute("data-crucible-focus-target", "");
    explicit.setAttribute("tabindex", "0");
    explicit.focus = () => {};
    document.body.append(explicit);
    defaultFocusBehavior.apply();
    expect(explicit.getAttribute("tabindex")).toBe("0");
  });
});
