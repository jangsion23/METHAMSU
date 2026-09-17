export type Tag = { id: string; name: string };
export type Config = {
  liveEnabled: boolean;
  courseName: string;
  timezone: string;
};
export type Concept = {
  tagId: string;
  tagName: string;
  attemptCount: number;
  correctCount: number;
  accuracy: number;
  unresolvedWrongCount: number;
};
export type DashboardData = {
  dueCount: number;
  questionCount: number;
  attemptCount: number;
  accuracy: number;
  concepts: Concept[];
};
export type DocumentInfo = {
  id: string;
  name: string;
  pageCount: number;
  createdAt: string;
};
export type Job = {
  id: string;
  documentId: string | null;
  mode: "LIVE" | "DEMO";
  status: "queued" | "running" | "succeeded" | "partial" | "failed";
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  questionCount: number;
  error: string | null;
  createdAt: string;
  chunks?: {
    index: number;
    status: string;
    error: string | null;
    attempts: number;
    durationMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
  }[];
};
export type Question = {
  id: string;
  text: string;
  options: string[];
  tagId: string;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  sourceStartPage: number | null;
  sourceEndPage: number | null;
  documentName: string | null;
  mode: "LIVE" | "DEMO";
  version: number;
  box: number;
  dueDate: string | null;
  latestCorrect: boolean | null;
  correctIndex?: number;
  explanation?: string;
};
export type Attempt = {
  id: string;
  questionId: string;
  selectedIndex: number;
  correct: boolean;
  correctIndex: number;
  explanation: string;
  box: number;
  dueDate: string;
};
export type SessionAnswer = { question: Question; attempt: Attempt };
