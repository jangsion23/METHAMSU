package dev.recall;

import static dev.recall.Models.*;
import static dev.recall.Questions.fields;
import static org.assertj.core.api.Assertions.*;
import static org.awaitility.Awaitility.await;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.Function;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.encryption.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.*;
import org.springframework.context.annotation.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.*;
import org.springframework.test.web.servlet.*;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles(resolver = BackendIntegrationTest.Profiles.class)
class BackendIntegrationTest {
  public static class Profiles implements ActiveProfilesResolver {
    @Override
    public String[] resolve(Class<?> testClass) {
      if ("pgtest".equals(System.getProperty("spring.profiles.active")))
        return new String[] {"test", "pgtest"};
      return System.getProperty("recall.test.profile", "test").split(",");
    }
  }

  static final HttpServer server;
  static final ExecutorService httpThreads = Executors.newCachedThreadPool();
  static final AtomicReference<Function<String, Reply>> handler = new AtomicReference<>();
  static final AtomicInteger calls = new AtomicInteger();
  static final List<String> requests = new CopyOnWriteArrayList<>();

  record Reply(int status, String body, long delay) {}

  static {
    try {
      server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
      server.setExecutor(httpThreads);
      server.createContext(
          "/v1/messages",
          exchange -> {
            calls.incrementAndGet();
            String request =
                new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            requests.add(request);
            Reply reply = handler.get().apply(request);
            try {
              if (reply.delay() > 0) Thread.sleep(reply.delay());
              byte[] body = reply.body().getBytes(StandardCharsets.UTF_8);
              exchange.sendResponseHeaders(reply.status(), body.length);
              exchange.getResponseBody().write(body);
            } catch (Exception ignored) {
            } finally {
              exchange.close();
            }
          });
      server.start();
    } catch (Exception e) {
      throw new ExceptionInInitializerError(e);
    }
  }

  @DynamicPropertySource
  static void properties(DynamicPropertyRegistry registry) {
    registry.add("recall.provider-url", () -> "http://127.0.0.1:" + server.getAddress().getPort());
  }

  @TestConfiguration
  static class TimeConfig {
    @Bean
    @Primary
    MutableClock testClock() {
      return new MutableClock();
    }
  }

  static class MutableClock extends Clock {
    final AtomicReference<Instant> time =
        new AtomicReference<>(Instant.parse("2026-09-17T14:59:59Z"));

    @Override
    public ZoneId getZone() {
      return ZoneId.of("Asia/Seoul");
    }

    @Override
    public Clock withZone(ZoneId zone) {
      return Clock.fixed(time.get(), zone);
    }

    @Override
    public Instant instant() {
      return time.get();
    }
  }

  @Autowired MockMvc mvc;
  @Autowired Json json;
  @Autowired JdbcTemplate db;
  @Autowired Learners learners;
  @Autowired Questions questions;
  @Autowired Documents documents;
  @Autowired Jobs jobs;
  @Autowired Provider provider;
  @Autowired MutableClock clock;
  String token, owner, other;

  @BeforeEach
  void setup() throws Exception {
    await()
        .atMost(Duration.ofSeconds(10))
        .until(() -> jobs.executor.getActiveCount() == 0 && jobs.executor.getQueue().isEmpty());
    clock.time.set(Instant.parse("2026-09-17T14:59:59Z"));
    calls.set(0);
    requests.clear();
    handler.set(request -> new Reply(200, envelope(generated(1, 1), 10, 20), 0));
    token = call(post("/api/learners"), 201, null).get("token").asText();
    owner =
        db.queryForObject(
            "SELECT id FROM learners WHERE token_hash=?", String.class, Learners.hash(token));
    other = learners.create();
  }

  @AfterAll
  static void stopServer() {
    server.stop(0);
    httpThreads.shutdownNow();
  }

  JsonNode call(MockHttpServletRequestBuilder request, int status, String capability)
      throws Exception {
    if (capability != null) request.header("X-Learner-Token", capability);
    var response = mvc.perform(request).andReturn().getResponse();
    assertThat(response.getStatus())
        .withFailMessage("%s: %s", response.getStatus(), response.getContentAsString())
        .isEqualTo(status);
    return response.getContentAsString().isEmpty()
        ? json.mapper.nullNode()
        : json.read(response.getContentAsString());
  }

