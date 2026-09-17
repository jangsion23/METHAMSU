# ReCall backend

Java 21, Spring Boot **3.5.16**, JDBC, Flyway, PDFBox **3.0.8**. This is a single-instance, anonymous **local-development MVP**, not a production authentication system. No live AI requests happen unless explicitly enabled and a key is configured.

## Run and test

From the repository root:

```sh
cd backend
./mvnw test
./mvnw spring-boot:run -Dspring-boot.run.profiles=dev
# Alternatively:
./mvnw package
java -jar target/recall.jar --spring.profiles.active=dev
```

Java 21 is required; Maven and Docker are not. `mvnw.cmd` is provided for Windows. The Apache Maven 3.9.11 wrapper is checksum-pinned and adapted to keep the Maven distribution, dependency cache, and download staging beneath `backend/.cache/`. Run commands inside `backend/`. The dev profile creates a persistent H2 PostgreSQL-mode database in `backend/data/`; tests use an isolated in-memory H2 database and a localhost mock Claude server. Tests never use a real API key or charge a provider.

The default profile uses **PostgreSQL**, with Flyway migrations applied on startup. There is **no automatic H2 fallback**: H2 is used only by the explicitly selected `dev` or `test` profile. Set `DB_URL` to a **JDBC URL**, not a `postgres://` URL. Supply an existing empty database and a role allowed to create tables. The same migration is used for PostgreSQL and H2. For the same integration/API/migration suite against a **dedicated disposable PostgreSQL test database**:

```sh
DB_URL=jdbc:postgresql://localhost:5432/recall_test \
DB_USERNAME=recall \
DB_PASSWORD=your-test-password \
./mvnw -Ppgtest verify
```

The `pgtest` Maven profile activates Spring test profiles `test,pgtest`: the latter overrides the datasource using the required `DB_URL`, `DB_USERNAME`, and `DB_PASSWORD` environment variables and explicitly requires the PostgreSQL driver. The equivalent CI command `./mvnw test -Dspring.profiles.active=pgtest` is also supported by the test profile resolver. Neither option can silently substitute H2. The provider stays mocked, so this suite never makes live AI requests. Those tests add records; never point them at a real learner database. PostgreSQL execution is unverified in the local environment because PostgreSQL/Docker are unavailable; use a PostgreSQL CI service for this profile.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SPRING_PROFILES_ACTIVE` | unset | `dev` for persistent H2; unset for PostgreSQL |
| `PORT` | `8080` | HTTP port |
| `DB_URL` | `jdbc:postgresql://localhost:5432/recall` | PostgreSQL JDBC URL |
| `DB_USERNAME` | `recall` | Database role |
| `DB_PASSWORD` | `recall` | Database password; replace outside local development |
| `LIVE_ENABLED` | `false` | Explicit opt-in to paid provider requests |
| `CLAUDE_API_KEY` | empty | Claude key; never returned or persisted |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Override with a model available to your account |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Base URL; `/v1/messages` appended |
| `PROVIDER_TIMEOUT_SECONDS` | `45` | Complete response deadline, clamped to 1–120 seconds |
| `PROVIDER_RETRY_DELAY_MS` | `500` | Retry base delay, clamped to 0–5000 ms; at most 3 total attempts |
| `COURSE_NAME` | `운영체제 (임시 개념 태그)` | Display name; all ten concept tags are provisional |
| `JAVA_HOME` | detected Java | Optional Java 21 installation |
| `MAVEN_USER_HOME` | `.cache/maven-user` | Optional wrapper distribution cache override |

`liveEnabled` is true only when both `LIVE_ENABLED=true` and a nonblank API key are present. `.env` files are **not automatically loaded**; export variables in your shell. Do not commit credentials. Use the Vite development proxy for `/api`; this backend intentionally does not enable CORS.

## HTTP contract

All JSON errors have `{ "code": "...", "message": "..." }`; common statuses: 400 invalid input, 401 invalid capability, 404 absent/not-owned resource, 409 version/idempotency conflict, 413 oversized PDF, 503 disabled live generation/full queue.

Call `POST /api/learners` first: **201 `{token}`**. Store this opaque bearer capability locally and send `X-Learner-Token: <token>` on every other `/api` request except public `GET /api/config`. Only a SHA-256 token hash is stored. Losing the token loses access; there is no recovery, user account, or identity verification. Anyone holding it has full access to that learner's data. Avoid internet exposure; production requires real authentication, abuse controls, retention policy, TLS, and resource isolation.

| Endpoint | Result / request |
|---|---|
| `GET /actuator/health` | Public `{status:"UP"}` |
| `GET /api/config` | `{liveEnabled,courseName,timezone:"Asia/Seoul"}` |
| `GET /api/tags` | `[{id,name}]` |
| `GET /api/dashboard` | `{dueCount,questionCount,attemptCount,accuracy,concepts:[{tagId,tagName,attemptCount,correctCount,accuracy,unresolvedWrongCount}]}` |
| `POST /api/documents` | Multipart field `file`; **201** `{id,name,pageCount,createdAt}` |
| `GET /api/documents` | Array of document metadata |
| `POST /api/jobs` | `{mode:"LIVE",documentId}` or `{mode:"DEMO"}`; **202** full job |
| `GET /api/jobs` | Array of full jobs, newest first |
| `GET /api/jobs/{id}` | Full job |
| `GET /api/questions?view=manage\|quiz\|due\|mistakes&tagId=...` | Array of questions; view defaults to `manage` |
| `GET /api/questions/{id}?view=quiz\|manage` | One question; default `manage` |
| `PUT /api/questions/{id}` | `{text,options,correctIndex,tagId,difficulty,explanation,version}` → updated question |
| `DELETE /api/questions/{id}` | **204**, soft-deleted and excluded from current questions/stats/review |
| `POST /api/attempts` | `{questionId,selectedIndex,idempotencyKey,version}` → **200** `{id,questionId,selectedIndex,correct,correctIndex,explanation,box,dueDate}` |

