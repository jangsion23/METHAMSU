package dev.recall;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Component
public class Learners implements HandlerInterceptor, WebMvcConfigurer {
  private final JdbcTemplate db;
  private final Clock clock;
  private final SecureRandom random = new SecureRandom();

  Learners(JdbcTemplate db, Clock clock) {
    this.db = db;
    this.clock = clock;
  }

  String create() {
    byte[] bytes = new byte[32];
    random.nextBytes(bytes);
    String token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    db.update(
        "INSERT INTO learners(id,token_hash,created_at) VALUES (?,?,?)",
        UUID.randomUUID().toString(),
        hash(token),
        Instant.now(clock).toString());
    return token;
  }

  static String hash(String token) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8)));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  @Override
  public void addInterceptors(InterceptorRegistry registry) {
    registry.addInterceptor(this).addPathPatterns("/api/**");
  }

  @Override
  public boolean preHandle(
      HttpServletRequest request, HttpServletResponse response, Object handler) {
    String path = request.getRequestURI();
    if (path.equals("/api/config") && request.getMethod().equals("GET")
        || path.equals("/api/learners") && request.getMethod().equals("POST")) return true;
    String token = request.getHeader("X-Learner-Token");
    if (token == null || !token.matches("[A-Za-z0-9_-]{43}")) throw unauthorized();
    var ids =
        db.queryForList("SELECT id FROM learners WHERE token_hash=?", String.class, hash(token));
    if (ids.isEmpty()) throw unauthorized();
    request.setAttribute("learner", ids.getFirst());
    return true;
  }

  private ApiException unauthorized() {
    return new ApiException(401, "INVALID_CAPABILITY", "학습자 토큰이 유효하지 않습니다.");
  }
}
