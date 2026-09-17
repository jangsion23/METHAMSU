# ReCall frontend

Korean, responsive React + TypeScript + Vite client. All records come from the server; there is no fake API fallback, authentication screen, or browser-side answer bank.

## Run

Requires Node 24 and npm 11.

```sh
cd frontend
npm ci
npm run dev
```

Vite proxies `/api` and `/actuator` to `http://localhost:8080`. Override with `API_PROXY_TARGET=http://backend:8080 npm run dev`. Production must route `/api` to the backend on the same origin (the Docker nginx configuration does this).

```sh
npm test
npm run typecheck
npm run build
```

## Behavior

- First visit creates a server learner under the cross-tab Web Lock `recall-learner-init`; storage is rechecked inside the lock so simultaneous tabs share one learner. New identity creation fails explicitly if Web Locks are unavailable (use a modern browser on HTTPS/localhost). The opaque token is saved as `recall.learnerToken` in localStorage and sent as `X-Learner-Token`. Requests stay bound to the loaded identity. A storage change from another tab clears old learner views/session summaries and reloads the new identity. A 401 blocks the app and offers retry or a **confirmed** new learner; the old token is never silently removed. Clearing browser storage loses access to the learner's history.
- PDF upload supports text PDFs up to 10MB / 80 pages (the server enforces parsing/page rules). Upload and AI generation are separate explicit actions. `/api/config.liveEnabled` gates live generation.
- **Fixed DEMO examples are separate from uploaded PDFs** and use the real server DEMO endpoint, not client fallback data. They allow a key-free quiz/review flow.
- Generation jobs are polled while active; failed polling has explicit retry. Partial generation preserves successful questions. Chunk status, attempts, duration, and token counts are visible.
- Quiz/due requests never ask for management answers. Feedback appears only after an attempt response. Uncertain network/server failures retain the same selection and idempotency key for retry; controls prevent double submission. A 409 asks the learner to reload rather than resubmitting stale content. A definitive 404 offers skip/reload (or results at the end) instead of retrying a deleted question; completed session answers remain intact.
- Edit warns and confirms that prior attempts/review state are reset. Delete confirms exclusion from active questions and stats. Dashboard and server result views reload after mutations.
- Reviews show only server-due questions. Asia/Seoul dates, box 1 on first answer, maximum box 5, and 1/3/7/14/30-day intervals are explained; scheduling remains server-authoritative.
- Session results are ephemeral UI summaries; historical accuracy and unresolved latest-wrong questions are server records. Operating-system tags are explicitly marked provisional, not verified against a syllabus.

The UI uses native accessible form controls, live feedback, loading/error/empty states, hash navigation, and responsive mobile layouts. No OCR, chat, or social features.

## Real-browser smoke test

Start the backend on port 8080 and frontend on port 5173 first (Vite or Compose). No server is automatically launched by Playwright. Then:

```sh
cd frontend
npm run test:e2e:install
npm run test:e2e
```

Chromium is installed in the ignored project-local `.playwright-browsers/` directory; download/runtime scratch files stay in `.playwright-downloads/`. The scripts use a POSIX shell (macOS/Linux). Override the frontend origin with `E2E_BASE_URL`. The test creates an isolated browser learner, generates **real server DEMO** questions, submits the first answer without reading the answer key, checks feedback/results/first-answer review scheduling, and confirms management edit/reset/delete. No AI calls or mocked API responses are used. Both a correct and an incorrect first answer must enter box 1 and be due tomorrow—not immediately due.

Unit tests remain separately scoped to `src/`; browser traces/screenshots for failures are under ignored `test-results/`.

## Container

Build using `docker build -t recall-frontend frontend`. nginx listens on port 80 and proxies `/api` and `/actuator` to a Docker-network service named `backend:8080`. Expose this container, not the Vite preview server, for deployment.
