# React 19+ Primitives Follow-Up

This pass is intentionally separate from the router/ViewTransition PR.

## Goals

- Replace callback-ref patterns with `useEffectEvent` where it reduces effect churn without changing behavior.
- Evaluate `<Activity>` for preserved-but-hidden route subtrees, especially future view persistence and intercepted routes.
- Keep route data on Relay `loadQuery` / `usePreloadedQuery`; use React `use()` only for framework-owned promises that are not Relay operations.
- Evaluate `useDeferredValue` for expensive search-param driven UI where route-level navigation is too coarse.
- Keep route View Transitions opt-in through `experimental.reactViewTransitions`; React 19.3 now ships the stable `<ViewTransition>` API.

## Non-Goals

- Do not replace Relay Suspense integration with ad hoc promise reads.
- Do not require React 19.3 just for route transitions; older React 19 releases can use the router without the optional wrapper.
- Do not add compatibility shims for APIs that React stable does not export.
