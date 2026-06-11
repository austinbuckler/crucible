/// <reference lib="dom" />
import { test, expect, describe, beforeEach, mock } from "bun:test";
import { render, cleanup, act } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { useCrucibleUpdate } from "./use-crucible-update.ts";

const UPDATE_READY_EVENT = "crucible:update-ready";

beforeEach(() => {
  cleanup();
});

// Helper component that renders a snapshot of the hook's state and
// calls the `onChange` ref with the latest handle. Tests interrogate
// the ref to assert state without re-render gymnastics.
function HookProbe({
  onChange,
}: {
  onChange: { current: ReturnType<typeof useCrucibleUpdate> | null };
}) {
  const handle = useCrucibleUpdate();
  useEffect(() => {
    onChange.current = handle;
  });
  return null;
}

function renderHook(): {
  current: () => ReturnType<typeof useCrucibleUpdate>;
} {
  const ref: { current: ReturnType<typeof useCrucibleUpdate> | null } = {
    current: null,
  };
  render(<HookProbe onChange={ref} />);
  return {
    current: () => {
      if (ref.current == null) throw new Error("hook not yet rendered");
      return ref.current;
    },
  };
}

function dispatchUpdateReady(activate: () => void): void {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(UPDATE_READY_EVENT, { detail: { activate } }),
    );
  });
}

describe("useCrucibleUpdate", () => {
  test("initial status is 'idle'", () => {
    const handle = renderHook();
    expect(handle.current().status).toBe("idle");
  });

  test("status transitions to 'available' on crucible:update-ready", () => {
    const handle = renderHook();
    dispatchUpdateReady(() => {});
    expect(handle.current().status).toBe("available");
  });

  test("activate() forwards to the event's activate callback", () => {
    const handle = renderHook();
    const activateSpy = mock(() => {});
    dispatchUpdateReady(activateSpy);

    act(() => {
      handle.current().activate();
    });

    expect(activateSpy).toHaveBeenCalledTimes(1);
  });

  test("status transitions to 'activating' after activate()", () => {
    const handle = renderHook();
    dispatchUpdateReady(() => {});
    act(() => {
      handle.current().activate();
    });
    expect(handle.current().status).toBe("activating");
  });

  test("activate() before any update-ready event is a no-op", () => {
    const handle = renderHook();
    expect(() => {
      act(() => {
        handle.current().activate();
      });
    }).not.toThrow();
    // Still idle; activation didn't fire (no waiting SW).
    expect(handle.current().status).toBe("idle");
  });

  test("activate() is idempotent — second call after activating does not re-fire", () => {
    const handle = renderHook();
    const activateSpy = mock(() => {});
    dispatchUpdateReady(activateSpy);
    act(() => {
      handle.current().activate();
    });
    act(() => {
      handle.current().activate();
    });
    expect(activateSpy).toHaveBeenCalledTimes(1);
  });

  test("unmount removes the event listener (no leak)", () => {
    // Track the listener count via add/remove pairing.
    const adds: string[] = [];
    const removes: string[] = [];
    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);
    type AddSig = typeof window.addEventListener;
    type RemoveSig = typeof window.removeEventListener;
    const trackAdd: AddSig = ((event: string, ...rest: unknown[]) => {
      if (event === UPDATE_READY_EVENT) adds.push(event);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origAdd as any)(event, ...rest);
    }) as AddSig;
    const trackRemove: RemoveSig = ((event: string, ...rest: unknown[]) => {
      if (event === UPDATE_READY_EVENT) removes.push(event);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origRemove as any)(event, ...rest);
    }) as RemoveSig;
    window.addEventListener = trackAdd;
    window.removeEventListener = trackRemove;

    try {
      const { unmount } = render(
        <HookProbe
          onChange={{ current: null } as { current: ReturnType<typeof useCrucibleUpdate> | null }}
        />,
      );
      expect(adds.length).toBe(1);
      expect(removes.length).toBe(0);
      unmount();
      expect(removes.length).toBe(1);
    } finally {
      window.addEventListener = origAdd;
      window.removeEventListener = origRemove;
    }
  });
});

// Suppress unused-import warning when the test file is grepped for
// React imports. useRef is referenced via ts type lookup elsewhere.
void useRef;
