import { useCallback, useEffect, useState } from "react";
import {
  api,
  ensureLearnerToken,
  getApiLearnerToken,
  message,
  setApiLearnerToken,
  TOKEN_KEY,
} from "./api";
import {
  Empty,
  ErrorBox,
  Loading,
  formatDate,
  QuestionMeta,
  TagFilter,
} from "./components";
import { useResource } from "./hooks";
import type {
  Config,
  DashboardData,
  Question,
  SessionAnswer,
  Tag,
} from "./types";
import { Upload } from "./Upload";
import { Manage } from "./Manage";
import { Quiz } from "./Quiz";

type Page = "dashboard" | "upload" | "manage" | "quiz" | "reviews" | "results";
const pages: { id: Page; label: string; icon: string }[] = [
  { id: "dashboard", label: "학습 대시보드", icon: "▦" },
  { id: "upload", label: "PDF · 문제 생성", icon: "↥" },
  { id: "manage", label: "문제 보관함", icon: "▤" },
  { id: "quiz", label: "퀴즈 풀기", icon: "◈" },
  { id: "reviews", label: "오늘의 복습", icon: "↻" },
  { id: "results", label: "학습 결과 · 오답", icon: "◎" },
];
const readPage = (): Page =>
  pages.find((page) => `#${page.id}` === window.location.hash)?.id ||
  "dashboard";

