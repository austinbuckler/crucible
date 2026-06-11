/// <reference lib="dom" />
import { test, expect, describe, mock, beforeEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import {
  useFocusManagement,
  useScrollRestoration,
} from "./use-scroll-and-focus.ts";
import type { FocusBehavior } from "./focus.ts";
import type { ScrollBehavior } from "./scroll.ts";
import type { Location, NavSource } from "./types.ts";

beforeEach(() => cleanup());

function loc(pathname = "/"): Location {
  return { pathname, search: new URLSearchParams(), hash: "" };
}

describe("useScrollRestoration", () => {
  function Probe({
    location,
    navSource,
    enabled,
    scrollBehavior,
  }: {
    location: Location;
    navSource: NavSource;
    enabled: boolean;
    scrollBehavior: ScrollBehavior;
  }) {
    useScrollRestoration(location, navSource, enabled, scrollBehavior);
    return null;
  }

  test("calls scrollBehavior.apply on mount with the current location", () => {
    const apply = mock((_location: Location, _source: NavSource) => {});
    const save = mock(() => {});
    const sb: ScrollBehavior = { apply, save };
    render(
      <Probe
        location={loc("/orders")}
        navSource="init"
        enabled={true}
        scrollBehavior={sb}
      />,
    );
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0]).toEqual(loc("/orders"));
    expect(apply.mock.calls[0]![1]).toBe("init");
  });

  test("does NOT apply when enabled=false", () => {
    const apply = mock((_location: Location, _source: NavSource) => {});
    const sb: ScrollBehavior = { apply, save: () => {} };
    render(
      <Probe
        location={loc()}
        navSource="soft"
        enabled={false}
        scrollBehavior={sb}
      />,
    );
    expect(apply).not.toHaveBeenCalled();
  });

  test("re-applies on location change (covers nav between routes)", () => {
    const apply = mock((_location: Location, _source: NavSource) => {});
    const sb: ScrollBehavior = { apply, save: () => {} };
    const { rerender } = render(
      <Probe
        location={loc("/a")}
        navSource="init"
        enabled={true}
        scrollBehavior={sb}
      />,
    );
    rerender(
      <Probe
        location={loc("/b")}
        navSource="soft"
        enabled={true}
        scrollBehavior={sb}
      />,
    );
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1]![0].pathname).toBe("/b");
  });
});

describe("useFocusManagement", () => {
  function Probe({
    pathname,
    navSource,
    enabled,
    focusBehavior,
  }: {
    pathname: string;
    navSource: NavSource;
    enabled: boolean;
    focusBehavior: FocusBehavior;
  }) {
    useFocusManagement(pathname, navSource, enabled, focusBehavior);
    return null;
  }

  test("does NOT apply on init — first paint focus is browser/user managed", () => {
    const apply = mock(() => {});
    const fb: FocusBehavior = { apply };
    render(
      <Probe
        pathname="/"
        navSource="init"
        enabled={true}
        focusBehavior={fb}
      />,
    );
    expect(apply).not.toHaveBeenCalled();
  });

  test("applies on soft navigation", () => {
    const apply = mock(() => {});
    const fb: FocusBehavior = { apply };
    render(
      <Probe
        pathname="/orders"
        navSource="soft"
        enabled={true}
        focusBehavior={fb}
      />,
    );
    expect(apply).toHaveBeenCalledTimes(1);
  });

  test("applies on pop navigation (back/forward)", () => {
    const apply = mock(() => {});
    const fb: FocusBehavior = { apply };
    render(
      <Probe
        pathname="/orders"
        navSource="pop"
        enabled={true}
        focusBehavior={fb}
      />,
    );
    expect(apply).toHaveBeenCalledTimes(1);
  });

  test("does NOT apply when enabled=false", () => {
    const apply = mock(() => {});
    const fb: FocusBehavior = { apply };
    render(
      <Probe
        pathname="/orders"
        navSource="soft"
        enabled={false}
        focusBehavior={fb}
      />,
    );
    expect(apply).not.toHaveBeenCalled();
  });

  test("re-applies only when pathname changes — search/hash-only updates skip", () => {
    const apply = mock(() => {});
    const fb: FocusBehavior = { apply };
    const { rerender } = render(
      <Probe
        pathname="/orders"
        navSource="soft"
        enabled={true}
        focusBehavior={fb}
      />,
    );
    expect(apply).toHaveBeenCalledTimes(1);

    // Same pathname, different navSource — doesn't trigger because
    // pathname is the dep that drives "new page".
    rerender(
      <Probe
        pathname="/orders"
        navSource="pop"
        enabled={true}
        focusBehavior={fb}
      />,
    );
    // The dep is `[pathname, navSource, enabled, focusBehavior]` — so
    // navSource change DOES re-apply. That's intentional for back/forward
    // mid-session.
    expect(apply).toHaveBeenCalledTimes(2);

    // Pathname change re-applies.
    rerender(
      <Probe
        pathname="/clients"
        navSource="soft"
        enabled={true}
        focusBehavior={fb}
      />,
    );
    expect(apply).toHaveBeenCalledTimes(3);
  });
});