  MockHttpServletRequestBuilder body(MockHttpServletRequestBuilder request, Object body) {
    return request.contentType("application/json").content(json.write(body));
  }

  JsonNode demo() throws Exception {
    var job = call(body(post("/api/jobs"), Map.of("mode", "DEMO")), 202, token);
    return waitJob(job.get("id").asText());
  }

  JsonNode waitJob(String id) {
    await()
        .atMost(Duration.ofSeconds(12))
        .until(() -> !Set.of("queued", "running").contains(jobs.get(owner, id).get("status")));
    return json.mapper.valueToTree(jobs.get(owner, id));
  }

  JsonNode first() throws Exception {
    demo();
    return call(get("/api/questions"), 200, token).get(0);
  }

  JsonNode answer(JsonNode q, int selected, String key, int version) throws Exception {
    return call(
        body(
            post("/api/attempts"),
            fields(
                "questionId",
                q.get("id").asText(),
                "selectedIndex",
                selected,
                "idempotencyKey",
                key,
                "version",
                version)),
        200,
        token);
  }

  JsonNode upload(byte[] bytes, int status) throws Exception {
    return call(
        multipart("/api/documents")
            .file(new MockMultipartFile("file", "lecture.pdf", "application/pdf", bytes)),
        status,
        token);
  }

  byte[] pdf(int count, boolean text, boolean encrypted) throws Exception {
    try (PDDocument pdf = new PDDocument();
        ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      for (int i = 0; i < count; i++) {
        PDPage page = new PDPage();
        pdf.addPage(page);
        if (text)
          try (PDPageContentStream stream = new PDPageContentStream(pdf, page)) {
            stream.beginText();
            stream.setFont(new PDType1Font(Standard14Fonts.FontName.HELVETICA), 12);
            stream.newLineAtOffset(30, 700);
            stream.showText("Operating systems process memory scheduling page " + (i + 1));
            stream.endText();
          }
      }
      if (encrypted)
        pdf.protect(new StandardProtectionPolicy("owner", "password", new AccessPermission()));
      pdf.save(out);
      return out.toByteArray();
    }
  }

  String generated(int start, int end) {
    return json.write(
        Map.of(
            "questions",
            List.of(
                fields(
                    "text",
                    "프로세스란?",
                    "options",
                    List.of("실행 중 프로그램", "파일", "디스크", "메모리"),
                    "correctIndex",
                    0,
                    "tagId",
                    "process",
                    "difficulty",
                    "EASY",
                    "explanation",
                    "프로세스는 실행 중인 프로그램입니다.",
                    "sourceStartPage",
                    start,
                    "sourceEndPage",
                    end))));
  }

  String envelope(String content, int input, int output) {
    return json.write(
        Map.of(
            "content",
            List.of(Map.of("type", "text", "text", content)),
            "stop_reason",
            "end_turn",
            "usage",
            Map.of("input_tokens", input, "output_tokens", output)));
  }

  String seededDocument(int chunks) {
    String id = UUID.randomUUID().toString();
    db.update(
        "INSERT INTO documents(id,learner_id,name,page_count,created_at) VALUES (?,?,?,?,?)",
        id,
        owner,
        "lecture.pdf",
        chunks,
        Instant.now(clock).toString());
    for (int i = 0; i < chunks; i++) {
      db.update(
          "INSERT INTO document_pages(document_id,page_number,content) VALUES (?,?,?)",
          id,
          i + 1,
          "page " + (i + 1));
      db.update(
          "INSERT INTO document_chunks(document_id,chunk_index,start_page,end_page,content) VALUES (?,?,?,?,?)",
          id,
          i,
          i + 1,
          i + 1,
          "[PAGE " + (i + 1) + "] process content");
    }
    return id;
  }

  JsonNode live(String document) throws Exception {
    var job =
        call(body(post("/api/jobs"), Map.of("mode", "LIVE", "documentId", document)), 202, token);
    return waitJob(job.get("id").asText());
  }

