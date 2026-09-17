import { useEffect, useRef, useState } from "react";
import { ApiError, message, post } from "./api";
import {
  Empty,
  ErrorBox,
  Loading,
  QuestionMeta,
  TagFilter,
  formatDate,
} from "./components";
import { useResource } from "./hooks";
import type { Attempt, Question, SessionAnswer, Tag } from "./types";

export function Quiz({
  tags,
  mode,
  session,
  setSession,
  refresh,
  finish,
}: {
  tags: Tag[];
  mode: "quiz" | "due";
  session: SessionAnswer[];
  setSession: React.Dispatch<React.SetStateAction<SessionAnswer[]>>;
  refresh: () => void;
  finish: () => void;
}) {
  const [tag, setTag] = useState("");
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [answer, setAnswer] = useState<Attempt>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [retryLocked, setRetryLocked] = useState(false);
  const submission = useRef<{
    questionId: string;
    selectedIndex: number;
    key: string;
  } | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const resource = useResource<Question[]>(
    `/questions?view=${mode}${tag ? `&tagId=${encodeURIComponent(tag)}` : ""}`,
  );
  const question = resource.data?.[index];
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function resetQuestion() {
    setSelected(null);
    setAnswer(undefined);
    setError(undefined);
    setStale(false);
    setUnavailable(false);
    setRetryLocked(false);
    submission.current = null;
  }
  function filter(value: string) {
    setTag(value);
    setIndex(0);
    resetQuestion();
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (
      !question ||
      selected == null ||
      busyRef.current ||
      answer ||
      stale ||
      unavailable
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    if (
      !submission.current ||
      submission.current.questionId !== question.id ||
      submission.current.selectedIndex !== selected
    ) {
      submission.current = {
        questionId: question.id,
        selectedIndex: selected,
        key: crypto.randomUUID(),
      };
    }
    try {
      const result = await post<Attempt>("/attempts", {
        questionId: question.id,
        selectedIndex: selected,
        idempotencyKey: submission.current.key,
        version: question.version,
      });
      refresh();
      if (!mounted.current) return;
      setSession((items) =>
        items.some((item) => item.attempt.id === result.id)
          ? items
          : [...items, { question, attempt: result }],
      );
      setAnswer(result);
      setRetryLocked(false);
    } catch (error) {
      if (!mounted.current) return;
      setError(message(error));
      if (error instanceof ApiError && error.status === 409) setStale(true);
      if (error instanceof ApiError && error.status === 404)
        setUnavailable(true);
      // A lost response may already have been committed; retry the exact submission.
      setRetryLocked(
        !(error instanceof ApiError) ||
          error.status === 0 ||
          error.status === 408 ||
          error.status >= 500,
      );
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function next() {
    setIndex((n) => n + 1);
    resetQuestion();
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            {mode === "due" ? "TODAY’S REVIEW" : "ONE QUESTION AT A TIME"}
          </span>
          <h1>{mode === "due" ? "복습 퀴즈" : "퀴즈 풀기"}</h1>
          <p>정답은 제출한 뒤에 공개됩니다. 차분하게 생각해 보세요.</p>
        </div>
        <button className="secondary" disabled={busy} onClick={finish}>
          지금까지의 결과
        </button>
      </div>
      <fieldset className="filter-fieldset" disabled={busy || retryLocked}>
        <TagFilter tags={tags} value={tag} onChange={filter} />
      </fieldset>
      <ErrorBox
        error={resource.error}
        retry={() => {
          setIndex(0);
          resetQuestion();
          resource.reload();
        }}
      />
      {resource.loading && <Loading />}
      {resource.data &&
        (!resource.data.length ? (
          <Empty
            title={
              mode === "due"
                ? "지금 복습할 문제가 없어요"
                : "풀 수 있는 문제가 없어요"
            }
          >
            <p>
              다른 개념을 선택하거나 PDF · 문제 생성에서 문제를 추가해 주세요.
            </p>
            <a className="button" href="#upload">
              문제 준비하기
            </a>
          </Empty>
        ) : !question ? (
          <section className="card empty">
            <h2>이번 문제를 모두 풀었어요!</h2>
            <p>오늘 쌓은 기억을 결과에서 확인하세요.</p>
            <button onClick={finish}>학습 결과 확인 →</button>
          </section>
        ) : (
          <section className="card quiz-card">
            <div className="quiz-progress">
              <span>
                QUESTION {String(index + 1).padStart(2, "0")}{" "}
                <small>/ {resource.data.length}</small>
              </span>
              <span>이번 세션 {session.length}회 제출</span>
            </div>
            <progress
              aria-label="퀴즈 진행률"
              max={resource.data.length}
              value={index + (answer ? 1 : 0)}
            />
            <QuestionMeta question={question} tags={tags} />
            <h2 className="question-text">{question.text}</h2>
            <form onSubmit={submit}>
              <fieldset
                className="options"
                disabled={
                  busy || !!answer || stale || unavailable || retryLocked
                }
              >
                <legend className="sr-only">정답을 하나 선택하세요</legend>
                {question.options.map((option, optionIndex) => (
                  <label
                    key={optionIndex}
                    className={`option ${selected === optionIndex ? "selected" : ""} ${answer && answer.correctIndex === optionIndex ? "correct" : ""} ${answer && selected === optionIndex && !answer.correct ? "incorrect" : ""}`}
                  >
                    <input
                      type="radio"
                      name="answer"
                      value={optionIndex}
                      checked={selected === optionIndex}
                      onChange={() => setSelected(optionIndex)}
                    />
                    <span className="option-number">{optionIndex + 1}</span>
                    <span>{option}</span>
                    {answer && answer.correctIndex === optionIndex && (
                      <strong className="option-result">정답</strong>
                    )}
                  </label>
                ))}
              </fieldset>
              <ErrorBox error={error} />
              {stale && (
                <div className="notice">
                  <p>
                    문제가 수정되었거나 더 이상 풀 수 없습니다 (409). 최신
                    문제를 다시 불러와 선택해 주세요. 이전 제출을 자동으로 다시
                    전송하지 않습니다.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setIndex(0);
                      resetQuestion();
                      resource.reload();
                    }}
                  >
                    최신 문제 불러오기
                  </button>
                </div>
              )}
              {unavailable && (
                <div className="notice">
                  <p>
                    문제가 삭제되었거나 더 이상 사용할 수 없습니다 (404). 이
                    답안은 다시 전송하지 않습니다. 완료한 다른 풀이 결과는
                    유지됩니다.
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      onClick={index + 1 < resource.data.length ? next : finish}
                    >
                      {index + 1 < resource.data.length
                        ? "다음 문제로 건너뛰기"
                        : "지금까지의 결과 보기"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setIndex(0);
                        resetQuestion();
                        resource.reload();
                      }}
                    >
                      문제 목록 새로 불러오기
                    </button>
                  </div>
                </div>
              )}
              {!answer && !stale && !unavailable && (
                <div className="quiz-actions">
                  <span className="muted">
                    {retryLocked
                      ? "같은 선택과 요청 키로 안전하게 재시도합니다."
                      : "한 번의 제출이 복습 일정에 반영됩니다."}
                  </span>
                  <button type="submit" disabled={selected == null || busy}>
                    {busy
                      ? "제출 중…"
                      : retryLocked
                        ? "같은 답안 다시 제출"
                        : "답안 제출"}
                  </button>
                </div>
              )}
            </form>
            {answer && (
              <div
                className={`feedback ${answer.correct ? "right" : "wrong"}`}
                role="status"
              >
                <h3>
                  {answer.correct
                    ? "정답이에요. 잘 기억하고 있네요!"
                    : "괜찮아요. 지금 다시 기억하면 돼요."}
                </h3>
                <p>
                  <strong>정답 {answer.correctIndex + 1}.</strong>{" "}
                  {question.options[answer.correctIndex]}
                </p>
                <p className="explanation">{answer.explanation}</p>
                <p className="muted">
                  현재 {answer.box}단계 · 다음 복습 {formatDate(answer.dueDate)}{" "}
                  (한국 시간)
                </p>
                <button
                  onClick={index + 1 === resource.data.length ? finish : next}
                >
                  {index + 1 === resource.data.length
                    ? "학습 결과 확인 →"
                    : "다음 문제 →"}
                </button>
              </div>
            )}
          </section>
        ))}
    </>
  );
}
