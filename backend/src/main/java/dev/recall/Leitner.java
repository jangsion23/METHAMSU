package dev.recall;

import java.time.LocalDate;

public final class Leitner {
  private static final int[] DAYS = {0, 1, 3, 7, 14, 30};

  private Leitner() {}

  public record Review(int box, LocalDate dueDate) {}

  public static Review answer(int box, boolean correct, LocalDate today) {
    int next = box == 0 || !correct ? 1 : Math.min(5, box + 1);
    return new Review(next, today.plusDays(DAYS[next]));
  }
}
