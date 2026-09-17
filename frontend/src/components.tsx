import type { Question, Tag } from "./types";

export function ErrorBox({
  error,
  retry,
}: {
  error?: string;
  retry?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="notice error" role="alert">
      <span>{error}</span>
      {retry && (
        <button className="button small secondary" onClick={retry}>
          다시 시도
        </button>
      )}
    </div>
  );
}
export function Loading() {
  return (
    <p role="status" className="loading">
      학습 데이터를 불러오는 중…
    </p>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-symbol" aria-hidden="true">
        ◇
      </span>
      <h3>{title}</h3>
      {children}
    </div>
  );
}
export function Source({ question }: { question: Question }) {
  if (question.mode === "DEMO")
    return <span className="source">고정 데모 예제 · 업로드 PDF와 무관</span>;
  return (
    <span className="source">
      {question.documentName || "문서"} ·{" "}
      {question.sourceStartPage != null
        ? `실제 PDF ${question.sourceStartPage}${question.sourceEndPage != null && question.sourceEndPage !== question.sourceStartPage ? `–${question.sourceEndPage}` : ""}쪽`
        : "페이지 참조 없음"}
    </span>
  );
}
export function TagFilter({
  tags,
  value,
  onChange,
}: {
  tags: Tag[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="filter">
      개념별 보기
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">모든 개념</option>
        {tags.map((tag) => (
          <option value={tag.id} key={tag.id}>
            {tag.name}
          </option>
        ))}
      </select>
    </label>
  );
}
export const difficultyLabel = { EASY: "기초", MEDIUM: "보통", HARD: "심화" };
export function QuestionMeta({
  question,
  tags,
}: {
  question: Question;
  tags: Tag[];
}) {
  return (
    <div className="question-meta">
      <span className="pill">
        {tags.find((tag) => String(tag.id) === String(question.tagId))?.name ||
          "미분류"}
      </span>
      <span className="pill neutral">
        {difficultyLabel[question.difficulty]}
      </span>
      <Source question={question} />
    </div>
  );
}
export function formatDate(value: string | null) {
  if (!value) return "아직 풀이하지 않음";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.replaceAll("-", ".");
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        month: "long",
        day: "numeric",
      }).format(date);
}
