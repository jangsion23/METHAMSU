import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, describe, it, expect } from "vitest";
import App from "./App";
import { TOKEN_KEY } from "./api";
import type { Question } from "./types";

const question: Question = {
  id: "q1",
  text: "프로세스 간 CPU 실행을 바꾸는 작업은 무엇인가요?",
  options: ["문맥 교환", "페이지 교체", "디스크 포맷", "파일 압축"],
  tagId: "process",
  difficulty: "EASY",
  sourceStartPage: null,
  sourceEndPage: null,
  documentName: null,
  mode: "DEMO",
  version: 1,
  box: 0,
  dueDate: null,
  latestCorrect: null,
};
const explanation =
  "문맥 교환은 실행 상태를 저장하고 다음 프로세스의 상태를 복원하는 작업입니다.";
const attempt = {
  id: "a1",
  questionId: "q1",
  selectedIndex: 0,
  correct: true,
  correctIndex: 0,
  explanation,
  box: 1,
  dueDate: "2026-09-18",
};
const job = {
  id: "job1",
  documentId: null,
  mode: "DEMO",
  status: "succeeded",
  totalChunks: 1,
  completedChunks: 1,
  failedChunks: 0,
  questionCount: 1,
  error: null,
  createdAt: "2026-09-17T00:00:00Z",
  chunks: [
    {
      index: 0,
      status: "succeeded",
      attempts: 1,
      durationMs: 10,
      inputTokens: 0,
      outputTokens: 0,
      error: null,
    },
  ],
};
const reply = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function mockServer(
  overrides?: (
    path: string,
    init: RequestInit,
  ) => Response | Promise<Response> | undefined,
) {
  let generated = false;
  let answered = false;
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, options: RequestInit = {}) => {
      const path = String(input);
      const override = overrides?.(path, options);
      if (override) return override;
      if (path === "/api/config")
        return reply({
          liveEnabled: false,
          courseName: "운영체제",
          timezone: "Asia/Seoul",
        });
      if (path === "/api/learners")
        return reply({ token: "server-token" }, 201);
      if (path === "/api/tags")
        return reply([{ id: "process", name: "프로세스" }]);
      if (path === "/api/dashboard")
        return reply({
          dueCount: 0,
          questionCount: generated ? 1 : 0,
          attemptCount: answered ? 1 : 0,
          accuracy: answered ? 100 : 0,
          concepts: answered
            ? [
                {
                  tagId: "process",
                  tagName: "프로세스",
                  attemptCount: 1,
                  correctCount: 1,
                  accuracy: 100,
                  unresolvedWrongCount: 0,
                },
              ]
            : [],
        });
      if (path === "/api/documents") return reply([]);
      if (path === "/api/jobs" && options.method === "POST") {
        generated = true;
        return reply(job, 202);
      }
      if (path === "/api/jobs") return reply(generated ? [job] : []);
      if (path === "/api/jobs/job1") return reply(job);
      if (path === "/api/questions?view=quiz")
        return reply(generated ? [question] : []);
      if (
        path === "/api/questions?view=mistakes" ||
        path === "/api/questions?view=due"
      )
        return reply([]);
      if (path === "/api/attempts") {
        answered = true;
        return reply(attempt, 201);
      }
      throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ReCall real API workflows", () => {
  it("creates a learner and completes the key-free DEMO → quiz → feedback → results flow", async () => {
    const fetchMock = mockServer((path) =>
      path === "/api/documents"
        ? reply([
            {
              id: "d1",
              name: "선택된-강의자료.pdf",
              pageCount: 4,
              createdAt: "2026-09-17T00:00:00Z",
            },
          ])
        : undefined,
    );
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("다시 만나면, 더 오래 기억해요.");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("server-token");
    expect(screen.getByText("첫 문제를 풀면 표시돼요")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "첫 학습을 시작해 보세요." }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("오늘의 복습을 모두 마쳤어요."),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "＋ 학습 자료 추가" }));
    await screen.findByRole("button", { name: "고정 데모 문제 만들기 →" });
    await screen.findByRole("option", { name: "선택된-강의자료.pdf (4쪽)" });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "자료 선택" }),
      "d1",
    );
    expect(
      screen.getByRole("button", { name: "PDF로 AI 문제 생성" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "고정 데모 문제 만들기 →" }),
    );
    await screen.findByText("1문제 저장");
    const creation = fetchMock.mock.calls.find(
      ([path, options]) => path === "/api/jobs" && options?.method === "POST",
    );
    expect(JSON.parse(creation![1]!.body as string)).toEqual({ mode: "DEMO" });
    await user.click(screen.getByRole("button", { name: "퀴즈 풀기 →" }));
    await screen.findByText(question.text);
    expect(
      screen.getByText("고정 데모 예제 · 업로드 PDF와 무관"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/선택된-강의자료.pdf/)).not.toBeInTheDocument();
    expect(screen.queryByText(explanation)).not.toBeInTheDocument();
    expect(screen.queryByText("정답")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "답안 제출" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "1 문맥 교환" }));
    await user.click(screen.getByRole("button", { name: "답안 제출" }));
    await screen.findByText(explanation);
    expect(
      screen.getByText(/현재 1단계 · 다음 복습 2026.09.18/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "답안 제출" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "학습 결과 확인 →" }));
    await screen.findByText("100% 정답률");
    await screen.findByText("미해결 오답이 없어요");
    const submitted = fetchMock.mock.calls.find(
      ([path]) => path === "/api/attempts",
    );
    expect(JSON.parse(submitted![1]!.body as string)).toEqual({
      questionId: "q1",
      selectedIndex: 0,
      version: 1,
      idempotencyKey: expect.any(String),
    });
    for (const [path, options] of fetchMock.mock.calls) {
      if (path !== "/api/config" && path !== "/api/learners")
        expect(new Headers(options?.headers).get("X-Learner-Token")).toBe(
          "server-token",
        );
    }
    expect(
      fetchMock.mock.calls.some(([path]) =>
        String(path).includes("view=manage"),
      ),
    ).toBe(false);
  });

  it.each([
    { attemptCount: 0, title: "첫 학습을 시작해 보세요." },
    { attemptCount: 1, title: "오늘 복습할 문제가 없어요." },
  ])(
    "does not claim completed reviews when $attemptCount answers exist and nothing is due",
    async ({ attemptCount, title }) => {
      mockServer((path) =>
        path === "/api/dashboard"
          ? reply({
              dueCount: 0,
              questionCount: 4,
              attemptCount,
              accuracy: 0,
              concepts: [],
            })
          : undefined,
      );
      render(<App />);
      await screen.findByRole("heading", { name: title });
      expect(
        screen.queryByText("오늘의 복습을 모두 마쳤어요."),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "새로운 퀴즈 풀기 ↗" }),
      ).toBeInTheDocument();
    },
  );

  it("shows network errors and retries instead of displaying fabricated dashboard data", async () => {
    let failed = true;
    mockServer((path) =>
      path === "/api/dashboard" && failed
        ? Promise.reject(new TypeError("Failed to fetch"))
        : undefined,
    );
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "서버에 연결할 수 없습니다.",
    );
    expect(screen.queryByText("보관 중인 문제")).not.toBeInTheDocument();
    failed = false;
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    await screen.findByText("보관 중인 문제");
  });

  it("preserves an invalid learner token until a new learner is explicitly confirmed", async () => {
    localStorage.setItem(TOKEN_KEY, "invalid-token");
    const fetchMock = mockServer((path) =>
      path === "/api/tags" &&
      localStorage.getItem(TOKEN_KEY) === "invalid-token"
        ? reply(
            {
              code: "INVALID_LEARNER",
              message: "학습 키가 유효하지 않습니다.",
            },
            401,
          )
        : undefined,
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("학습 키를 확인해 주세요");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("invalid-token");
    expect(
      fetchMock.mock.calls.some(([path]) => path === "/api/learners"),
    ).toBe(false);
    await user.click(
      screen.getByRole("button", { name: "확인 후 새 학습자로 시작" }),
    );
    expect(localStorage.getItem(TOKEN_KEY)).toBe("invalid-token");
    confirm.mockReturnValue(true);
    await user.click(
      screen.getByRole("button", { name: "확인 후 새 학습자로 시작" }),
    );
    await screen.findByText("보관 중인 문제");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("server-token");
  });

  it("clears loaded learner data and reloads the new identity after another tab changes storage", async () => {
    localStorage.setItem(TOKEN_KEY, "learner-A");
    let resolveDashboard: ((response: Response) => void) | undefined;
    const dashboard = (tagName: string) => ({
      dueCount: 0,
      questionCount: 1,
      attemptCount: 1,
      accuracy: 100,
      concepts: [
        {
          tagId: "process",
          tagName,
          attemptCount: 1,
          correctCount: 1,
          accuracy: 100,
          unresolvedWrongCount: 0,
        },
      ],
    });
    const fetchMock = mockServer((path, options) => {
      if (path !== "/api/dashboard") return undefined;
      if (new Headers(options.headers).get("X-Learner-Token") === "learner-A")
        return reply(dashboard("학습자 A의 개념"));
      return new Promise<Response>((resolve) => {
        resolveDashboard = resolve;
      });
    });
    render(<App />);
    await screen.findByText("학습자 A의 개념");
    act(() => {
      localStorage.setItem(TOKEN_KEY, "learner-B");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: TOKEN_KEY,
          oldValue: "learner-A",
          newValue: "learner-B",
          storageArea: localStorage,
        }),
      );
    });
    await screen.findByText(/다른 탭에서 학습 키가 변경되어/);
    expect(screen.queryByText("학습자 A의 개념")).not.toBeInTheDocument();
    await waitFor(() => expect(resolveDashboard).toBeDefined());
    await act(async () =>
      resolveDashboard!(reply(dashboard("학습자 B의 개념"))),
    );
    await screen.findByText("학습자 B의 개념");
    expect(screen.queryByText("학습자 A의 개념")).not.toBeInTheDocument();
    const dashboardCalls = fetchMock.mock.calls.filter(
      ([path]) => path === "/api/dashboard",
    );
    expect(
      new Headers(dashboardCalls.at(-1)![1]?.headers).get("X-Learner-Token"),
    ).toBe("learner-B");
    expect(
      fetchMock.mock.calls.some(([path]) => path === "/api/learners"),
    ).toBe(false);
  });

  it("reuses idempotency keys after uncertain submission and prevents duplicate clicks", async () => {
    window.location.hash = "quiz";
    let attempts = 0;
    let resolveRetry: ((response: Response) => void) | undefined;
    const fetchMock = mockServer((path) => {
      if (path === "/api/questions?view=quiz") return reply([question]);
      if (path === "/api/attempts") {
        attempts++;
        if (attempts === 1)
          return Promise.reject(new TypeError("Lost response"));
        return new Promise<Response>((resolve) => {
          resolveRetry = resolve;
        });
      }
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(question.text);
    await user.click(screen.getByRole("radio", { name: "1 문맥 교환" }));
    await user.click(screen.getByRole("button", { name: "답안 제출" }));
    await screen.findByRole("button", { name: "같은 답안 다시 제출" });
    expect(screen.getByRole("radio", { name: "2 페이지 교체" })).toBeDisabled();
    await user.dblClick(
      screen.getByRole("button", { name: "같은 답안 다시 제출" }),
    );
    expect(attempts).toBe(2);
    const calls = fetchMock.mock.calls.filter(
      ([path]) => path === "/api/attempts",
    );
    expect(calls[0][1]?.body).toBe(calls[1][1]?.body);
    await act(async () => resolveRetry!(reply(attempt, 201)));
    await screen.findByText(explanation);
  });

  it("handles stale question conflicts by requiring an explicit refresh", async () => {
    window.location.hash = "quiz";
    let questionRequests = 0;
    mockServer((path) => {
      if (path === "/api/questions?view=quiz") {
        questionRequests++;
        return reply([{ ...question, version: questionRequests }]);
      }
      if (path === "/api/attempts")
        return reply(
          { code: "STALE_VERSION", message: "문제가 수정되었습니다." },
          409,
        );
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(question.text);
    await user.click(screen.getByRole("radio", { name: "1 문맥 교환" }));
    await user.click(screen.getByRole("button", { name: "답안 제출" }));
    await screen.findByRole("button", { name: "최신 문제 불러오기" });
    expect(screen.queryByText(explanation)).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "1 문맥 교환" })).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "최신 문제 불러오기" }),
    );
    await waitFor(() => expect(questionRequests).toBe(2));
    expect(
      await screen.findByRole("button", { name: "답안 제출" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("radio", { name: "1 문맥 교환" }),
    ).not.toBeChecked();
  });

  it("skips a deleted first question after 404 and completes the next question without retry locking", async () => {
    window.location.hash = "quiz";
    const nextQuestion = {
      ...question,
      id: "q2",
      text: "두 번째 문제를 풀어 보세요.",
    };
    const fetchMock = mockServer((path, options) => {
      if (path === "/api/questions?view=quiz")
        return reply([question, nextQuestion]);
      if (path === "/api/attempts") {
        const body = JSON.parse(options.body as string);
        return body.questionId === "q1"
          ? reply(
              { code: "QUESTION_NOT_FOUND", message: "삭제된 문제입니다." },
              404,
            )
          : reply({ ...attempt, id: "a2", questionId: "q2" });
      }
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(question.text);
    await user.click(screen.getByRole("radio", { name: "1 문맥 교환" }));
    await user.click(screen.getByRole("button", { name: "답안 제출" }));
    await screen.findByRole("button", { name: "다음 문제로 건너뛰기" });
    expect(
      screen.queryByRole("button", { name: "같은 답안 다시 제출" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "답안 제출" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "다음 문제로 건너뛰기" }),
    );
    await screen.findByText(nextQuestion.text);
    expect(
      screen.getByRole("radio", { name: "1 문맥 교환" }),
    ).not.toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "1 문맥 교환" }));
    await user.click(screen.getByRole("button", { name: "답안 제출" }));
    await screen.findByText(explanation);
    await user.click(screen.getByRole("button", { name: "학습 결과 확인 →" }));
    await screen.findByText("100% 정답률");
    expect(screen.getByText("/ 1 정답")).toBeInTheDocument();
    const submissions = fetchMock.mock.calls
      .filter(([path]) => path === "/api/attempts")
      .map(([, options]) => JSON.parse(options!.body as string).questionId);
    expect(submissions).toEqual(["q1", "q2"]);
  });

  it("displays partial job errors while retaining successful questions and actual page sources", async () => {
    window.location.hash = "upload";
    mockServer((path) => {
      const partial = {
        ...job,
        mode: "LIVE",
        documentId: "d1",
        status: "partial",
        totalChunks: 2,
        failedChunks: 1,
        error: "일부 구간 생성 실패",
        chunks: [
          ...job.chunks,
          {
            index: 1,
            status: "failed",
            attempts: 3,
            durationMs: 3500,
            inputTokens: 30,
            outputTokens: 0,
            error: "요청 시간 초과",
          },
        ],
      };
      if (path === "/api/jobs") return reply([partial]);
      if (path === "/api/jobs/job1") return reply(partial);
      if (path === "/api/questions?view=manage")
        return reply([
          {
            ...question,
            mode: "LIVE",
            sourceStartPage: 7,
            sourceEndPage: 9,
            documentName: "운영체제.pdf",
            correctIndex: 0,
            explanation,
          },
        ]);
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(
      "일부 구간에 실패했습니다. 저장된 1개 문제는 보관함에서 확인하고 바로 풀 수 있습니다.",
    );
    await user.click(screen.getByText("구간별 처리 상세"));
    expect(screen.getByText("요청 시간 초과")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "생성된 문제 확인" }));
    await screen.findByText("운영체제.pdf · 실제 PDF 7–9쪽");
  });

  it("validates PDF uploads locally and presents server upload errors", async () => {
    window.location.hash = "upload";
    const fetchMock = mockServer((path, options) =>
      path === "/api/documents" && options.method === "POST"
        ? reply(
            {
              code: "NO_TEXT",
              message: "텍스트가 없는 PDF는 지원하지 않습니다.",
            },
            422,
          )
        : undefined,
    );
    const user = userEvent.setup({ applyAccept: false });
    render(<App />);
    await screen.findByText("자료를 문제로, 지식을 기억으로.");
    const input = document.getElementById("pdf-file") as HTMLInputElement;
    await user.upload(
      input,
      new File(["invalid"], "notes.txt", { type: "text/plain" }),
    );
    await user.click(screen.getByRole("button", { name: "PDF 업로드" }));
    await screen.findByText("PDF 파일만 업로드할 수 있습니다.");
    expect(
      fetchMock.mock.calls.some(
        ([path, options]) =>
          path === "/api/documents" && options?.method === "POST",
      ),
    ).toBe(false);
    await user.upload(
      input,
      new File(["%PDF-1.4"], "scan.pdf", { type: "application/pdf" }),
    );
    await user.click(screen.getByRole("button", { name: "PDF 업로드" }));
    await screen.findByText("텍스트가 없는 PDF는 지원하지 않습니다.");
    const upload = fetchMock.mock.calls.find(
      ([path, options]) =>
        path === "/api/documents" && options?.method === "POST",
    );
    expect(upload![1]?.body).toBeInstanceOf(FormData);
    expect(new Headers(upload![1]?.headers).has("Content-Type")).toBe(false);
  });

  it("warns and confirms editing resets before saving, then refreshes and deletes", async () => {
    window.location.hash = "manage";
    let current = { ...question, correctIndex: 0, explanation };
    let deleted = false;
    const fetchMock = mockServer((path, options) => {
      if (path === "/api/questions?view=manage")
        return reply(deleted ? [] : [current]);
      if (path === "/api/questions/q1" && options.method === "PUT") {
        current = { ...current, ...JSON.parse(options.body as string) };
        return reply(current);
      }
      if (path === "/api/questions/q1" && options.method === "DELETE") {
        deleted = true;
        return reply(null, 204);
      }
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(question.text);
    await user.click(screen.getByRole("button", { name: "수정" }));
    const text = screen.getByRole("textbox", { name: "문제" });
    await user.clear(text);
    await user.type(text, "수정한 프로세스 문제");
    await user.click(
      screen.getByRole("button", { name: "초기화 확인 후 저장" }),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("기존 풀이 기록과 복습 일정이 초기화"),
    );
    await screen.findByText("수정한 프로세스 문제");
    const put = fetchMock.mock.calls.find(
      ([, options]) => options?.method === "PUT",
    );
    expect(JSON.parse(put![1]!.body as string).version).toBe(1);
    await user.click(screen.getByRole("button", { name: "삭제" }));
    await screen.findByText("보관된 문제가 없어요");
  });
});
