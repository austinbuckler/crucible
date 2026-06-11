import {
  type AnchorHTMLAttributes,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type TouchEvent,
  forwardRef,
  useCallback,
} from "react";
import { useNavigate, usePrefetch } from "./router/context.ts";
import { isRouterTarget, isSafeHref } from "./url-safety.ts";

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  to: string;
  // Warm the destination route's chunk + queries on hover/focus/touch-start
  // so the click navigation is instant. Default `true`. Pass `false` for
  // links that point to expensive routes the user is unlikely to visit.
  prefetch?: boolean;
  // Replace the current history entry instead of pushing a new one.
  // Used for in-place URL refinements (wizard step picker, dialog mode
  // selector, filter tabs) where the back button should skip past the
  // intermediate state and land on the route the user came from.
  replace?: boolean;
};

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  {
    to,
    onClick,
    onPointerEnter,
    onFocus,
    onTouchStart,
    target,
    prefetch: prefetchEnabled = true,
    replace = false,
    ...rest
  },
  ref,
) {
  const navigate = useNavigate();
  const prefetch = usePrefetch();

  // Two distinct safety checks:
  //   - `isSafeHref` strips the href for XSS-y schemes (javascript:, data:).
  //     The browser uses the raw href for middle-click / cmd-click /
  //     right-click → open-in-new-tab, which bypasses our click handler —
  //     so href sanitization is the actual XSS defense.
  //   - `isRouterTarget` decides whether the click handler should call
  //     `navigate()`. Cross-origin http(s) URLs are safe in href but NOT
  //     routable (pushState throws cross-origin). For those, we let the
  //     browser handle the click natively.
  const safeHref = isSafeHref(to);
  const href = safeHref ? to : undefined;
  const routable = isRouterTarget(to);

  const warm = useCallback(() => {
    if (!prefetchEnabled) return;
    if (target && target !== "_self") return;
    prefetch(to);
  }, [prefetch, prefetchEnabled, target, to]);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (target && target !== "_self") return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (event.button !== 0) return;
    // Cross-origin / mailto / tel: let the browser handle. No preventDefault.
    if (!routable) return;
    event.preventDefault();
    navigate(to, { replace });
  };

  const handlePointerEnter = (event: PointerEvent<HTMLAnchorElement>) => {
    onPointerEnter?.(event);
    warm();
  };

  const handleFocus = (event: FocusEvent<HTMLAnchorElement>) => {
    onFocus?.(event);
    warm();
  };

  const handleTouchStart = (event: TouchEvent<HTMLAnchorElement>) => {
    onTouchStart?.(event);
    warm();
  };

  return (
    <a
      ref={ref}
      href={href}
      target={target}
      onClick={handleClick}
      onPointerEnter={handlePointerEnter}
      onFocus={handleFocus}
      onTouchStart={handleTouchStart}
      {...rest}
    />
  );
});
