# React 19+ Primitives Follow-Up

This pass is intentionally separate from the router/ViewTransition PR.

## Goals

- Replace callback-ref patterns with `useEffectEvent` where it reduces effect churn without changing behavior.
- Evaluate `<Activity>` for preserved-but-hidden route subtrees, especially future view persistence and intercepted routes.
- Keep route data on Relay `loadQuery` / `usePreloadedQuery`; use React `use()` only for framework-owned promises that are not Relay operations.
- Evaluate `useDeferredValue` for expensive search-param driven UI where route-level navigation is too coarse.
- Keep React View Transitions behind `experimental.reactViewTransitions` until React promotes the API out of canary.

## Non-Goals

- Do not replace Relay Suspense integration with ad hoc promise reads.
- Do not require canary React for stable Crucible consumers.
- Do not add compatibility shims for APIs that React stable does not export.