export default function App() {
  const [page, setPage] = useState<Page>(readPage);
  const [config, setConfig] = useState<Config>();
  const [tags, setTags] = useState<Tag[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [invalid, setInvalid] = useState(false);
  const [identityChanged, setIdentityChanged] = useState(false);
  const [boot, setBoot] = useState(0);
  const [revision, setRevision] = useState(0);
  const [session, setSession] = useState<SessionAnswer[]>([]);
  const [quizMode, setQuizMode] = useState<"quiz" | "due">("quiz");
  const [quizRun, setQuizRun] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    const listener = () => setInvalid(true);
    const hash = () => setPage(readPage());
    const storage = (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== localStorage) return;
      if (event.key !== TOKEN_KEY && event.key !== null) return;
      if (localStorage.getItem(TOKEN_KEY) === getApiLearnerToken()) return;
      setApiLearnerToken(null);
      setReady(false);
      setSession([]);
      setInvalid(false);
      setIdentityChanged(true);
      setBoot((n) => n + 1);
    };
    window.addEventListener("recall:unauthorized", listener);
    window.addEventListener("hashchange", hash);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener("recall:unauthorized", listener);
      window.removeEventListener("hashchange", hash);
      window.removeEventListener("storage", storage);
    };
  }, []);
  useEffect(() => {
    let active = true;
    setError(undefined);
    setReady(false);
    async function start() {
      setApiLearnerToken(localStorage.getItem(TOKEN_KEY));
      const publicConfig = await api<Config>("/config");
      if (!active) return;
      const token = await ensureLearnerToken();
      if (!active) return;
      setApiLearnerToken(token);
      const loadedTags = await api<Tag[]>("/tags");
      if (active) {
        setConfig(publicConfig);
        setTags(loadedTags);
        setReady(true);
      }
    }
    start().catch((error) => {
      if (active) setError(message(error));
    });
    return () => {
      active = false;
    };
  }, [boot]);
  function navigate(target: Page) {
    window.location.hash = target;
    setPage(target);
    window.scrollTo?.({ top: 0, behavior: "smooth" });
  }
  function startQuiz(mode: "quiz" | "due") {
    setQuizMode(mode);
    setQuizRun((n) => n + 1);
    setSession([]);
    navigate("quiz");
  }
  function resetLearner() {
    if (
      !window.confirm(
        "새 학습자로 시작할까요? 이 브라우저에서 기존 학습 기록에 접근할 수 없게 됩니다. 서버의 기존 기록은 삭제되지 않습니다.",
      )
    )
      return;
    try {
      localStorage.removeItem(TOKEN_KEY);
      setApiLearnerToken(null);
      setInvalid(false);
      setSession([]);
      setBoot((n) => n + 1);
    } catch (error) {
      setError(message(error));
    }
  }
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        본문으로 건너뛰기
      </a>
      <aside className="sidebar">
        <a
          href="#dashboard"
          className="brand"
          onClick={() => navigate("dashboard")}
        >
          <span className="brand-mark">
            R<span>↗</span>
          </span>
          ReCall<span className="brand-dot">.</span>
        </a>
        <p className="brand-caption">배운 것을, 나의 것으로.</p>
        <div className="workspace">
          <span className="workspace-icon">OS</span>
          <div>
            <strong>{config?.courseName || "운영체제 학습"}</strong>
            <small>나의 학습 공간</small>
          </div>
        </div>
        <span className="nav-label">LEARNING SPACE</span>
        <nav aria-label="주 메뉴">
          {pages.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              aria-current={page === item.id ? "page" : undefined}
              className={page === item.id ? "active" : ""}
              onClick={() =>
                item.id === "quiz" ? startQuiz("quiz") : navigate(item.id)
              }
            >
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="small-label">조금씩, 오래 기억하기</span>
          <p>
            오늘의 짧은 복습이
            <br />
            내일의 확실한 지식으로.
          </p>
          <div className="learner">
            <span className="avatar">나</span>
            <span>
              개인 학습자<small>이 브라우저에 학습 키 저장</small>
            </span>
          </div>
        </div>
      </aside>
      <main id="main">
        <header className="topbar">
          <span>
            MY LEARNING /{" "}
            <strong>{pages.find((item) => item.id === page)?.label}</strong>
          </span>
          <span className="today">
            {new Intl.DateTimeFormat("ko-KR", {
              timeZone: "Asia/Seoul",
              month: "long",
              day: "numeric",
              weekday: "short",
            }).format(new Date())}
          </span>
        </header>
        <div className="content">
          {identityChanged && (
            <div className="notice" role="status">
              다른 탭에서 학습 키가 변경되어 학습 데이터를 다시 불러옵니다. 이전
              학습자의 화면과 이번 퀴즈 요약은 초기화되었습니다.
            </div>
          )}
          {invalid ? (
            <section className="card">
              <h1>학습 키를 확인해 주세요</h1>
              <p>
                저장된 학습 키가 서버에서 거부되었습니다 (401). 기존 키는
                자동으로 삭제하지 않았습니다.
              </p>
              <p>
                서버 상태를 확인한 뒤 다시 연결하거나, 기록 접근을 포기하고 새
                학습자로 시작할 수 있습니다.
              </p>
              <ErrorBox error={error} />
              <div className="actions">
                <button
                  onClick={() => {
                    setInvalid(false);
                    setBoot((n) => n + 1);
                  }}
                >
                  다시 연결
                </button>
                <button className="secondary" onClick={resetLearner}>
                  확인 후 새 학습자로 시작
                </button>
              </div>
            </section>
          ) : !ready ? (
            <>
              <ErrorBox error={error} retry={() => setBoot((n) => n + 1)} />
              {!error && <Loading />}
            </>
          ) : (
            <>
              {page === "dashboard" && (
                <Dashboard
                  revision={revision}
                  startQuiz={startQuiz}
                  navigate={navigate}
                />
              )}
              {page === "upload" && (
                <Upload
                  config={config!}
                  refresh={refresh}
                  navigate={(target) =>
                    target === "quiz" ? startQuiz("quiz") : navigate(target)
                  }
                />
              )}
              {page === "manage" && (
                <Manage tags={tags} revision={revision} refresh={refresh} />
              )}
              {page === "quiz" && (
                <Quiz
                  key={`${quizMode}-${quizRun}`}
                  tags={tags}
                  mode={quizMode}
                  session={session}
                  setSession={setSession}
                  refresh={refresh}
                  finish={() => navigate("results")}
                />
              )}
              {page === "reviews" && (
                <Reviews
                  tags={tags}
                  revision={revision}
                  start={() => startQuiz("due")}
                />
              )}
              {page === "results" && (
                <Results
                  tags={tags}
                  revision={revision}
                  session={session}
                  start={() => startQuiz("quiz")}
                />
              )}
              <footer>
                ReCall · 간격 반복으로 쌓는 나의 학습 기록
                <span>
                  운영체제 개념 분류는 임시 분류이며, 실제 강의계획서 검증
                  전입니다.
                </span>
              </footer>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Dashboard({
  revision,
  startQuiz,
  navigate,
}: {
  revision: number;
  startQuiz: (mode: "quiz" | "due") => void;
  navigate: (page: Page) => void;
}) {
  const { data, loading, error, reload } = useResource<DashboardData>(
    "/dashboard",
    revision,
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">A LITTLE EVERY DAY</span>
          <h1>다시 만나면, 더 오래 기억해요.</h1>
          <p>오늘의 학습을 확인하고, 기억을 한 단계 더 쌓아보세요.</p>
        </div>
        <button className="secondary" onClick={() => navigate("upload")}>
          ＋ 학습 자료 추가
        </button>
      </div>
      <ErrorBox error={error} retry={reload} />
      {loading && <Loading />}
      {data && (
        <>
          <section className="review-hero">
            <div>
              <span className="hero-tag">TODAY’S REVIEW</span>
              <h2>
                {data.dueCount ? (
                  <>
                    오늘 복습할 문제 <em>{data.dueCount}개</em>가 있어요.
                  </>
                ) : data.attemptCount === 0 ? (
                  "첫 학습을 시작해 보세요."
                ) : (
                  "오늘 복습할 문제가 없어요."
                )}
              </h2>
              <p>
                {data.dueCount
                  ? "잊기 전에 한 번 더. 작은 반복이 실력이 됩니다."
                  : data.attemptCount === 0
                    ? "아직 복습할 문제가 없어요. 첫 풀이를 마치면 내일부터 복습이 시작됩니다."
                    : "새로운 문제를 풀고 내일의 복습을 준비해 보세요."}
              </p>
              <button
                className="light"
                onClick={() =>
                  data.questionCount === 0
                    ? navigate("upload")
                    : startQuiz(data.dueCount ? "due" : "quiz")
                }
              >
                {data.dueCount
                  ? "오늘의 복습 시작"
                  : data.questionCount === 0
                    ? "학습 자료 준비하기"
                    : "새로운 퀴즈 풀기"}{" "}
                <span>↗</span>
              </button>
            </div>
            <div className="hero-art" aria-hidden="true">
              <div className="orbit orbit-one" />
              <div className="orbit orbit-two" />
              <div className="art-card back">↻</div>
              <div className="art-card front">
                기억<span>+1 step</span>
              </div>
              <span className="spark">✦</span>
            </div>
          </section>
          <div className="stats">
            <Stat
              label="보관 중인 문제"
              value={data.questionCount}
              unit="문제"
              detail="직접 만든 나의 문제 은행"
            />
            <Stat
              label="누적 풀이"
              value={data.attemptCount}
              unit="회"
              detail="반복할수록 단단해지는 기억"
            />
            <Stat
              label="전체 정답률"
              value={data.attemptCount ? `${Math.round(data.accuracy)}%` : "—"}
              detail={
                data.attemptCount
                  ? "모든 누적 풀이 기준"
                  : "첫 문제를 풀면 표시돼요"
              }
            />
          </div>
          <section className="card">
            <div className="section-heading">
              <div>
                <h2>개념별 학습 현황</h2>
                <p>잘 아는 개념과 조금 더 살펴볼 개념을 확인하세요.</p>
              </div>
              <button
                className="text-button"
                onClick={() => navigate("results")}
              >
                오답 살펴보기 →
              </button>
            </div>
            {!data.concepts.length ? (
              <Empty title="아직 쌓인 학습 기록이 없어요">
                <p>
                  PDF를 추가하거나 고정 데모 문제로 첫 학습을 시작해 보세요.
                </p>
                <button onClick={() => navigate("upload")}>
                  첫 문제 준비하기
                </button>
              </Empty>
            ) : (
              <div className="concepts">
                {data.concepts.map((concept) => (
                  <div className="concept-row" key={concept.tagId}>
                    <div>
                      <strong>{concept.tagName}</strong>
                      <small>
                        {concept.attemptCount}회 풀이 · 미해결 오답{" "}
                        {concept.unresolvedWrongCount}개
                      </small>
                    </div>
                    <div className="concept-progress">
                      <div className="meter">
                        <span style={{ width: `${concept.accuracy}%` }} />
                      </div>
                      <strong>
                        {concept.attemptCount
                          ? `${Math.round(concept.accuracy)}%`
                          : "—"}
                      </strong>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
          <div className="tip">
            <span aria-hidden="true">✦</span>
            <div>
              <strong>완벽하게 외우기보다, 적절한 때 다시 만나기.</strong>
              <p>
                첫 풀이 후 내일부터 복습해요. 정답이면 단계가 올라가고, 오답이면
                1단계로 돌아갑니다.
              </p>
            </div>
            <span className="pill neutral">1 · 3 · 7 · 14 · 30일</span>
          </div>
        </>
      )}
    </>
  );
}
function Stat({
  label,
  value,
  unit,
  detail,
}: {
  label: string;
  value: string | number;
  unit?: string;
  detail: string;
}) {
  return (
    <section className="stat card">
      <span>{label}</span>
      <div>
        <strong>{value}</strong>
        {unit && <small>{unit}</small>}
      </div>
      <p>{detail}</p>
    </section>
  );
}
function Reviews({
  revision,
  tags,
  start,
}: {
  revision: number;
  tags: Tag[];
  start: () => void;
}) {
  const { data, loading, error, reload } = useResource<Question[]>(
    "/questions?view=due",
    revision,
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">SPACED REPETITION</span>
          <h1>오늘의 복습</h1>
          <p>한국 시간 기준, 복습일이 오늘이거나 지난 문제만 모았어요.</p>
        </div>
        <button disabled={!data?.length} onClick={start}>
          복습 시작 →
        </button>
      </div>
      <ErrorBox error={error} retry={reload} />
      {loading && <Loading />}
      <div className="notice">
        미풀이 문제는 복습 대상이 아닙니다. 첫 풀이의 정오답과 무관하게
        1단계·내일 복습으로 시작하며, 이후 정답은 최대 5단계까지 올라갑니다.
        간격: 1 / 3 / 7 / 14 / 30일.
      </div>
      {data &&
        (data.length ? (
          <div className="question-list">
            {data.map((question) => (
              <article className="card" key={question.id}>
                <QuestionMeta question={question} tags={tags} />
                <h3>{question.text}</h3>
                <p className="muted">
                  {question.box}단계 · 복습일 {formatDate(question.dueDate)}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <Empty title="지금 복습할 문제가 없어요">
            <p>다음 복습일에 다시 만나거나 새 퀴즈를 풀어 보세요.</p>
          </Empty>
        ))}
    </>
  );
}
function Results({
  revision,
  tags,
  session,
  start,
}: {
  revision: number;
  tags: Tag[];
  session: SessionAnswer[];
  start: () => void;
}) {
  const [tag, setTag] = useState("");
  const resource = useResource<Question[]>(
    `/questions?view=mistakes${tag ? `&tagId=${encodeURIComponent(tag)}` : ""}`,
    revision,
  );
  const stats = useResource<DashboardData>("/dashboard", revision);
  const grouped = (resource.data || []).reduce<Record<string, Question[]>>(
    (acc, question) => {
      (acc[question.tagId] ||= []).push(question);
      return acc;
    },
    {},
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">REFLECT & GROW</span>
          <h1>학습 결과 · 오답</h1>
          <p>틀린 문제는 실패가 아니라, 다음에 기억할 기회예요.</p>
        </div>
        <button onClick={start}>새 퀴즈 시작</button>
      </div>
      <section className="card">
        <h2>이번 퀴즈 결과</h2>
        {session.length ? (
          <>
            <div className="session-score">
              <strong>
                {session.filter((item) => item.attempt.correct).length}
                <small> / {session.length} 정답</small>
              </strong>
              <span>
                {Math.round(
                  (session.filter((item) => item.attempt.correct).length /
                    session.length) *
                    100,
                )}
                % 정답률
              </span>
            </div>
            <p className="muted">
              현재 브라우저 화면에서 완료한 풀이 요약입니다. 페이지를
              새로고침하면 아래 서버 누적 기록으로 확인할 수 있어요.
            </p>
            {session
              .filter((item) => !item.attempt.correct)
              .map((item) => (
                <div className="session-wrong" key={item.attempt.id}>
                  <QuestionMeta question={item.question} tags={tags} />
                  <h3>{item.question.text}</h3>
                  <p>
                    정답: {item.question.options[item.attempt.correctIndex]}
                  </p>
                  <p>{item.attempt.explanation}</p>
                </div>
              ))}
          </>
        ) : (
          <p className="muted">
            이번 세션의 풀이가 아직 없어요. 서버에 저장된 누적 결과는 아래에서
            확인하세요.
          </p>
        )}
      </section>
      <section className="card">
        <div className="section-heading">
          <div>
            <h2>개념별 누적 기록</h2>
            <p>
              정답률은 과거의 모든 풀이 기준입니다. 미해결 오답은 가장 최근
              풀이가 오답인 문제로, 다시 맞히면 목록에서 빠집니다.
            </p>
          </div>
        </div>
        <ErrorBox error={stats.error} retry={stats.reload} />
        {stats.loading && <Loading />}
        {stats.data && (
          <div className="concepts">
            {stats.data.concepts.map((item) => (
              <div className="concept-row" key={item.tagId}>
                <strong>{item.tagName}</strong>
                <span>
                  {item.correctCount}/{item.attemptCount}회 정답 ·{" "}
                  {item.attemptCount ? `${Math.round(item.accuracy)}%` : "—"} ·
                  미해결 {item.unresolvedWrongCount}개
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      <div className="section-heading">
        <h2>아직 해결하지 못한 문제</h2>
        <TagFilter tags={tags} value={tag} onChange={setTag} />
      </div>
      <ErrorBox error={resource.error} retry={resource.reload} />
      {resource.loading && <Loading />}
      {resource.data &&
        (resource.data.length ? (
          Object.entries(grouped).map(([id, questions]) => (
            <section key={id} className="mistake-group">
              <h3>
                {tags.find((item) => String(item.id) === id)?.name || "미분류"}{" "}
                <span className="pill">{questions.length}개</span>
              </h3>
              {questions.map((question) => (
                <article key={question.id} className="card">
                  <QuestionMeta question={question} tags={tags} />
                  <h3>{question.text}</h3>
                  <p>
                    {question.correctIndex != null
                      ? `정답: ${question.options[question.correctIndex]}`
                      : "퀴즈를 제출하면 정답과 해설을 확인할 수 있어요."}
                  </p>
                  {question.explanation && (
                    <p className="explanation">{question.explanation}</p>
                  )}
                  <p className="muted">복습일 {formatDate(question.dueDate)}</p>
                </article>
              ))}
            </section>
          ))
        ) : (
          <Empty title="미해결 오답이 없어요">
            <p>아직 풀이하지 않았거나, 최근 풀이에서 모두 맞혔어요.</p>
          </Empty>
        ))}
    </>
  );
}
