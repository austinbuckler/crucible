import { useEffect, useState } from "react";
import type { SwUpdateReadyEventDetail } from "./sw-update.ts";

export type SwUpdateStatus = "idle" | "available" | "activating";

export type CrucibleUpdateHandle = {
  // Current status. Transitions:
  //   idle      → available  (SW installed and waiting; user can update)
  //   available → activating (consumer called activate(); reload imminent)
  status: SwUpdateStatus;
  // Send the skip-waiting message to the waiting SW. Safe to call in any
  // status; no-ops when no SW is waiting. Idempotent — multiple calls
  // collapse to a single postMessage.
  activate: () => void;
};

const UPDATE_READY_EVENT = "crucible:update-ready";

// React hook for components that want to render update UI reactively.
// Subscribes to the `crucible:update-ready` window event dispatched by
// `initSwUpdate` and exposes the latest activation callback through the
// `activate` field.
//
// Usage:
//
//   function UpdateBanner() {
//     const { status, activate } = useCrucibleUpdate();
//     if (status !== "available") return null;
//     return <button onClick={activate}>Update available</button>;
//   }
export function useCrucibleUpdate(): CrucibleUpdateHandle {
  const [state, setState] = useState<{
    status: SwUpdateStatus;
    pendingActivate: (() => void) | null;
  }>({ status: "idle", pendingActivate: null });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onReady = (e: Event): void => {
      const detail = (e as CustomEvent<SwUpdateReadyEventDetail>).detail;
      if (!detail || typeof detail.activate !== "function") return;
      setState({ status: "available", pendingActivate: detail.activate });
    };
    window.addEventListener(UPDATE_READY_EVENT, onReady);
    return () => {
      window.removeEventListener(UPDATE_READY_EVENT, onReady);
    };
  }, []);

  // No manual useCallback — react-compiler memoizes the bound closure
  // and the returned handle. Calling `activate` from a stable consumer
  // remains identity-stable across renders that don't change the
  // pending-activate slot.
  function activate(): void {
    setState((prev) => {
      if (prev.pendingActivate == null) return prev;
      try {
        prev.pendingActivate();
      } catch {
        // Activation failures are non-fatal — the page keeps working.
      }
      return { status: "activating", pendingActivate: null };
    });
  }

  return { status: state.status, activate };
}
