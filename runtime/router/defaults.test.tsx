/// <reference lib="dom" />
import { test, expect, describe, mock, beforeEach } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { DefaultLoading, DefaultNotFound, DefaultError } from "./defaults.tsx";
import {
  NavigationContext,
  type NavigationContextValue,
} from "./context.ts";

beforeEach(() => cleanup());

function makeNavCtx(
  over: Partial<NavigationContextValue> = {},
): NavigationContextValue {
  return {
    location: { pathname: "/", search: new URLSearchParams(), hash: "" },
    navigate: () => {},
    prefetch: () => {},
    refresh: () => {},
    isNavigating: false,
    ...over,
  };
}

describe("DefaultLoading", () => {
  test("renders a loading message and an aria-busy attribute", () => {
    const { container } = render(<DefaultLoading />);
    expect(container.textContent).toContain("Loading");
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});

describe("DefaultNotFound", () => {
  test("renders a 404 heading and 'Not found' copy", () => {
    const { container } = render(<DefaultNotFound />);
    const h1 = container.querySelector("h1");
    expect(h1?.textContent).toBe("404");
    expect(container.textContent).toContain("Not found");
  });
});

describe("DefaultError", () => {
  test("renders an Error's message in the <pre> block", () => {
    const reset = mock(() => {});
    const { container } = render(
      <DefaultError error={new Error("boom")} resetErrorBoundary={reset} />,
    );
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("boom");
  });

  test("stringifies non-Error values (string, number, plain object)", () => {
    const reset = mock(() => {});
    const { container, rerender } = render(
      <DefaultError error={"string error"} resetErrorBoundary={reset} />,
    );
    expect(container.querySelector("pre")?.textContent).toBe("string error");

    rerender(<DefaultError error={42} resetErrorBoundary={reset} />);
    expect(container.querySelector("pre")?.textContent).toBe("42");

    rerender(
      <DefaultError
        error={{ toString: () => "obj-error" }}
        resetErrorBoundary={reset}
      />,
    );
    expect(container.querySelector("pre")?.textContent).toBe("obj-error");
  });

  test("'Try again' button — without NavigationContext, only resets the boundary", () => {
    // App-level error fallback case: the error fired before the
    // NavigationContext provider rendered. The button still works
    // (resets the boundary); refresh is a no-op via optional chaining.
    const reset = mock(() => {});
    const { container } = render(
      <DefaultError error={new Error("x")} resetErrorBoundary={reset} />,
    );
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Try again");
    fireEvent.click(button);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  test("'Try again' button — with NavigationContext, calls reset + refresh in order", () => {
    // Per-frame error fallback case: the boundary is inside the
    // router tree. Click should both reset (re-mount children) AND
    // refresh (re-fire queries) — without refresh, the re-mounted
    // children read the same cached failed PreloadedQuery and the
    // error fires again immediately.
    const calls: string[] = [];
    const reset = mock(() => {
      calls.push("reset");
    });
    const refresh = mock(() => {
      calls.push("refresh");
    });
    const ctx = makeNavCtx({ refresh });

    const { container } = render(
      <NavigationContext.Provider value={ctx}>
        <DefaultError error={new Error("x")} resetErrorBoundary={reset} />
      </NavigationContext.Provider>,
    );
    fireEvent.click(container.querySelector("button")!);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Reset BEFORE refresh: React unmounts the failed tree first, then
    // refresh kicks off the new queries the next render will read.
    expect(calls).toEqual(["reset", "refresh"]);
  });
});
