/// <reference lib="dom" />
import { test, expect, describe } from "bun:test";
import { render, cleanup, screen } from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import { NotFoundBoundary, notFound } from "./not-found.tsx";

describe("notFound", () => {
  test("throws (so React error boundaries can catch it)", () => {
    expect(() => notFound()).toThrow();
  });

  test("the thrown error has the NotFoundError shape", () => {
    try {
      notFound();
      throw new Error("notFound did not throw");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe("NotFoundError");
    }
  });
});

describe("NotFoundBoundary", () => {
  // Helper: a child that throws notFound() during render.
  function MissingPage(): ReactNode {
    notFound();
  }

  // Helper: a child that throws a regular error (not a NotFound).
  function BrokenPage(): ReactNode {
    throw new Error("boom");
  }

  // Helper: a child that renders normally.
  function HappyPage(): ReactNode {
    return <p>I'm fine</p>;
  }

  // We render NotFoundBoundary inside a parent boundary that catches any
  // re-thrown error so non-NotFound errors don't leak to the test runner
  // as unhandled.
  class CatchAll extends (
    require("react").Component as new (
      props: { children: ReactNode; onError?: (e: unknown) => void },
    ) => {
      props: { children: ReactNode; onError?: (e: unknown) => void };
      state: { caught: unknown };
      context: unknown;
      setState: (s: object) => void;
      forceUpdate: () => void;
      render(): ReactNode;
    }
  ) {
    state = { caught: null };
    static getDerivedStateFromError(error: unknown) {
      return { caught: error };
    }
    componentDidCatch(error: unknown) {
      this.props.onError?.(error);
    }
    render() {
      if (this.state.caught) return <span data-testid="caught" />;
      return this.props.children;
    }
  }

  // After each test we manually unmount the rendered tree to keep the
  // DOM clean across cases.
  function cleanupDom() {
    cleanup();
  }

  test("renders fallback when child throws notFound()", () => {
    render(
      <NotFoundBoundary fallback={<div data-testid="nf">404</div>}>
        <MissingPage />
      </NotFoundBoundary>,
    );
    expect(screen.getByTestId("nf")).toBeTruthy();
    cleanupDom();
  });

  test("renders children when nothing throws", () => {
    render(
      <NotFoundBoundary fallback={<div data-testid="nf">404</div>}>
        <HappyPage />
      </NotFoundBoundary>,
    );
    expect(screen.getByText("I'm fine")).toBeTruthy();
    expect(screen.queryByTestId("nf")).toBe(null);
    cleanupDom();
  });

  test("re-throws non-NotFound errors so an outer boundary catches them", () => {
    let caughtByOuter: unknown = null;
    render(
      <CatchAll
        onError={(e) => {
          caughtByOuter = e;
        }}
      >
        <NotFoundBoundary fallback={<div data-testid="nf">404</div>}>
          <BrokenPage />
        </NotFoundBoundary>
      </CatchAll>,
    );
    expect(caughtByOuter).toBeInstanceOf(Error);
    expect((caughtByOuter as Error).message).toBe("boom");
    expect(screen.queryByTestId("nf")).toBe(null);
    cleanupDom();
  });

  // Suppress the "unused — for jest-dom-style assertion" warning.
  void useEffect;
});
