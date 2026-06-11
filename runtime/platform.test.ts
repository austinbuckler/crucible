/// <reference lib="dom" />
import { test, expect, describe, afterEach } from "bun:test";
import {
  isElectron,
  getRuntimeType,
  type CrucibleRuntime,
} from "./platform.ts";

afterEach(() => {
  delete (window as { crucible?: unknown }).crucible;
});

function setRuntime(type: CrucibleRuntime["runtime"]["type"]): void {
  window.crucible = {
    runtime: { type, capabilities: [] },
    openExternal: async () => false,
    copyToClipboard: async () => false,
  };
}

describe("isElectron / getRuntimeType", () => {
  test("returns false / null when window.crucible isn't populated", () => {
    delete (window as { crucible?: unknown }).crucible;
    expect(isElectron()).toBe(false);
    expect(getRuntimeType()).toBeNull();
  });

  test("returns true / 'electron' when populated by Electron preload", () => {
    setRuntime("electron");
    expect(isElectron()).toBe(true);
    expect(getRuntimeType()).toBe("electron");
  });

  test("returns false / 'web' when populated by web bootstrap", () => {
    setRuntime("web");
    expect(isElectron()).toBe(false);
    expect(getRuntimeType()).toBe("web");
  });

  test("returns false / 'ios' for iOS platform", () => {
    setRuntime("ios");
    expect(isElectron()).toBe(false);
    expect(getRuntimeType()).toBe("ios");
  });
});
