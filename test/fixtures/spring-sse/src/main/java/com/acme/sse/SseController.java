package com.acme.sse;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
@RequestMapping("/stream")
public class SseController {

  // Named events, data type statically known via .data(OrderDto.class).
  @GetMapping(value = "/orders", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public SseEmitter orders() {
    SseEmitter emitter = new SseEmitter();
    try {
      emitter.send(SseEmitter.event().name("created").data(new OrderDto(), MediaType.APPLICATION_JSON));
      emitter.send(SseEmitter.event().name("updated").data(OrderDto.class));
    } catch (Exception ignored) {
    }
    return emitter;
  }

  // Data type known from the local variable; no event name set.
  @GetMapping(value = "/simple", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public SseEmitter simple() {
    SseEmitter emitter = new SseEmitter();
    OrderDto dto = new OrderDto();
    try {
      emitter.send(SseEmitter.event().data(dto));
    } catch (Exception ignored) {
    }
    return emitter;
  }

  // Emitter built and returned from a service: no static event names or data.
  @GetMapping(value = "/proxy", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public ResponseBodyEmitter proxy() {
    return dynamicService.stream();
  }

  private DynamicService dynamicService = new DynamicService();

  static class DynamicService {
    ResponseBodyEmitter stream() {
      return new ResponseBodyEmitter();
    }
  }
}
