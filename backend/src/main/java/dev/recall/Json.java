package dev.recall;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

@Component
public class Json {
  final ObjectMapper mapper;

  Json(ObjectMapper mapper) {
    this.mapper = mapper;
  }

  String write(Object value) {
    try {
      return mapper.writeValueAsString(value);
    } catch (JsonProcessingException e) {
      throw new IllegalStateException(e);
    }
  }

  JsonNode read(String value) {
    try {
      return mapper.readTree(value);
    } catch (JsonProcessingException e) {
      throw ApiException.bad("올바른 JSON이 아닙니다.");
    }
  }
}