  @Test
  void capabilitiesPublicConfigAndHealth() throws Exception {
    assertThat(token).hasSize(43).isNotEqualTo(other);
    assertThat(db.queryForObject("SELECT token_hash FROM learners WHERE id=?", String.class, owner))
        .isNotEqualTo(token)
        .hasSize(64);
    call(get("/api/tags"), 401, null);
    call(get("/api/dashboard"), 401, "invented");
    call(get("/api/tags"), 401, "a".repeat(43));
    assertThat(call(get("/api/tags"), 200, token)).hasSize(10);
    assertThat(call(get("/api/config"), 200, null).get("timezone").asText())
        .isEqualTo("Asia/Seoul");
    assertThat(call(get("/actuator/health"), 200, null).get("status").asText()).isEqualTo("UP");
  }

  @Test
  void demoIsFixedUnattributedAndAnswersAreHidden() throws Exception {
    var job = demo();
    assertThat(job.get("status").asText()).isEqualTo("succeeded");
    assertThat(job.get("questionCount").asInt()).isEqualTo(3);
    assertThat(job.get("documentId").isNull()).isTrue();
    var all = call(get("/api/questions"), 200, token);
    for (var q : all) {
      assertThat(q.get("text").asText()).startsWith("[샘플]");
      assertThat(q.get("sourceStartPage").isNull()).isTrue();
      assertThat(q.get("documentName").isNull()).isTrue();
      assertThat(q.get("mode").asText()).isEqualTo("DEMO");
      assertThat(q.get("correctIndex")).isNotNull();
    }
    var quiz = call(get("/api/questions?view=quiz"), 200, token);
    assertThat(quiz.get(0).has("correctIndex")).isFalse();
    assertThat(quiz.get(0).has("explanation")).isFalse();
    call(get("/api/questions?view=unknown"), 400, token);
    call(get("/api/questions?tagId=unknown"), 400, token);
    assertThat(call(get("/api/questions?view=due"), 200, token)).isEmpty();
    call(body(post("/api/jobs"), Map.of("mode", "DEMO", "documentId", "invented")), 400, token);
    assertThat(calls).hasValue(0);
  }

  @Test
  void isolationOnEveryOwnedResource() throws Exception {
    var q = first();
    String id = q.get("id").asText();
    var document = upload(pdf(1, true, false), 201);
    var job = call(get("/api/jobs"), 200, token).get(0);
    assertThat(call(get("/api/questions"), 200, other)).isEmpty();
    assertThat(call(get("/api/documents"), 200, other)).isEmpty();
    assertThat(call(get("/api/jobs"), 200, other)).isEmpty();
    assertThat(call(get("/api/dashboard"), 200, other).get("questionCount").asInt()).isZero();
    call(get("/api/questions/" + id), 404, other);
    call(delete("/api/questions/" + id), 404, other);
    call(body(put("/api/questions/" + id), editBody(q, 1)), 404, other);
    call(get("/api/jobs/" + job.get("id").asText()), 404, other);
    call(
        body(post("/api/jobs"), Map.of("mode", "LIVE", "documentId", document.get("id").asText())),
        404,
        other);
    call(
        body(
            post("/api/attempts"),
            Map.of(
                "questionId",
                id,
                "selectedIndex",
                0,
                "idempotencyKey",
                UUID.randomUUID().toString(),
                "version",
                1)),
        404,
        other);
  }

  Map<String, Object> editBody(JsonNode q, int version) {
    return fields(
        "text",
        "수정 문제",
        "options",
        List.of("하나", "둘", "셋", "넷"),
        "correctIndex",
        1,
        "tagId",
        "memory",
        "difficulty",
        "HARD",
        "explanation",
        "수정 설명",
        "version",
        version);
  }

