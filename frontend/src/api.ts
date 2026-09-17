export const TOKEN_KEY = "recall.learnerToken";
let learnerToken: string | null = null;

export const setApiLearnerToken = (token: string | null) => {
  learnerToken = token;
};
export const getApiLearnerToken = () => learnerToken;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  const token = learnerToken;
  if (token) headers.set("X-Learner-Token", token);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...options, headers });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      "서버에 연결할 수 없습니다. 연결 상태를 확인하고 다시 시도해 주세요.",
    );
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (response.status === 401 && token && token === learnerToken)
      window.dispatchEvent(new Event("recall:unauthorized"));
    throw new ApiError(
      response.status,
      body?.code || "REQUEST_FAILED",
      body?.message || `요청에 실패했습니다 (${response.status}).`,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const message = (error: unknown) =>
  error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";

export async function ensureLearnerToken(): Promise<string> {
  const existing = localStorage.getItem(TOKEN_KEY);
  if (existing) return existing;
  if (!navigator.locks?.request) {
    throw new ApiError(
      0,
      "IDENTITY_LOCK_UNAVAILABLE",
      "이 브라우저에서는 학습 키를 안전하게 만들 수 없습니다. HTTPS 또는 localhost에서 최신 브라우저로 다시 열어 주세요.",
    );
  }
  return navigator.locks.request("recall-learner-init", async () => {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored) return stored;
    const learner = await post<{ token: string }>("/learners", {});
    const replaced = localStorage.getItem(TOKEN_KEY);
    if (replaced) return replaced;
    localStorage.setItem(TOKEN_KEY, learner.token);
    return learner.token;
  });
}
