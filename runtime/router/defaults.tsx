import { use } from "react";
import type { FallbackProps } from "react-error-boundary";
import { NavigationContext } from "./context.ts";

// The router's built-in fallback components. Every one of these is
// replaceable: per-frame via `loading.tsx` / `error.tsx` / `not-found.tsx`,
// or app-wide via the `errorFallback` prop on `<App>`.
//
// They're styled inline (not via Tailwind) so they render correctly even
// when the user's CSS hasn't loaded yet — which is exactly when a frame
// might be suspending or erroring.

export function DefaultLoading() {
  return (
    <div style={{ padding: "2rem", color: "#888" }} aria-busy="true">
      Loading…
    </div>
  );
}

export function DefaultNotFound() {
  return (
    <div style={{ padding: "2rem" }}>
      <h1 style={{ margin: 0 }}>404</h1>
      <p>Not found.</p>
    </div>
  );
}

export function DefaultError({ error, resetErrorBoundary }: FallbackProps) {
  const message = error instanceof Error ? error.message : String(error);
  // Read NavigationContext directly (not via `useRefresh`) so this
  // component still works when mounted as the App-level fallback —
  // i.e. when an error fires before NavigationContext renders. The
  // `?.refresh` chain reduces to a no-op in that case.
  const nav = use(NavigationContext);
  return (
    <div style={{ padding: "2rem" }}>
      <h1 style={{ margin: 0 }}>Something went wrong</h1>
      <pre
        style={{
          background: "#fee",
          padding: "1rem",
          borderRadius: 4,
          overflow: "auto",
        }}
      >
        {message}
      </pre>
      <button
        onClick={() => {
          // `resetErrorBoundary` re-mounts the children; `refresh`
          // re-fires their queries. Without the latter, the cached
          // (failed) PreloadedQuery refs would just throw the same
          // error on re-render. Order matters: reset first so React
          // unmounts the failed tree, then refresh kicks off the new
          // queries that the next render will read.
          resetErrorBoundary();
          nav?.refresh();
        }}
      >
        Try again
      </button>
    </div>
  );
}