  @Test
  void attemptsIdempotencyOverdueAndMidnight() throws Exception {
    var q = first();
    int correct = q.get("correctIndex").asInt();
    String key = UUID.randomUUID().toString();
    var result = answer(q, (correct + 1) % 4, key, 1);
    assertThat(result.get("box").asInt()).isEqualTo(1);
    assertThat(result.get("dueDate").asText()).isEqualTo("2026-09-18");
    assertThat(answer(q, (correct + 1) % 4, key, 1)).isEqualTo(result);
    call(
        body(
            post("/api/attempts"),
            Map.of(
                "questionId",
                q.get("id").asText(),
                "selectedIndex",
                correct,
                "idempotencyKey",
                key,
                "version",
                1)),
        409,
        token);
    assertThat(call(get("/api/questions?view=mistakes"), 200, token)).hasSize(1);
    assertThat(call(get("/api/dashboard"), 200, token).get("attemptCount").asInt()).isEqualTo(1);
    assertThat(call(get("/api/questions?view=due"), 200, token)).isEmpty();
    clock.time.set(Instant.parse("2026-09-17T15:00:00Z"));
    var due = call(get("/api/questions?view=due"), 200, token);
    assertThat(due).hasSize(1);
    assertThat(due.get(0).has("explanation")).isFalse();
    clock.time.set(Instant.parse("2026-09-20T15:00:00Z"));
    assertThat(call(get("/api/dashboard"), 200, token).get("dueCount").asInt()).isEqualTo(1);
    var promoted = answer(q, correct, UUID.randomUUID().toString(), 1);
    assertThat(promoted.get("box").asInt()).isEqualTo(2);
    assertThat(promoted.get("dueDate").asText()).isEqualTo("2026-09-24");
    assertThat(call(get("/api/questions?view=mistakes"), 200, token)).isEmpty();
    assertThat(call(get("/api/dashboard"), 200, token).get("accuracy").asDouble()).isEqualTo(50);
  }

  @Test
  void concurrentDuplicateSubmissionPromotesOnlyOnce() throws Exception {
    var q = first();
    String id = q.get("id").asText(), key = UUID.randomUUID().toString();
    AttemptRequest request = new AttemptRequest(id, q.get("correctIndex").asInt(), key, 1);
    try (var pool = Executors.newFixedThreadPool(8)) {
      List<Future<Object>> futures = new ArrayList<>();
      for (int i = 0; i < 16; i++)
        futures.add(pool.submit(() -> questions.attempt(owner, request)));
      Set<String> ids = new HashSet<>();
      for (var future : futures)
        ids.add(json.mapper.valueToTree(future.get(5, TimeUnit.SECONDS)).get("id").asText());
      assertThat(ids).hasSize(1);
    }
    assertThat(questions.get(owner, id, "manage").get("box")).isEqualTo(1);
    assertThat(
            db.queryForObject(
                "SELECT COUNT(*) FROM attempts WHERE question_id=?", Integer.class, id))
        .isEqualTo(1);
  }

  @Test
  void concurrentDifferentAttemptsDoNotLosePromotions() throws Exception {
    var q = first();
    String id = q.get("id").asText();
    try (var pool = Executors.newFixedThreadPool(8)) {
      List<Future<Object>> futures = new ArrayList<>();
      for (int i = 0; i < 8; i++)
        futures.add(
            pool.submit(
                () ->
                    questions.attempt(
                        owner,
                        new AttemptRequest(
                            id, q.get("correctIndex").asInt(), UUID.randomUUID().toString(), 1))));
      for (var future : futures) future.get(5, TimeUnit.SECONDS);
    }
    assertThat(questions.get(owner, id, "manage").get("box")).isEqualTo(5);
    assertThat(
            db.queryForObject(
                "SELECT COUNT(*) FROM attempts WHERE question_id=?", Integer.class, id))
        .isEqualTo(8);
  }

