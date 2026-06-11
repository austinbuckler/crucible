// Splash-screen control. Called from user code (e.g. inside the root
// layout after an auth check completes, or after critical data is ready)
// to hand the screen over to the React app. Idempotent — repeated calls
// are no-ops.
//
// The DOM contract is fixed by the codegen-emitted index.html:
//   - element id: `crucible-splash`
//   - hidden class: `crucible-splash-hidden`
//   - mounted event: `crucible:mounted`
//
// `beforeMount(...)` callbacks (declared in src/app/splash.tsx) run at
// HTML-parse time and typically register a listener for the mounted event
// — `dismissSplashScreen()` is what dispatches it.
//
// **Claim-the-exit pattern.** The mounted event is dispatched as a
// cancelable Event. If a `beforeMount` listener calls
// `event.preventDefault()`, the framework treats that as "I'm handling
// the splash exit myself" and bails out of its fallback fade/remove.
// Otherwise the framework adds `.crucible-splash-hidden` (which the
// inline critical CSS fades over ~220ms) and removes the element on
// transitionend.
//
// Use the cancel path when you want to run a custom exit animation
// (canvas effect, SVG morph, etc.) longer than the default fade. Use
// the default path when you just need the splash gone — most apps.

const SPLASH_ID = "crucible-splash";
const HIDDEN_CLASS = "crucible-splash-hidden";
const MOUNTED_EVENT = "crucible:mounted";

let dispatched = false;

export function dismissSplashScreen(): void {
  if (typeof window === "undefined") return;
  if (dispatched) return;
  dispatched = true;

  // Dispatch as cancelable so listeners can claim ownership of
  // the exit. Older browsers without `cancelable` support fall
  // through to the fallback below regardless.
  let claimed = false;
  try {
    const event = new Event(MOUNTED_EVENT, { cancelable: true });
    window.dispatchEvent(event);
    claimed = event.defaultPrevented;
  } catch {
    // Event constructor unavailable — skip dispatch, run fallback.
  }

  if (claimed) return;

  // Default fallback: fade + remove. Runs in a microtask so the
  // listener has a chance to inspect / modify the DOM in the same
  // tick before we touch it.
  queueMicrotask(() => {
    const el = document.getElementById(SPLASH_ID);
    if (!el) return;
    if (el.classList.contains(HIDDEN_CLASS)) return;
    el.classList.add(HIDDEN_CLASS);
    el.addEventListener(
      "transitionend",
      () => {
        try {
          el.remove();
        } catch {
          // node may already be detached
        }
      },
      { once: true },
    );
  });
}