Question fields: `{id,text,options,tagId,difficulty,sourceStartPage,sourceEndPage,documentName,mode,version,box,dueDate,latestCorrect}`. `manage` and `mistakes` additionally include `correctIndex` and `explanation`; **quiz/due never include either**. Indices must be JSON integers 0–3, options exactly four unique nonblank strings, and difficulty `EASY|MEDIUM|HARD`. Text limit 4000 chars, each option 1000, explanation 6000. `idempotencyKey` must be a canonical lowercase UUID string. All IDs are UUIDs except concept tags:

`os-basics`, `process`, `thread`, `scheduling`, `synchronization`, `deadlock`, `memory`, `virtual-memory`, `filesystem`, `io`.

Job fields: `{id,documentId,mode,status,totalChunks,completedChunks,failedChunks,questionCount,error,createdAt,chunks}`. Status is `queued|running|succeeded|partial|failed`. Each chunk has `{index,status,error,attempts,durationMs,inputTokens,outputTokens,parseAttempts,parseSuccess}`. Chunk indices are zero-based; PDF page numbers are one-based. Durations include retry delays; tokens accumulate across successful and schema-invalid provider responses. HTTP failures without usage metadata report zero tokens. Parsing success is separate from atomic storage success. A queued job may already be running/completed by the time the creation response is returned.

## Semantics and limits

- PDF: actual parse validation, ≤10 MiB, 1–80 pages; reject encryption, malformed files, and documents with no extracted text (scans require OCR elsewhere). Blank pages in otherwise text PDFs are retained but cannot be cited. An additional **1,000,000 extracted-character limit** limits expansion. Only extracted pages/chunks are stored, **never original PDF bytes**. Multipart uploads at the supported file limit remain in memory.
- Chunks are ≤12,000 characters including page markers. Long pages are split while retaining their true page number. A generated source range must stay within the chunk and every cited page must have nonblank extracted text.
- Source-range validation verifies page membership, **not semantic citation correctness**; learners should compare generated claims with the document.
- DEMO rejects nonnull `documentId`. It always generates the same three clearly labelled `[샘플]` questions, with null document/provenance, without any provider request.
- LIVE prompts explicitly treat PDF text as untrusted data. Claude receives JSON Schema instructions. Responses undergo strict schema validation (including duplicate keys/trailing data, exact fields, integer indices, allowed tags/difficulties, option uniqueness, and page provenance).
- Two generation workers, queue capacity eight; at most two concurrent provider requests. Job/chunk metadata commits before enqueue. Overload returns **503** and leaves an inspectable failed job (`OVERLOADED`); the error message includes its ID.
- At most three total provider attempts for timeouts, network errors, HTTP 408/429/5xx, or invalid schemas. Other HTTP failures are terminal. Responses capped at 1 MiB with a complete-body timeout; redirects disabled. Logs/job errors never include keys, full PDF content, or provider response bodies.
- Chunk question writes and success counters are atomic/idempotent. Maximum three questions per chunk and thirty per job. Remaining chunks after reaching thirty are marked succeeded with zero attempts/questions (quota skip), so all chunks reach a terminal state.
- On **single-instance** startup, queued/running chunks become failed (`INTERRUPTED`), and jobs become failed/partial according to existing successes. Completed questions survive; no automatic paid resumption occurs. Do not run multiple application instances against the same database.
- Every answer, including an initial wrong answer, enters box 1, due tomorrow. Later correct answers advance to a maximum box 5; intervals for boxes 1–5 are 1/3/7/14/30 days. Wrong answers reset to box 1. Dates use an injectable `Clock` and `Asia/Seoul`. Due includes today and overdue; unseen box 0 is never due.
- Learner-row database locks serialize attempts/edits/deletions. Repeating the same idempotency key and payload returns the original result without another promotion; different payload returns 409. Separate keys represent separate answers. Stale question versions return 409.
- **Editing increments version and permanently removes that question's attempts/idempotency records and review progress** (box 0, no due date, no latest result). Old quiz versions cannot be answered. Deletion makes a question inaccessible, including replay of old submissions, and excludes its historical attempts from current dashboard counts.
- Mistakes means **latest** answer wrong, not “ever wrong.” Accuracy is 0–100, rounded to two decimals, and zero for no attempts. Deleted questions and reset histories do not contribute.

## Verification coverage

Integration tests use real Spring MVC/JDBC/Flyway with H2 PostgreSQL mode and mock HTTP only. They cover learner isolation, capability hashing, public health/config, demo separation, strict input/schema checks, malformed/encrypted/scanned/oversized PDFs, provenance, retries/partial failure, metrics, bounded upstream responses/timeouts, quota/idempotent chunk writes, restart recovery, queue overload, concurrent attempts, edit/delete reset behavior, overdue inclusion, and Seoul midnight. Unit tests cover every Leitner transition/cap and long-page chunk splitting. Provider timing/token assertions use synthetic mock responses; no measured live latency, accuracy, or cost is claimed.