  @Test
  void editResetsReviewHistoryAndDeleteExcludesStats() throws Exception {
    var q = first();
    String id = q.get("id").asText();
    answer(q, 0, UUID.randomUUID().toString(), 1);
    var edited = call(body(put("/api/questions/" + id), editBody(q, 1)), 200, token);
    assertThat(edited.get("version").asInt()).isEqualTo(2);
    assertThat(edited.get("box").asInt()).isZero();
    assertThat(edited.get("dueDate").isNull()).isTrue();
    assertThat(edited.get("latestCorrect").isNull()).isTrue();
    assertThat(call(get("/api/dashboard"), 200, token).get("attemptCount").asInt()).isZero();
    call(body(put("/api/questions/" + id), editBody(q, 1)), 409, token);
    call(
        body(
            post("/api/attempts"),
            Map.of(
                "questionId",
                id,
                "selectedIndex",
                0,
                "idempotencyKey",
                UUID.randomUUID().toString(),
                "version",
                1)),
        409,
        token);
    answer(edited, 1, UUID.randomUUID().toString(), 2);
    call(delete("/api/questions/" + id), 204, token);
    call(get("/api/questions/" + id), 404, token);
    var dashboard = call(get("/api/dashboard"), 200, token);
    assertThat(dashboard.get("questionCount").asInt()).isEqualTo(2);
    assertThat(dashboard.get("attemptCount").asInt()).isZero();
  }

  @Test
  void validatesEditAndAttemptPayloads() throws Exception {
    var q = first();
    String id = q.get("id").asText();
    var invalid = editBody(q, 1);
    invalid.put("options", List.of("same", "same ", "third", "fourth"));
    call(body(put("/api/questions/" + id), invalid), 400, token);
    invalid = editBody(q, 1);
    invalid.put("tagId", "not-allowed");
    call(body(put("/api/questions/" + id), invalid), 400, token);
    invalid = editBody(q, 1);
    invalid.put("correctIndex", 1.5);
    call(body(put("/api/questions/" + id), invalid), 400, token);
    invalid = editBody(q, 1);
    invalid.put("correctIndex", "1");
    call(body(put("/api/questions/" + id), invalid), 400, token);
    invalid = editBody(q, 1);
    invalid.put("text", " ");
    call(body(put("/api/questions/" + id), invalid), 400, token);
    call(
        body(
            post("/api/attempts"),
            Map.of("questionId", id, "selectedIndex", 4, "idempotencyKey", "bad", "version", 1)),
        400,
        token);
    call(
        body(
            post("/api/attempts"),
            Map.of("questionId", id, "selectedIndex", 0, "idempotencyKey", "bad", "version", 1)),
        400,
        token);
    call(
        post("/api/jobs")
            .contentType("application/json")
            .content("{\"mode\":\"DEMO\",\"unknown\":true}"),
        400,
        token);
  }

  @Test
  void uploadValidationAndDocumentMetadata() throws Exception {
    upload(new byte[0], 400);
    upload("not a pdf".getBytes(StandardCharsets.UTF_8), 400);
    upload(pdf(1, false, false), 400);
    upload(pdf(1, true, true), 400);
    upload(pdf(81, false, false), 400);
    upload(new byte[10 * 1024 * 1024 + 1], 413);
    var doc = upload(pdf(2, true, false), 201);
    assertThat(doc.get("pageCount").asInt()).isEqualTo(2);
    assertThat(call(get("/api/documents"), 200, token)).hasSize(1);
    assertThat(doc.has("content")).isFalse();
    assertThat(doc.has("pdf")).isFalse();
    assertThat(documents.chunks(owner, doc.get("id").asText()).getFirst().pages())
        .containsExactlyInAnyOrder(1, 2);
  }

  @Test
  void successfulLiveUsesProvenanceAndStrictPrompt() throws Exception {
    var doc = upload(pdf(1, true, false), 201);
    var job = live(doc.get("id").asText());
    assertThat(job.get("status").asText()).isEqualTo("succeeded");
    var chunk = job.get("chunks").get(0);
    assertThat(chunk.get("attempts").asInt()).isEqualTo(1);
    assertThat(chunk.get("inputTokens").asInt()).isEqualTo(10);
    assertThat(chunk.get("outputTokens").asInt()).isEqualTo(20);
    assertThat(chunk.get("parseSuccess").asBoolean()).isTrue();
    var q = call(get("/api/questions"), 200, token).get(0);
    assertThat(q.get("sourceStartPage").asInt()).isEqualTo(1);
    assertThat(q.get("documentName").asText()).isEqualTo("lecture.pdf");
    assertThat(q.get("mode").asText()).isEqualTo("LIVE");
    assertThat(requests.getFirst())
        .contains("UNTRUSTED DATA", "JSON schema", "additionalProperties", "Allowed source pages");
    assertThat(requests.getFirst()).doesNotContain("test-placeholder");
  }

