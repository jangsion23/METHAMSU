import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

beforeEach(() => {
  let queue: Promise<unknown> = Promise.resolve();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: vi.fn((_name: string, callback: () => unknown) => {
        const result = queue.then(callback);
        queue = result.catch(() => undefined);
        return result;
      }),
    },
  });
  localStorage.clear();
  window.location.hash = "";
  window.scrollTo = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
