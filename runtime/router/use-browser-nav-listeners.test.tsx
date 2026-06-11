/// <reference lib="dom" />
import { test, expect, describe, mock, beforeEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { useBrowserNavListeners } from "./use-browser-nav-listeners.ts";

beforeEach(() => cleanup());

function Probe({
  applyNav,
}: {
  applyNav: Parameters<typeof useBrowserNavListeners>[0];
}) {
  useBrowserNavListeners(applyNav);
  return null;
}

describe("useBrowserNavListeners", () => {
  test("popstate event triggers applyNav with source='pop'", () => {
    const applyNav = mock(
      (_next: URL, _source: "soft" | "pop", _historyOp: () => void) => {},
    );
    render(<Probe applyNav={applyNav} />);

    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(applyNav).toHaveBeenCalledTimes(1);
    const [url, source] = applyNav.mock.calls[0]!;
    expect(url).toBeInstanceOf(URL);
    expect(source).toBe("pop");
  });

  // happydom doesn't expose `PageTransitionEvent`; fabricate one by
  // attaching `persisted` to a plain Event of the right type. This is
  // semantically equivalent for our handler — it reads `event.persisted`.
  function pageShow(persisted: boolean): Event {
    const e = new Event("pageshow") as Event & { persisted: boolean };
    Object.defineProperty(e, "persisted", { value: persisted });
    return e;
  }

  test("pageshow with persisted=true triggers applyNav (bfcache restoration)", () => {
    const applyNav = mock(
      (_next: URL, _source: "soft" | "pop", _historyOp: () => void) => {},
    );
    render(<Probe applyNav={applyNav} />);

    window.dispatchEvent(pageShow(true));

    expect(applyNav).toHaveBeenCalledTimes(1);
    const [, source] = applyNav.mock.calls[0]!;
    // bfcache restoration is treated as a pop-style nav.
    expect(source).toBe("pop");
  });

  test("pageshow with persisted=true ALSO dispatches crucible:resume so canvas/chart consumers can re-layout", () => {
    const applyNav = mock(
      (_next: URL, _source: "soft" | "pop", _historyOp: () => void) => {},
    );
    const onResume = mock(() => {});
    window.addEventListener("crucible:resume", onResume);
    render(<Probe applyNav={applyNav} />);

    window.dispatchEvent(pageShow(true));

    expect(onResume).toHaveBeenCalledTimes(1);
    window.removeEventListener("crucible:resume", onResume);
  });

  test("pageshow with persisted=false does NOT dispatch crucible:resume (initial loads aren't 'resumes')", () => {
    const applyNav = mock(
      (_next: URL, _source: "soft" | "pop", _historyOp: () => void) => {},
    );
    const onResume = mock(() => {});
    window.addEventListener("crucible:resume", onResume);
    render(<Probe applyNav={applyNav} />);

    window.dispatchEvent(pageShow(false));

    expect(onResume).not.toHaveBeenCalled();
    window.removeEventListener("crucible:resume", onResume);
  });

  test("pageshow with persisted=false (initial load) does NOT trigger applyNav", () => {
    const applyNav = mock(
      (_next: URL, _source: "soft" | "pop", _historyOp: () => void) => {},
    );
    render(<Probe applyNav={applyNav} />);

    // The browser fires pageshow on every navigation, not just bfcache —
    // we only want to act on the bfcache case.
    window.dispatchEvent(pageShow(false));

    expect(applyNav).not.toHaveBeenCalled();
  });

  test("listeners are removed on unmount", () => {
    const applyNav = mock(
      (_next: URL, _source: "soft" | "pop", _historyOp: () => void) => {},
    );
    const { unmount } = render(<Probe applyNav={applyNav} />);
    unmount();

    window.dispatchEvent(new PopStateEvent("popstate"));
    window.dispatchEvent(pageShow(true));

    expect(applyNav).not.toHaveBeenCalled();
  });

  test("the historyOp passed to applyNav is a no-op (popstate already moved history)", () => {
    const applyNav = mock(
      (_next: URL, _source: "soft" | "pop", _historyOp: () => void) => {},
    );
    render(<Probe applyNav={applyNav} />);

    window.dispatchEvent(new PopStateEvent("popstate"));

    const [, , historyOp] = applyNav.mock.calls[0]!;
    // Calling historyOp must not throw and must not change history.
    const before = window.history.length;
    expect(() => historyOp()).not.toThrow();
    expect(window.history.length).toBe(before);
  });
});