  @Test
  void schemaRetriesBoundedAndTokenUsageAccumulated() throws Exception {
    AtomicInteger sequence = new AtomicInteger();
    handler.set(
        request ->
            new Reply(
                200,
                envelope(
                    sequence.incrementAndGet() < 3 ? "{\"questions\":[]}" : generated(1, 1), 4, 7),
                0));
    var job = live(seededDocument(1));
    assertThat(job.get("status").asText()).isEqualTo("succeeded");
    var chunk = job.get("chunks").get(0);
    assertThat(chunk.get("attempts").asInt()).isEqualTo(3);
    assertThat(chunk.get("parseAttempts").asInt()).isEqualTo(3);
    assertThat(chunk.get("inputTokens").asInt()).isEqualTo(12);
    assertThat(chunk.get("outputTokens").asInt()).isEqualTo(21);
    assertThat(call(get("/api/questions"), 200, token)).hasSize(1);
  }

  @Test
  void partialRetainsSuccessfulChunks() throws Exception {
    handler.set(
        request ->
            request.contains("[PAGE 2]")
                ? new Reply(503, "private upstream details", 0)
                : new Reply(200, envelope(generated(1, 1), 2, 3), 0));
    var job = live(seededDocument(2));
    assertThat(job.get("status").asText()).isEqualTo("partial");
    assertThat(job.get("completedChunks").asInt()).isEqualTo(1);
    assertThat(job.get("failedChunks").asInt()).isEqualTo(1);
    assertThat(job.get("questionCount").asInt()).isEqualTo(1);
    assertThat(job.get("chunks").get(1).get("attempts").asInt()).isEqualTo(3);
    assertThat(job.toString()).doesNotContain("private upstream details");
    assertThat(calls).hasValue(4);
  }

  @ParameterizedTest
  @ValueSource(ints = {400, 401, 403, 429, 500})
  void providerHttpFailurePolicies(int status) throws Exception {
    handler.set(request -> new Reply(status, "SECRET upstream body", 0));
    var job = live(seededDocument(1));
    assertThat(job.get("status").asText()).isEqualTo("failed");
    assertThat(calls).hasValue(status == 429 || status >= 500 ? 3 : 1);
    assertThat(job.toString()).doesNotContain("SECRET");
    assertThat(call(get("/api/questions"), 200, token)).isEmpty();
  }

  @Test
  void providerTimeoutAndBoundedResponse() {
    var chunk = new Chunk(0, 1, 1, "data", Set.of(1));
    handler.set(request -> new Reply(200, "x".repeat(1024 * 1024 + 1), 0));
    assertThatThrownBy(() -> provider.generate(chunk, 3))
        .isInstanceOf(Provider.Failure.class)
        .hasMessage("PROVIDER_BODY_TOO_LARGE");
    handler.set(request -> new Reply(200, "{}", 1500));
    assertThatThrownBy(() -> provider.generate(chunk, 3))
        .isInstanceOf(Provider.Failure.class)
        .satisfies(
            e -> assertThat(e.getMessage()).isIn("PROVIDER_TIMEOUT", "PROVIDER_NETWORK_ERROR"));
  }

