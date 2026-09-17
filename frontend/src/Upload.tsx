import { useEffect, useRef, useState } from "react";
import { api, message, post } from "./api";
import { Empty, ErrorBox, Loading } from "./components";
import { useResource } from "./hooks";
import type { Config, DocumentInfo, Job } from "./types";

const statusLabel = {
  queued: "대기 중",
  running: "생성 중",
  succeeded: "생성 완료",
  partial: "일부 생성 완료",
  failed: "생성 실패",
};
const terminal = (job: Job) =>
  ["succeeded", "partial", "failed"].includes(job.status);

export function Upload({
  config,
  refresh,
  navigate,
}: {
  config: Config;
  refresh: () => void;
  navigate: (page: "manage" | "quiz") => void;
}) {
  const documents = useResource<DocumentInfo[]>("/documents");
  const [file, setFile] = useState<File>();
  const [documentId, setDocumentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [jobs, setJobs] = useState<Job[]>();
  const [job, setJob] = useState<Job>();
  const [selectedJob, setSelectedJob] = useState("");
  const [pollError, setPollError] = useState<string>();
  const [pollRevision, setPollRevision] = useState(0);
  const busyRef = useRef(false);
  const knownStatuses = useRef(new Map<string, string>());
  const mounted = useRef(true);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setJob(undefined);
    async function poll() {
      try {
        const allJobs = await api<Job[]>("/jobs", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setJobs(allJobs);
        for (const item of allJobs) {
          const previous = knownStatuses.current.get(item.id);
          if (previous && previous !== item.status && terminal(item)) refresh();
          knownStatuses.current.set(item.id, item.status);
        }
        const target = selectedJob || allJobs[0]?.id;
        if (target) {
          const detail = await api<Job>(`/jobs/${target}`, {
            signal: controller.signal,
          });
          if (!controller.signal.aborted) setJob(detail);
        }
        if (!controller.signal.aborted) {
          setPollError(undefined);
          if (allJobs.some((item) => !terminal(item)))
            timer = setTimeout(poll, 1800);
        }
      } catch (error) {
        if (!controller.signal.aborted) setPollError(message(error));
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [selectedJob, pollRevision, refresh]);

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (!file || busyRef.current) return;
    setError(undefined);
    setSuccess(undefined);
    if (
      !/\.pdf$/i.test(file.name) ||
      (file.type && file.type !== "application/pdf")
    ) {
      setError("PDF 파일만 업로드할 수 있습니다.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("파일 크기는 최대 10MB입니다.");
      return;
    }
    if (file.size === 0) {
      setError("빈 파일은 업로드할 수 없습니다.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const uploaded = await api<DocumentInfo>("/documents", {
        method: "POST",
        body: form,
      });
      if (!mounted.current) return;
      setDocumentId(uploaded.id);
      setFile(undefined);
      if (fileRef.current) fileRef.current.value = "";
      setSuccess(
        `“${uploaded.name}” 업로드 완료 · 실제 PDF ${uploaded.pageCount}쪽`,
      );
      documents.reload();
      refresh();
    } catch (error) {
      if (mounted.current) setError(message(error));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function generate(mode: "DEMO" | "LIVE") {
    if (busyRef.current) return;
    if (mode === "LIVE" && (!config.liveEnabled || !documentId)) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      const created = await post<Job>(
        "/jobs",
        mode === "DEMO" ? { mode } : { mode, documentId },
      );
      if (!mounted.current) return;
      setJob(created);
      setSelectedJob(created.id);
      setPollRevision((n) => n + 1);
      knownStatuses.current.set(created.id, created.status);
      setSuccess(
        mode === "DEMO"
          ? "고정 데모 문제 준비를 시작했습니다. 업로드한 PDF를 사용하지 않습니다."
          : "PDF 문제 생성을 시작했습니다. 진행 상황을 아래에서 확인하세요.",
      );
      refresh();
    } catch (error) {
      if (mounted.current) setError(message(error));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">FROM READING TO RECALL</span>
          <h1>자료를 문제로, 지식을 기억으로.</h1>
          <p>텍스트 PDF를 올리고 나만의 운영체제 문제를 만들어 보세요.</p>
        </div>
        <span className={`pill ${config.liveEnabled ? "" : "neutral"}`}>
          {config.liveEnabled ? "AI 생성 사용 가능" : "AI 생성 비활성"}
        </span>
      </div>
      <ErrorBox error={error} />
      {success && (
        <div className="notice success" role="status">
          {success}
        </div>
      )}
      <div className="upload-grid">
        <section className="card">
          <span className="eyebrow">01 / YOUR MATERIAL</span>
          <h2>PDF 자료 업로드</h2>
          <form onSubmit={upload}>
            <label className="dropzone" htmlFor="pdf-file">
              <span aria-hidden="true">↥</span>
              <strong>{file ? file.name : "학습할 PDF를 선택하세요"}</strong>
              <small>텍스트 PDF · 최대 10MB · 최대 80쪽</small>
              <input
                ref={fileRef}
                id="pdf-file"
                type="file"
                accept=".pdf,application/pdf"
                disabled={busy}
                onChange={(event) => {
                  setFile(event.target.files?.[0]);
                  setError(undefined);
                  setSuccess(undefined);
                }}
              />
            </label>
            <p className="muted">
              스캔 이미지 PDF·암호화 PDF는 지원하지 않습니다. 페이지 수와 텍스트
              추출 가능 여부는 서버에서 검사합니다.
            </p>
            <button type="submit" disabled={!file || busy}>
              {busy ? "처리 중…" : "PDF 업로드"}
            </button>
          </form>
        </section>
        <section className="card">
          <span className="eyebrow">02 / MAKE IT YOURS</span>
          <h2>업로드 자료에서 문제 생성</h2>
          <ErrorBox error={documents.error} retry={documents.reload} />
          {documents.loading && <Loading />}
          <label>
            자료 선택
            <select
              value={documentId}
              disabled={busy || !documents.data?.length}
              onChange={(event) => setDocumentId(event.target.value)}
            >
              <option value="">PDF를 선택하세요</option>
              {documents.data?.map((doc) => (
                <option key={doc.id} value={doc.id}>
                  {doc.name} ({doc.pageCount}쪽)
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            AI가 구간별로 문제를 생성합니다. 각 문제에 실제 PDF 페이지 참조가
            남으며, 완료된 문제부터 보관함에 저장됩니다.
          </p>
          {!config.liveEnabled && (
            <div className="notice">
              서버에 AI 키가 설정되지 않아 PDF 기반 생성은 꺼져 있습니다. 아래
              데모는 키 없이 이용할 수 있어요.
            </div>
          )}
          <button
            disabled={busy || !documentId || !config.liveEnabled}
            onClick={() => generate("LIVE")}
          >
            PDF로 AI 문제 생성
          </button>
        </section>
      </div>
      <section className="demo-card">
        <div>
          <span className="eyebrow">JUST TRY IT</span>
          <h2>자료 없이 먼저 경험해 볼까요?</h2>
          <p>
            <strong>별도의 고정 데모 예제</strong>로 퀴즈와 복습을 체험해요.
            업로드 PDF에서 만든 문제가 아니며, AI 호출이나 API 키가 필요하지
            않습니다.
          </p>
        </div>
        <button
          disabled={busy}
          className="secondary"
          onClick={() => generate("DEMO")}
        >
          고정 데모 문제 만들기 →
        </button>
      </section>
      <section className="card">
        <div className="section-heading">
          <div>
            <h2>문제 생성 작업</h2>
            <p>일부 구간이 실패해도 이미 생성된 문제는 보관됩니다.</p>
          </div>
          <button
            className="text-button"
            onClick={() => setPollRevision((n) => n + 1)}
          >
            새로고침 ↻
          </button>
        </div>
        <ErrorBox
          error={pollError}
          retry={() => setPollRevision((n) => n + 1)}
        />
        {!jobs && !pollError && <Loading />}
        {jobs?.length === 0 && (
          <Empty title="아직 생성 작업이 없어요">
            <p>PDF로 생성하거나 고정 데모를 시작해 주세요.</p>
          </Empty>
        )}
        {!!jobs?.length && (
          <>
            <label>
              작업 선택
              <select
                value={selectedJob || jobs[0].id}
                onChange={(event) => setSelectedJob(event.target.value)}
              >
                {jobs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.mode === "DEMO"
                      ? "고정 데모"
                      : documents.data?.find(
                          (doc) => doc.id === item.documentId,
                        )?.name || "PDF 생성"}{" "}
                    · {statusLabel[item.status]} · {item.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
            {!job && !pollError && <Loading />}
          </>
        )}
        {job && (
          <div className="job-detail" aria-live="polite">
            <div className="section-heading">
              <strong>
                {job.mode === "DEMO"
                  ? "고정 데모 예제 (PDF 무관)"
                  : "PDF 기반 생성"}{" "}
                <span className="pill">{statusLabel[job.status]}</span>
              </strong>
              <span>{job.questionCount}문제 저장</span>
            </div>
            <progress
              aria-label="문제 생성 진행률"
              max={Math.max(job.totalChunks, 1)}
              value={Math.min(
                job.totalChunks,
                job.completedChunks + job.failedChunks,
              )}
            />
            <p className="muted">
              전체 {job.totalChunks}구간 · 완료 {job.completedChunks} · 실패{" "}
              {job.failedChunks}
              {!terminal(job) && " · 자동 업데이트 중"}
            </p>
            <ErrorBox error={job.error || undefined} />
            {job.status === "partial" && (
              <div className="notice">
                일부 구간에 실패했습니다. 저장된 {job.questionCount}개 문제는
                보관함에서 확인하고 바로 풀 수 있습니다.
              </div>
            )}
            {job.status === "failed" && (
              <p>
                위 오류를 확인해 주세요. 자료 선택이나 고정 데모 버튼으로 새로운
                작업을 시작할 수 있습니다.
              </p>
            )}
            {!!job.chunks?.length && (
              <details>
                <summary>구간별 처리 상세</summary>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>구간</th>
                        <th>상태</th>
                        <th>시도</th>
                        <th>처리 시간</th>
                        <th>토큰 (입력/출력)</th>
                        <th>오류</th>
                      </tr>
                    </thead>
                    <tbody>
                      {job.chunks.map((chunk) => (
                        <tr key={chunk.index}>
                          <td>{chunk.index + 1}</td>
                          <td>{chunk.status}</td>
                          <td>{chunk.attempts}</td>
                          <td>
                            {chunk.durationMs == null
                              ? "—"
                              : `${chunk.durationMs}ms`}
                          </td>
                          <td>
                            {chunk.inputTokens ?? "—"} /{" "}
                            {chunk.outputTokens ?? "—"}
                          </td>
                          <td>{chunk.error || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
            {job.questionCount > 0 && (
              <div className="actions">
                <button onClick={() => navigate("quiz")}>퀴즈 풀기 →</button>
                <button
                  className="secondary"
                  onClick={() => navigate("manage")}
                >
                  생성된 문제 확인
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </>
  );
}
