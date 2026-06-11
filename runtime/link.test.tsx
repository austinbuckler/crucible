/// <reference lib="dom" />
import { test, expect, describe, mock, beforeEach } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { type ComponentProps } from "react";
import { Link } from "./link.tsx";
import {
  NavigationContext,
  type NavigationContextValue,
} from "./router/context.ts";

type LinkProps = ComponentProps<typeof Link>;

// Tests use a real <NavigationContext.Provider> with stub navigate/prefetch
// fns rather than mocking the module — module-level mocks leak across
// files when multiple tests run in the same process (mock.module is
// irreversible per Bun's current implementation).

let navigateSpy = mock(() => {});
let prefetchSpy = mock(() => {});

beforeEach(() => {
  navigateSpy = mock(() => {});
  prefetchSpy = mock(() => {});
  cleanup();
});

function makeNavCtx(
  over: Partial<NavigationContextValue> = {},
): NavigationContextValue {
  return {
    location: {
      pathname: "/",
      search: new URLSearchParams(),
      hash: "",
    },
    navigate: navigateSpy,
    prefetch: prefetchSpy,
    refresh: () => {},
    isNavigating: false,
    ...over,
  };
}

function renderLink(props: LinkProps): HTMLElement {
  const { container } = render(
    <NavigationContext.Provider value={makeNavCtx()}>
      <Link {...props}>{props.children ?? "x"}</Link>
    </NavigationContext.Provider>,
  );
  return container.querySelector("a") as HTMLAnchorElement;
}

describe("Link — href rendering", () => {
  test("renders href for safe schemes", () => {
    expect(
      renderLink({ to: "/orders/1", children: "go" }).getAttribute("href"),
    ).toBe("/orders/1");
    expect(
      renderLink({ to: "https://example.com/x", children: "ext" }).getAttribute(
        "href",
      ),
    ).toBe("https://example.com/x");
    expect(
      renderLink({ to: "mailto:a@b.c", children: "mail" }).getAttribute("href"),
    ).toBe("mailto:a@b.c");
  });

  test("strips href for javascript: scheme", () => {
    const el = renderLink({ to: "javascript:alert(1)", children: "evil" });
    expect(el.hasAttribute("href")).toBe(false);
  });

  test("strips href for data: and vbscript:", () => {
    expect(
      renderLink({ to: "data:text/html,foo", children: "x" }).hasAttribute("href"),
    ).toBe(false);
    expect(
      renderLink({ to: "vbscript:msgbox(1)", children: "x" }).hasAttribute("href"),
    ).toBe(false);
  });
});

describe("Link — click behavior", () => {
  test("calls navigate() for same-origin paths", () => {
    const el = renderLink({ to: "/orders/1", children: "go" });
    fireEvent.click(el);
    expect(navigateSpy).toHaveBeenCalledWith("/orders/1", { replace: false });
  });

  test("passes replace:true through navigate when Link has replace prop", () => {
    const el = renderLink({ to: "/orders/1", replace: true, children: "go" });
    fireEvent.click(el);
    expect(navigateSpy).toHaveBeenCalledWith("/orders/1", { replace: true });
  });

  test("does NOT call navigate() for cross-origin links (lets browser handle)", () => {
    const el = renderLink({
      to: "https://example.com/external",
      children: "ext",
    });
    fireEvent.click(el);
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  test("does NOT call navigate() for mailto:", () => {
    const el = renderLink({ to: "mailto:a@b.c", children: "mail" });
    fireEvent.click(el);
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  test("respects modifier keys (cmd/ctrl/shift/alt) — browser opens new tab", () => {
    const el = renderLink({ to: "/orders/1", children: "go" });
    fireEvent.click(el, { metaKey: true });
    expect(navigateSpy).not.toHaveBeenCalled();
    fireEvent.click(el, { ctrlKey: true });
    expect(navigateSpy).not.toHaveBeenCalled();
    fireEvent.click(el, { shiftKey: true });
    expect(navigateSpy).not.toHaveBeenCalled();
    fireEvent.click(el, { altKey: true });
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  test("respects target='_blank'", () => {
    const el = renderLink({
      to: "/orders/1",
      target: "_blank",
      children: "go",
    });
    fireEvent.click(el);
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  test("right-click (button !== 0) doesn't navigate", () => {
    const el = renderLink({ to: "/orders/1", children: "go" });
    fireEvent.click(el, { button: 2 });
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  test("custom onClick can preventDefault to suppress navigation", () => {
    const onClick = mock((e: { preventDefault: () => void }) => {
      e.preventDefault();
    });
    const el = renderLink({ to: "/orders/1", onClick, children: "go" });
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});

describe("Link — prefetch", () => {
  test("warms on pointer enter", () => {
    const el = renderLink({ to: "/orders/1", children: "go" });
    fireEvent.pointerEnter(el);
    expect(prefetchSpy).toHaveBeenCalledWith("/orders/1");
  });

  test("warms on focus", () => {
    const el = renderLink({ to: "/orders/1", children: "go" });
    fireEvent.focus(el);
    expect(prefetchSpy).toHaveBeenCalledWith("/orders/1");
  });

  test("warms on touchstart (mobile)", () => {
    const el = renderLink({ to: "/orders/1", children: "go" });
    fireEvent.touchStart(el);
    expect(prefetchSpy).toHaveBeenCalledWith("/orders/1");
  });

  test("respects prefetch={false}", () => {
    const el = renderLink({ to: "/orders/1", prefetch: false, children: "go" });
    fireEvent.pointerEnter(el);
    expect(prefetchSpy).not.toHaveBeenCalled();
  });

  test("does not prefetch when target='_blank'", () => {
    const el = renderLink({
      to: "/orders/1",
      target: "_blank",
      children: "go",
    });
    fireEvent.pointerEnter(el);
    expect(prefetchSpy).not.toHaveBeenCalled();
  });
});
