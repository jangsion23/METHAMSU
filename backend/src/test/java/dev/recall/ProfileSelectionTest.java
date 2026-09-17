package dev.recall;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class ProfileSelectionTest {
  @Test
  void springProfileFlagSelectsPostgresWithMockProviderTestSettings() {
    String previous = System.getProperty("spring.profiles.active");
    try {
      System.setProperty("spring.profiles.active", "pgtest");
      assertThat(new BackendIntegrationTest.Profiles().resolve(BackendIntegrationTest.class))
          .containsExactly("test", "pgtest");
    } finally {
      if (previous == null) System.clearProperty("spring.profiles.active");
      else System.setProperty("spring.profiles.active", previous);
    }
  }
}
