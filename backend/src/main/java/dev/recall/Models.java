package dev.recall;

import jakarta.validation.constraints.*;
import java.util.List;
import java.util.Set;

public final class Models {
  private Models() {}

  public record JobRequest(String documentId, @NotNull Mode mode) {}

  public enum Mode {
    LIVE,
    DEMO
  }

  public enum Difficulty {
    EASY,
    MEDIUM,
    HARD
  }

  public record EditRequest(
      @NotBlank @Size(max = 4000) String text,
      @NotNull @Size(min = 4, max = 4) List<@NotBlank @Size(max = 1000) String> options,
      @NotNull @Min(0) @Max(3) Integer correctIndex,
      @NotBlank String tagId,
      @NotNull Difficulty difficulty,
      @NotBlank @Size(max = 6000) String explanation,
      @NotNull @Min(1) Integer version) {}

  public record AttemptRequest(
      @NotBlank String questionId,
      @NotNull @Min(0) @Max(3) Integer selectedIndex,
      @NotBlank String idempotencyKey,
      @NotNull @Min(1) Integer version) {}

  public record Generated(
      String text,
      List<String> options,
      int correctIndex,
      String tagId,
      Difficulty difficulty,
      String explanation,
      Integer sourceStartPage,
      Integer sourceEndPage) {}

  public record Chunk(int index, int startPage, int endPage, String text, Set<Integer> pages) {}
}
