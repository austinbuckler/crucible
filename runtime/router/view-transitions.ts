// View Transitions API — declared narrowly so we don't need a global
// lib dep just for a draft standard.
export type DocumentWithViewTransitions = Document & {
  startViewTransition?: (cb: () => void) => { finished: Promise<void> };
};

export function supportsViewTransitions(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof (document as DocumentWithViewTransitions).startViewTransition ===
      "function"
  );
}

// Wrap a state-mutation callback in a view transition when the browser
// supports it; otherwise just run it. The router uses this to opt every
// navigation into the native cross-fade.
export function withViewTransition(cb: () => void, enabled: boolean): void {
  if (enabled && supportsViewTransitions()) {
    (document as DocumentWithViewTransitions).startViewTransition!(cb);
  } else {
    cb();
  }
}
