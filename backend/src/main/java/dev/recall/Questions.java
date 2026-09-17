package dev.recall;

import static dev.recall.Models.*;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class Questions {
  final JdbcTemplate db;
  final Json json;
  final Clock clock;
  final TransactionTemplate tx;

  Questions(JdbcTemplate db, Json json, Clock clock, TransactionTemplate tx) {
    this.db = db;
    this.json = json;
    this.clock = clock;
    this.tx = tx;
  }

  LocalDate today() {
    return LocalDate.now(clock.withZone(ZoneId.of("Asia/Seoul")));
  }

  void lock(String learner) {
    db.queryForObject("SELECT id FROM learners WHERE id=? FOR UPDATE", String.class, learner);
  }

  void validateOptions(List<String> options) {
    if (options == null
        || options.size() != 4
        || options.stream().anyMatch(s -> s == null || s.isBlank() || s.length() > 1000)
        || options.stream().map(String::strip).distinct().count() != 4)
      throw ApiException.bad("서로 다른 보기 4개가 필요합니다.");
  }

  void validateTag(String tag) {
    if (db.queryForObject("SELECT COUNT(*) FROM tags WHERE id=?", Integer.class, tag) != 1)
      throw ApiException.bad("알 수 없는 개념 태그입니다.");
  }

  List<Map<String, Object>> tags() {
    return db.query(
        "SELECT id,name FROM tags ORDER BY id",
        (r, n) -> fields("id", r.getString(1), "name", r.getString(2)));
  }

  static Map<String, Object> fields(Object... values) {
    Map<String, Object> map = new LinkedHashMap<>();
    for (int i = 0; i < values.length; i += 2) map.put((String) values[i], values[i + 1]);
    return map;
  }

  private void validateView(String view, boolean single) {
    if (!(single ? Set.of("quiz", "manage") : Set.of("quiz", "manage", "due", "mistakes"))
        .contains(view)) throw ApiException.bad("알 수 없는 문제 보기입니다.");
  }

  private Map<String, Object> map(ResultSet r, String view) throws SQLException {
    var m =
        fields(
            "id",
            r.getString("id"),
            "text",
            r.getString("text"),
            "options",
            json.read(r.getString("options")),
            "tagId",
            r.getString("tag_id"),
            "difficulty",
            r.getString("difficulty"),
            "sourceStartPage",
            r.getObject("source_start_page"),
            "sourceEndPage",
            r.getObject("source_end_page"),
            "documentName",
            r.getString("document_name"),
            "mode",
            r.getString("mode"),
            "version",
            r.getInt("version"),
            "box",
            r.getInt("box"),
            "dueDate",
            r.getString("due_date"),
            "latestCorrect",
            r.getObject("latest_correct"));
    if (view.equals("manage") || view.equals("mistakes")) {
      m.put("correctIndex", r.getInt("correct_index"));
      m.put("explanation", r.getString("explanation"));
    }
    return m;
  }

  private static final String SELECT =
      "SELECT q.*,d.name AS document_name FROM questions q LEFT JOIN documents d ON d.id=q.document_id WHERE q.learner_id=? AND q.deleted=FALSE";

  List<Map<String, Object>> list(String learner, String view, String tag) {
    validateView(view, false);
    String sql = SELECT;
    List<Object> args = new ArrayList<>();
    args.add(learner);
    if (tag != null) {
      validateTag(tag);
      sql += " AND q.tag_id=?";
      args.add(tag);
    }
    if (view.equals("due")) {
      sql += " AND q.box>0 AND q.due_date<=?";
      args.add(today().toString());
    }
    if (view.equals("mistakes")) sql += " AND q.latest_correct=FALSE";
    return db.query(sql + " ORDER BY q.id", (r, n) -> map(r, view), args.toArray());
  }

  Map<String, Object> get(String learner, String id, String view) {
    validateView(view, true);
    var rows = db.query(SELECT + " AND q.id=?", (r, n) -> map(r, view), learner, id);
    if (rows.isEmpty()) throw ApiException.missing();
    return rows.getFirst();
  }

  Map<String, Object> edit(String learner, String id, EditRequest request) {
    validateOptions(request.options());
    validateTag(request.tagId());
    return tx.execute(
        status -> {
          lock(learner);
          var q = get(learner, id, "manage");
          if (!q.get("version").equals(request.version()))
            throw ApiException.conflict("문제가 변경되었습니다. 새로고침해 주세요.");
          db.update("DELETE FROM attempts WHERE question_id=?", id);
          db.update(
              "UPDATE questions SET text=?,options=?,correct_index=?,tag_id=?,difficulty=?,explanation=?,version=version+1,box=0,due_date=NULL,latest_correct=NULL WHERE id=?",
              request.text().strip(),
              json.write(request.options().stream().map(String::strip).toList()),
              request.correctIndex(),
              request.tagId(),
              request.difficulty().name(),
              request.explanation().strip(),
              id);
          return get(learner, id, "manage");
        });
  }

  void delete(String learner, String id) {
    tx.executeWithoutResult(
        status -> {
          lock(learner);
          get(learner, id, "manage");
          db.update("UPDATE questions SET deleted=TRUE WHERE id=?", id);
        });
  }

  Object attempt(String learner, AttemptRequest request) {
    try {
      if (!UUID.fromString(request.idempotencyKey()).toString().equals(request.idempotencyKey()))
        throw new IllegalArgumentException();
    } catch (IllegalArgumentException e) {
      throw ApiException.bad("idempotencyKey는 표준 UUID여야 합니다.");
    }
    return tx.execute(
        status -> {
          lock(learner);
          var q = get(learner, request.questionId(), "manage");
          var old =
              db.queryForList(
                  "SELECT * FROM attempts WHERE learner_id=? AND idempotency_key=?",
                  learner,
                  request.idempotencyKey());
          if (!old.isEmpty()) {
            var row = old.getFirst();
            if (!row.get("question_id").equals(request.questionId())
                || !row.get("selected_index").equals(request.selectedIndex())
                || !row.get("question_version").equals(request.version()))
              throw ApiException.conflict("같은 키로 다른 답안을 제출할 수 없습니다.");
            return json.read((String) row.get("result"));
          }
          if (!q.get("version").equals(request.version()))
            throw ApiException.conflict("이전 버전의 문제에는 답할 수 없습니다.");
          boolean correct = q.get("correctIndex").equals(request.selectedIndex());
          var review = Leitner.answer((int) q.get("box"), correct, today());
          String id = UUID.randomUUID().toString();
          var result =
              fields(
                  "id",
                  id,
                  "questionId",
                  request.questionId(),
                  "selectedIndex",
                  request.selectedIndex(),
                  "correct",
                  correct,
                  "correctIndex",
                  q.get("correctIndex"),
                  "explanation",
                  q.get("explanation"),
                  "box",
                  review.box(),
                  "dueDate",
                  review.dueDate().toString());
          db.update(
              "INSERT INTO attempts(id,learner_id,question_id,idempotency_key,selected_index,question_version,correct,result,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
              id,
              learner,
              request.questionId(),
              request.idempotencyKey(),
              request.selectedIndex(),
              request.version(),
              correct,
              json.write(result),
              Instant.now(clock).toString());
          db.update(
              "UPDATE questions SET box=?,due_date=?,latest_correct=? WHERE id=?",
              review.box(),
              review.dueDate().toString(),
              correct,
              request.questionId());
          return result;
        });
  }

  Map<String, Object> dashboard(String learner) {
    return tx.execute(
        status -> {
          lock(learner);
          long count =
              db.queryForObject(
                  "SELECT COUNT(*) FROM questions WHERE learner_id=? AND deleted=FALSE",
                  Long.class,
                  learner);
          long due =
              db.queryForObject(
                  "SELECT COUNT(*) FROM questions WHERE learner_id=? AND deleted=FALSE AND box>0 AND due_date<=?",
                  Long.class,
                  learner,
                  today().toString());
          var concepts = new ArrayList<Map<String, Object>>();
          long total = 0, correct = 0;
          for (var tag : tags()) {
            long n =
                db.queryForObject(
                    "SELECT COUNT(*) FROM attempts a JOIN questions q ON q.id=a.question_id WHERE q.learner_id=? AND q.deleted=FALSE AND q.tag_id=?",
                    Long.class,
                    learner,
                    tag.get("id"));
            long c =
                db.queryForObject(
                    "SELECT COUNT(*) FROM attempts a JOIN questions q ON q.id=a.question_id WHERE q.learner_id=? AND q.deleted=FALSE AND q.tag_id=? AND a.correct=TRUE",
                    Long.class,
                    learner,
                    tag.get("id"));
            long wrong =
                db.queryForObject(
                    "SELECT COUNT(*) FROM questions WHERE learner_id=? AND deleted=FALSE AND tag_id=? AND latest_correct=FALSE",
                    Long.class,
                    learner,
                    tag.get("id"));
            total += n;
            correct += c;
            concepts.add(
                fields(
                    "tagId",
                    tag.get("id"),
                    "tagName",
                    tag.get("name"),
                    "attemptCount",
                    n,
                    "correctCount",
                    c,
                    "accuracy",
                    accuracy(n, c),
                    "unresolvedWrongCount",
                    wrong));
          }
          return fields(
              "dueCount",
              due,
              "questionCount",
              count,
              "attemptCount",
              total,
              "accuracy",
              accuracy(total, correct),
              "concepts",
              concepts);
        });
  }

  private double accuracy(long total, long correct) {
    return total == 0 ? 0 : Math.round(10000.0 * correct / total) / 100.0;
  }

  void insert(String learner, String job, String document, int chunk, Mode mode, Generated q) {
    db.update(
        "INSERT INTO questions(id,learner_id,job_id,chunk_index,document_id,text,options,correct_index,tag_id,difficulty,explanation,source_start_page,source_end_page,mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        UUID.randomUUID().toString(),
        learner,
        job,
        chunk,
        document,
        q.text(),
        json.write(q.options()),
        q.correctIndex(),
        q.tagId(),
        q.difficulty().name(),
        q.explanation(),
        q.sourceStartPage(),
        q.sourceEndPage(),
        mode.name());
  }
}
