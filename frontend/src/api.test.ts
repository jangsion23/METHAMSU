import { describe, expect, it, vi } from "vitest";
import { api, ensureLearnerToken, setApiLearnerToken, TOKEN_KEY } from "./api";

describe("learner identity initialization", () => {
  it("serializes concurrent first visits and rechecks storage inside the shared lock", async () => {
    setApiLearnerToken(null);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "one-shared-learner" }), {
          status: 201,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tokens = await Promise.all([
      ensureLearnerToken(),
      ensureLearnerToken(),
    ]);
    expect(tokens).toEqual(["one-shared-learner", "one-shared-learner"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(navigator.locks.request).toHaveBeenCalledTimes(2);
    expect(navigator.locks.request).toHaveBeenCalledWith(
      "recall-learner-init",
      expect.any(Function),
    );
    expect(localStorage.getItem(TOKEN_KEY)).toBe("one-shared-learner");
  });

  it("fails explicitly when safe cross-tab initialization is unavailable", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(ensureLearnerToken()).rejects.toMatchObject({
      code: "IDENTITY_LOCK_UNAVAILABLE",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    localStorage.setItem(TOKEN_KEY, "existing-learner");
    await expect(ensureLearnerToken()).resolves.toBe("existing-learner");
  });

  it("keeps requests bound to the loaded identity until replacement is handled", async () => {
    setApiLearnerToken("loaded-learner");
    localStorage.setItem(TOKEN_KEY, "replacement-learner");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await api("/dashboard");
    expect(
      new Headers(
        (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
          .headers,
      ).get("X-Learner-Token"),
    ).toBe("loaded-learner");
    setApiLearnerToken(null);
  });
});
