package dev.recall;

import static dev.recall.Models.*;
import static dev.recall.Questions.fields;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.time.Clock;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class Jobs {
  final JdbcTemplate db;
  final TransactionTemplate tx;
  final Documents documents;
  final Questions questions;
  final Provider provider;
  final Clock clock;
  final long retryDelay;
  final ThreadPoolExecutor executor;

  Jobs(
      JdbcTemplate db,
      TransactionTemplate tx,
      Documents documents,
      Questions questions,
      Provider provider,
      Clock clock,
      @Value("${recall.retry-delay-ms}") long retryDelay) {
    this.db = db;
    this.tx = tx;
    this.documents = documents;
    this.questions = questions;
    this.provider = provider;
    this.clock = clock;
    this.retryDelay = Math.max(0, Math.min(5000, retryDelay));
    AtomicInteger ids = new AtomicInteger();
    executor =
        new ThreadPoolExecutor(
            2,
            2,
            0,
            TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(8),
            r -> {
              Thread t = new Thread(r, "generation-" + ids.incrementAndGet());
              t.setDaemon(false);
              return t;
            },
            new ThreadPoolExecutor.AbortPolicy());
  }

  @PostConstruct
  public void recover() {
    tx.executeWithoutResult(
        status -> {
          db.update(
              "UPDATE job_chunks SET status='failed',error='INTERRUPTED' WHERE status IN ('queued','running') AND job_id IN (SELECT id FROM jobs WHERE status IN ('queued','running'))");
          db.update(
              "UPDATE jobs SET status=CASE WHEN question_count>0 THEN 'partial' ELSE 'failed' END,error='INTERRUPTED',failed_chunks=total_chunks-completed_chunks WHERE status IN ('queued','running')");
        });
  }

  Map<String, Object> create(String learner, JobRequest request) {
    if (request.mode() == Mode.DEMO && request.documentId() != null)
      throw ApiException.bad("DEMO는 문서를 사용하지 않습니다. documentId를 보내지 마세요.");
    if (request.mode() == Mode.LIVE
        && (request.documentId() == null || request.documentId().isBlank()))
      throw ApiException.bad("LIVE 생성에는 documentId가 필요합니다.");
    List<Chunk> chunks =
        request.mode() == Mode.LIVE
            ? documents.chunks(learner, request.documentId())
            : List.of(new Chunk(0, 0, 0, "", Set.of()));
    if (request.mode() == Mode.LIVE && !provider.liveEnabled())
      throw new ApiException(503, "LIVE_DISABLED", "실시간 생성이 비활성화되어 있습니다.");
    String id = UUID.randomUUID().toString();
    tx.executeWithoutResult(
        status -> {
          db.update(
              "INSERT INTO jobs(id,learner_id,document_id,mode,status,total_chunks,created_at) VALUES (?,?,?,?,'queued',?,?)",
              id,
              learner,
              request.documentId(),
              request.mode().name(),
              chunks.size(),
              Instant.now(clock).toString());
          for (var chunk : chunks)
            db.update(
                "INSERT INTO job_chunks(job_id,chunk_index,status) VALUES (?,?,'queued')",
                id,
                chunk.index());
        });
    try {
      executor.execute(() -> run(id, learner, request, chunks));
    } catch (RejectedExecutionException e) {
      failPending(id, "OVERLOADED");
      throw new ApiException(503, "OVERLOADED", "생성 대기열이 가득 찼습니다. 잠시 후 다시 시도하세요. 작업 ID: " + id);
    }
    return get(learner, id);
  }

  void run(String id, String learner, JobRequest request, List<Chunk> chunks) {
    if (db.update("UPDATE jobs SET status='running' WHERE id=? AND status='queued'", id) != 1)
      return;
    try {
      int count = 0;
      for (var chunk : chunks) {
        if (Thread.currentThread().isInterrupted()) {
          failPending(id, "INTERRUPTED");
          return;
        }
        if (count >= 30) {
          success(id, learner, request, chunk, List.of());
          continue;
        }
        long started = System.nanoTime();
        db.update(
            "UPDATE job_chunks SET status='running' WHERE job_id=? AND chunk_index=?",
            id,
            chunk.index());
        boolean succeeded = false;
        for (int attempt = 1; attempt <= 3; attempt++) {
          db.update(
              "UPDATE job_chunks SET attempts=? WHERE job_id=? AND chunk_index=?",
              attempt,
              id,
              chunk.index());
          try {
            Provider.Result result =
                request.mode() == Mode.DEMO
                    ? new Provider.Result(samples(), 0, 0)
                    : provider.generate(chunk, Math.min(3, 30 - count));
            metrics(
                id,
                chunk,
                started,
                result.inputTokens(),
                result.outputTokens(),
                request.mode() == Mode.LIVE,
                true);
            success(id, learner, request, chunk, result.questions());
            count += result.questions().size();
            succeeded = true;
            break;
          } catch (Provider.Failure e) {
            metrics(
                id,
                chunk,
                started,
                e.inputTokens,
                e.outputTokens,
                e.getMessage().equals("PROVIDER_SCHEMA_INVALID"),
                false);
            db.update(
                "UPDATE job_chunks SET error=? WHERE job_id=? AND chunk_index=?",
                e.getMessage(),
                id,
                chunk.index());
            if (!e.retryable || attempt == 3 || Thread.currentThread().isInterrupted()) break;
            try {
              Thread.sleep(retryDelay * attempt);
            } catch (InterruptedException interrupted) {
              Thread.currentThread().interrupt();
              break;
            }
          }
        }
        if (!succeeded)
          tx.executeWithoutResult(
              status -> {
                db.update(
                    "UPDATE job_chunks SET status='failed' WHERE job_id=? AND chunk_index=?",
                    id,
                    chunk.index());
                db.update("UPDATE jobs SET failed_chunks=failed_chunks+1 WHERE id=?", id);
              });
      }
      db.update(
          "UPDATE jobs SET status=CASE WHEN failed_chunks=0 THEN 'succeeded' WHEN question_count>0 THEN 'partial' ELSE 'failed' END,error=CASE WHEN failed_chunks>0 THEN '일부 청크 생성에 실패했습니다.' ELSE NULL END WHERE id=?",
          id);
    } catch (Exception e) {
      failPending(id, "GENERATION_FAILED");
    }
  }

  private void metrics(
      String job,
      Chunk chunk,
      long start,
      long input,
      long output,
      boolean parsed,
      boolean success) {
    db.update(
        "UPDATE job_chunks SET duration_ms=?,input_tokens=input_tokens+?,output_tokens=output_tokens+?,parse_attempts=parse_attempts+?,parse_success=? WHERE job_id=? AND chunk_index=?",
        TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start),
        input,
        output,
        parsed ? 1 : 0,
        parsed && success,
        job,
        chunk.index());
  }

  void success(
      String job, String learner, JobRequest request, Chunk chunk, List<Generated> generated) {
    if (generated.size() > 3) throw new IllegalStateException("Chunk quota");
    tx.executeWithoutResult(
        status -> {
          int count =
              db.queryForObject(
                  "SELECT question_count FROM jobs WHERE id=? FOR UPDATE", Integer.class, job);
          String state =
              db.queryForObject(
                  "SELECT status FROM job_chunks WHERE job_id=? AND chunk_index=?",
                  String.class,
                  job,
                  chunk.index());
          if (state.equals("succeeded")) return;
          if (count + generated.size() > 30) throw new IllegalStateException("Job quota");
          for (var q : generated)
            questions.insert(learner, job, request.documentId(), chunk.index(), request.mode(), q);
          db.update(
              "UPDATE job_chunks SET status='succeeded',error=NULL WHERE job_id=? AND chunk_index=?",
              job,
              chunk.index());
          db.update(
              "UPDATE jobs SET completed_chunks=completed_chunks+1,question_count=question_count+? WHERE id=?",
              generated.size(),
              job);
        });
  }

  void failPending(String id, String error) {
    tx.executeWithoutResult(
        status -> {
          db.queryForObject("SELECT id FROM jobs WHERE id=? FOR UPDATE", String.class, id);
          db.update(
              "UPDATE job_chunks SET status='failed',error=? WHERE job_id=? AND status IN ('queued','running')",
              error,
              id);
          db.update(
              "UPDATE jobs SET status=CASE WHEN question_count>0 THEN 'partial' ELSE 'failed' END,error=?,failed_chunks=total_chunks-completed_chunks WHERE id=?",
              error,
              id);
        });
  }

  List<Map<String, Object>> list(String learner) {
    return db
        .queryForList(
            "SELECT id FROM jobs WHERE learner_id=? ORDER BY created_at DESC",
            String.class,
            learner)
        .stream()
        .map(id -> get(learner, id))
        .toList();
  }

  Map<String, Object> get(String learner, String id) {
    var rows =
        db.query(
            "SELECT * FROM jobs WHERE learner_id=? AND id=?",
            (r, n) ->
                fields(
                    "id",
                    r.getString("id"),
                    "documentId",
                    r.getString("document_id"),
                    "mode",
                    r.getString("mode"),
                    "status",
                    r.getString("status"),
                    "totalChunks",
                    r.getInt("total_chunks"),
                    "completedChunks",
                    r.getInt("completed_chunks"),
                    "failedChunks",
                    r.getInt("failed_chunks"),
                    "questionCount",
                    r.getInt("question_count"),
                    "error",
                    r.getString("error"),
                    "createdAt",
                    r.getString("created_at")),
            learner,
            id);
    if (rows.isEmpty()) throw ApiException.missing();
    var result = rows.getFirst();
    result.put(
        "chunks",
        db.query(
            "SELECT * FROM job_chunks WHERE job_id=? ORDER BY chunk_index",
            (r, n) ->
                fields(
                    "index",
                    r.getInt("chunk_index"),
                    "status",
                    r.getString("status"),
                    "error",
                    r.getString("error"),
                    "attempts",
                    r.getInt("attempts"),
                    "durationMs",
                    r.getLong("duration_ms"),
                    "inputTokens",
                    r.getLong("input_tokens"),
                    "outputTokens",
                    r.getLong("output_tokens"),
                    "parseAttempts",
                    r.getInt("parse_attempts"),
                    "parseSuccess",
                    r.getBoolean("parse_success")),
            id));
    return result;
  }

  static List<Generated> samples() {
    return List.of(
        new Generated(
            "[샘플] 프로세스와 스레드에 대한 설명으로 옳은 것은?",
            List.of(
                "프로세스는 독립된 주소 공간을 가진다.",
                "모든 프로세스는 주소 공간을 공유한다.",
                "스레드는 항상 별도 프로세스이다.",
                "프로세스에는 스레드가 없다."),
            0,
            "process",
            Difficulty.EASY,
            "샘플 해설: 프로세스는 독립된 주소 공간을 가지며, 같은 프로세스의 스레드는 주소 공간을 공유합니다.",
            null,
            null),
        new Generated(
            "[샘플] 교착 상태의 필요 조건이 아닌 것은?",
            List.of("상호 배제", "점유 대기", "순환 대기", "선점 가능"),
            3,
            "deadlock",
            Difficulty.MEDIUM,
            "샘플 해설: 교착 상태의 필요 조건은 상호 배제, 점유 대기, 비선점, 순환 대기입니다.",
            null,
            null),
        new Generated(
            "[샘플] 가상 메모리에 대한 설명으로 옳은 것은?",
            List.of(
                "물리 메모리만 주소로 사용한다.",
                "보조 기억 장치를 활용해 주소 공간을 확장한다.",
                "페이지 교체가 절대로 없다.",
                "모든 페이지는 항상 메모리에 있다."),
            1,
            "virtual-memory",
            Difficulty.EASY,
            "샘플 해설: 가상 메모리는 보조 기억 장치를 활용하고 필요한 페이지를 메모리에 적재합니다.",
            null,
            null));
  }

  @PreDestroy
  void close() {
    executor.shutdown();
    try {
      if (!executor.awaitTermination(5, TimeUnit.SECONDS)) executor.shutdownNow();
    } catch (InterruptedException e) {
      executor.shutdownNow();
      Thread.currentThread().interrupt();
    }
  }
}
