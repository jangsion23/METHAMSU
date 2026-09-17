package dev.recall;

import static org.assertj.core.api.Assertions.*;

import java.time.*;
import java.util.List;
import org.junit.jupiter.api.Test;

class LeitnerTest {
  @Test
  void allTransitionsAndCap() {
    LocalDate today = LocalDate.of(2026, 9, 17);
    int[] days = {1, 3, 7, 14, 30, 30};
    for (int box = 0; box <= 5; box++) {
      var correct = Leitner.answer(box, true, today);
      assertThat(correct.box()).isEqualTo(Math.min(5, box + 1));
      assertThat(correct.dueDate()).isEqualTo(today.plusDays(days[box]));
      var wrong = Leitner.answer(box, false, today);
      assertThat(wrong.box()).isEqualTo(1);
      assertThat(wrong.dueDate()).isEqualTo(today.plusDays(1));
    }
  }

  @Test
  void chunkBoundariesAndBlankPageProvenance() {
    var chunks = Documents.split(List.of("x".repeat(25000), "", "last page"));
    assertThat(chunks).hasSize(3);
    assertThat(chunks).allSatisfy(c -> assertThat(c.text().length()).isLessThanOrEqualTo(12000));
    assertThat(chunks.get(0).pages()).containsExactly(1);
    assertThat(chunks.get(2).pages()).containsExactlyInAnyOrder(1, 3);
    assertThat(
            chunks.stream()
                .map(c -> c.text().replaceAll("\\n\\[PAGE \\d+]\\n", ""))
                .reduce("", String::concat))
        .isEqualTo("x".repeat(25000) + "last page");
  }
}