  @ParameterizedTest
  @ValueSource(
      strings = {
        "extra",
        "fraction",
        "string-index",
        "range",
        "blank-page",
        "unknown-tag",
        "duplicate-options",
        "short-options",
        "empty-text",
        "bad-difficulty",
        "too-many",
        "trailing",
        "duplicate-key",
        "fenced",
        "missing"
      })
  void rejectsMalformedSchemas(String mutation) {
    var root = (com.fasterxml.jackson.databind.node.ObjectNode) json.read(generated(1, 1));
    var q = (com.fasterxml.jackson.databind.node.ObjectNode) root.get("questions").get(0);
    switch (mutation) {
      case "extra" -> q.put("invented", true);
      case "fraction" -> q.put("correctIndex", 1.5);
      case "string-index" -> q.put("correctIndex", "1");
      case "range" -> q.put("sourceEndPage", 90);
      case "blank-page" -> q.put("sourceEndPage", 3);
      case "unknown-tag" -> q.put("tagId", "secret-tag");
      case "duplicate-options" ->
          q.set("options", json.mapper.valueToTree(List.of("a", "a ", "b", "c")));
      case "short-options" -> q.set("options", json.mapper.valueToTree(List.of("a", "b", "c")));
      case "empty-text" -> q.put("text", " ");
      case "bad-difficulty" -> q.put("difficulty", "IMPOSSIBLE");
      case "too-many" -> root.set("questions", json.mapper.valueToTree(Collections.nCopies(4, q)));
      case "missing" -> q.remove("explanation");
    }
    String raw =
        switch (mutation) {
          case "trailing" -> root + " {}";
          case "duplicate-key" ->
              root.toString()
                  .replace("\"correctIndex\":0", "\"correctIndex\":0,\"correctIndex\":1");
          case "fenced" -> "```json\n" + root + "\n```";
          default -> root.toString();
        };
    assertThatThrownBy(() -> provider.parse(raw, new Chunk(0, 1, 3, "data", Set.of(1, 3)), 3))
        .isInstanceOf(Exception.class);
  }

  @Test
  void schemaFailureStopsAtThreeAndNoQuestionsAreWritten() throws Exception {
    handler.set(request -> new Reply(200, envelope("{\"questions\":[]}", 1, 2), 0));
    var job = live(seededDocument(1));
    assertThat(job.get("status").asText()).isEqualTo("failed");
    assertThat(calls).hasValue(3);
    assertThat(job.get("chunks").get(0).get("parseSuccess").asBoolean()).isFalse();
    assertThat(call(get("/api/questions"), 200, token)).isEmpty();
  }

  @Test
  void jobQuestionQuotaAndAtomicDuplicateChunkCommit() throws Exception {
    handler.set(
        request -> {
          int page =
              Integer.parseInt(request.substring(request.indexOf("[PAGE ") + 6).split("]")[0]);
          var root =
              (com.fasterxml.jackson.databind.node.ObjectNode) json.read(generated(page, page));
          var array = root.putArray("questions");
          for (int i = 0; i < 3; i++) {
            var question =
                (com.fasterxml.jackson.databind.node.ObjectNode)
                    json.read(generated(page, page)).get("questions").get(0);
            question.put("text", "question " + page + "-" + i);
            array.add(question);
          }
          return new Reply(200, envelope(root.toString(), 1, 2), 0);
        });
    String doc = seededDocument(12);
    var job = live(doc);
    assertThat(job.get("status").asText()).isEqualTo("succeeded");
    assertThat(job.get("questionCount").asInt()).isEqualTo(30);
    assertThat(calls).hasValue(10);
    jobs.success(
        job.get("id").asText(),
        owner,
        new JobRequest(doc, Mode.LIVE),
        documents.chunks(owner, doc).getFirst(),
        Jobs.samples());
    assertThat(call(get("/api/questions"), 200, token)).hasSize(30);
    assertThat(jobs.get(owner, job.get("id").asText()).get("questionCount")).isEqualTo(30);
  }

