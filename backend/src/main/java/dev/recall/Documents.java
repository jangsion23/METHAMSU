package dev.recall;

import static dev.recall.Models.*;
import static dev.recall.Questions.fields;

import java.io.IOException;
import java.time.Clock;
import java.time.Instant;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.multipart.MultipartFile;

@Service
public class Documents {
  final JdbcTemplate db;
  final TransactionTemplate tx;
  final Clock clock;

  Documents(JdbcTemplate db, TransactionTemplate tx, Clock clock) {
    this.db = db;
    this.tx = tx;
    this.clock = clock;
  }

  Map<String, Object> upload(String learner, MultipartFile file) {
    if (file.getSize() > 10 * 1024 * 1024)
      throw new ApiException(413, "FILE_TOO_LARGE", "PDF는 10MB 이하여야 합니다.");
    if (file.isEmpty()) throw ApiException.bad("빈 파일은 업로드할 수 없습니다.");
    List<String> pages = new ArrayList<>();
    try (PDDocument pdf = Loader.loadPDF(file.getBytes())) {
      if (pdf.isEncrypted()) throw ApiException.bad("암호화된 PDF는 지원하지 않습니다.");
      if (pdf.getNumberOfPages() < 1 || pdf.getNumberOfPages() > 80)
        throw ApiException.bad("PDF는 1~80페이지여야 합니다.");
      PDFTextStripper stripper = new PDFTextStripper();
      int chars = 0;
      for (int i = 1; i <= pdf.getNumberOfPages(); i++) {
        stripper.setStartPage(i);
        stripper.setEndPage(i);
        String text = stripper.getText(pdf).replace("\u0000", "").strip();
        chars += text.length();
        if (chars > 1_000_000) throw ApiException.bad("추출한 텍스트는 100만 자 이하여야 합니다.");
        pages.add(text);
      }
    } catch (IOException | IllegalArgumentException e) {
      throw ApiException.bad("텍스트 PDF만 지원합니다. 파일 형식과 암호화를 확인해 주세요.");
    }
    if (pages.stream().allMatch(String::isBlank))
      throw ApiException.bad("텍스트가 없는 PDF입니다. 스캔 문서는 지원하지 않습니다.");
    var chunks = split(pages);
    String raw =
        Optional.ofNullable(file.getOriginalFilename()).orElse("document.pdf").replace('\\', '/');
    String name = raw.substring(raw.lastIndexOf('/') + 1).replaceAll("[\\p{Cntrl}]", "").strip();
    if (name.isBlank()) name = "document.pdf";
    if (name.length() > 255) name = name.substring(0, 255);
    final String filename = name,
        id = UUID.randomUUID().toString(),
        created = Instant.now(clock).toString();
    tx.executeWithoutResult(
        status -> {
          db.update(
              "INSERT INTO documents(id,learner_id,name,page_count,created_at) VALUES (?,?,?,?,?)",
              id,
              learner,
              filename,
              pages.size(),
              created);
          for (int i = 0; i < pages.size(); i++)
            db.update(
                "INSERT INTO document_pages(document_id,page_number,content) VALUES (?,?,?)",
                id,
                i + 1,
                pages.get(i));
          for (var chunk : chunks)
            db.update(
                "INSERT INTO document_chunks(document_id,chunk_index,start_page,end_page,content) VALUES (?,?,?,?,?)",
                id,
                chunk.index(),
                chunk.startPage(),
                chunk.endPage(),
                chunk.text());
        });
    return fields("id", id, "name", filename, "pageCount", pages.size(), "createdAt", created);
  }

  static List<Chunk> split(List<String> pages) {
    List<Chunk> chunks = new ArrayList<>();
    StringBuilder text = new StringBuilder();
    Set<Integer> included = new LinkedHashSet<>();
    for (int page = 1; page <= pages.size(); page++) {
      String content = pages.get(page - 1);
      if (content.isBlank()) continue;
      int offset = 0;
      while (offset < content.length()) {
        String prefix = "\n[PAGE " + page + "]\n";
        if (text.length() + prefix.length() + 1 > 12000) {
          add(chunks, text, included);
          text.setLength(0);
          included.clear();
        }
        int end = Math.min(content.length(), offset + 12000 - text.length() - prefix.length());
        text.append(prefix).append(content, offset, end);
        included.add(page);
        offset = end;
        if (offset < content.length()) {
          add(chunks, text, included);
          text.setLength(0);
          included.clear();
        }
      }
    }
    if (!text.isEmpty()) add(chunks, text, included);
    return chunks;
  }

  private static void add(List<Chunk> chunks, StringBuilder text, Set<Integer> pages) {
    chunks.add(
        new Chunk(
            chunks.size(),
            Collections.min(pages),
            Collections.max(pages),
            text.toString(),
            Set.copyOf(pages)));
  }

  List<Map<String, Object>> list(String learner) {
    return db.query(
        "SELECT * FROM documents WHERE learner_id=? ORDER BY created_at DESC",
        (r, n) ->
            fields(
                "id",
                r.getString("id"),
                "name",
                r.getString("name"),
                "pageCount",
                r.getInt("page_count"),
                "createdAt",
                r.getString("created_at")),
        learner);
  }

  List<Chunk> chunks(String learner, String id) {
    if (id == null
        || db.queryForObject(
                "SELECT COUNT(*) FROM documents WHERE id=? AND learner_id=?",
                Integer.class,
                id,
                learner)
            != 1) throw ApiException.missing();
    Set<Integer> nonblank =
        new HashSet<>(
            db.queryForList(
                "SELECT page_number FROM document_pages WHERE document_id=? AND content<>''",
                Integer.class,
                id));
    return db.query(
        "SELECT * FROM document_chunks WHERE document_id=? ORDER BY chunk_index",
        (r, n) -> {
          int start = r.getInt("start_page"), end = r.getInt("end_page");
          Set<Integer> pages = new HashSet<>(nonblank);
          pages.removeIf(p -> p < start || p > end);
          return new Chunk(r.getInt("chunk_index"), start, end, r.getString("content"), pages);
        },
        id);
  }
}