  @Test
  void restartMarksPendingAndPreservesSuccess() throws Exception {
    var successful = demo();
    String completed = successful.get("id").asText();
    String id = UUID.randomUUID().toString();
    db.update(
        "INSERT INTO jobs(id,learner_id,mode,status,total_chunks,created_at) VALUES (?,?,'DEMO','running',2,?)",
        id,
        owner,
        Instant.now(clock).toString());
    db.update(
        "INSERT INTO job_chunks(job_id,chunk_index,status) VALUES (?,0,'running'),(?,1,'queued')",
        id,
        id);
    jobs.success(
        id,
        owner,
        new JobRequest(null, Mode.DEMO),
        new Chunk(0, 0, 0, "", Set.of()),
        Jobs.samples());
    String empty = UUID.randomUUID().toString();
    db.update(
        "INSERT INTO jobs(id,learner_id,mode,status,total_chunks,created_at) VALUES (?,?,'DEMO','queued',1,?)",
        empty,
        owner,
        Instant.now(clock).toString());
    db.update("INSERT INTO job_chunks(job_id,chunk_index,status) VALUES (?,0,'queued')", empty);
    jobs.recover();
    assertThat(jobs.get(owner, id).get("status")).isEqualTo("partial");
    assertThat(jobs.get(owner, id).get("questionCount")).isEqualTo(3);
    assertThat(jobs.get(owner, id).get("error")).isEqualTo("INTERRUPTED");
    assertThat(jobs.get(owner, empty).get("status")).isEqualTo("failed");
    assertThat(jobs.get(owner, completed).get("status")).isEqualTo("succeeded");
    jobs.recover();
    assertThat(call(get("/api/questions"), 200, token)).hasSize(6);
  }

  @Test
  void overloadIsExplicitAndMetadataPersists() throws Exception {
    CountDownLatch running = new CountDownLatch(2), release = new CountDownLatch(1);
    Runnable blocking =
        () -> {
          running.countDown();
          try {
            release.await();
          } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
          }
        };
    try {
      jobs.executor.execute(blocking);
      jobs.executor.execute(blocking);
      assertThat(running.await(2, TimeUnit.SECONDS)).isTrue();
      for (int i = 0; i < 8; i++) jobs.executor.execute(() -> {});
      var error = call(body(post("/api/jobs"), Map.of("mode", "DEMO")), 503, token);
      assertThat(error.get("code").asText()).isEqualTo("OVERLOADED");
      var list = call(get("/api/jobs"), 200, token);
      assertThat(list).hasSize(1);
      assertThat(list.get(0).get("status").asText()).isEqualTo("failed");
      assertThat(list.get(0).get("error").asText()).isEqualTo("OVERLOADED");
    } finally {
      release.countDown();
    }
  }

  @Test
  void chunkFailureRollsBackAllQuestionsAndCounters() {
    String id = UUID.randomUUID().toString();
    db.update(
        "INSERT INTO jobs(id,learner_id,mode,status,total_chunks,created_at) VALUES (?,?,'DEMO','running',1,?)",
        id,
        owner,
        Instant.now(clock).toString());
    db.update("INSERT INTO job_chunks(job_id,chunk_index,status) VALUES (?,0,'running')", id);
    var sample = Jobs.samples().getFirst();
    var invalid =
        new Generated(
            "invalid",
            sample.options(),
            0,
            "nonexistent",
            Difficulty.EASY,
            "explanation",
            null,
            null);
    assertThatThrownBy(
            () ->
                jobs.success(
                    id,
                    owner,
                    new JobRequest(null, Mode.DEMO),
                    new Chunk(0, 0, 0, "", Set.of()),
                    List.of(sample, invalid)))
        .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
    assertThat(
            db.queryForObject("SELECT COUNT(*) FROM questions WHERE job_id=?", Integer.class, id))
        .isZero();
    assertThat(jobs.get(owner, id).get("questionCount")).isEqualTo(0);
    assertThat(jobs.get(owner, id).get("completedChunks")).isEqualTo(0);
    jobs.failPending(id, "TEST_ROLLBACK");
  }

  @Test
  void liveRequiresExplicitEnableAndApiKey() {
    try {
      Provider disabled =
          new Provider("present", "model", "http://127.0.0.1", false, 1, json, questions);
      Provider noKey = new Provider("", "model", "http://127.0.0.1", true, 1, json, questions);
      try {
        assertThat(disabled.liveEnabled()).isFalse();
        assertThat(noKey.liveEnabled()).isFalse();
        assertThatThrownBy(() -> disabled.generate(new Chunk(0, 1, 1, "text", Set.of(1)), 3))
            .isInstanceOf(Provider.Failure.class)
            .hasMessage("LIVE_DISABLED");
        assertThat(calls).hasValue(0);
      } finally {
        disabled.close();
        noKey.close();
      }
    } catch (Exception e) {
      throw new AssertionError(e);
    }
  }
}
