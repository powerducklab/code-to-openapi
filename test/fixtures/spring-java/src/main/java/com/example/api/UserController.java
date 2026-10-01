package com.example.api;

import com.example.api.dto.CreateUserRequest;
import com.example.api.model.User;
import com.example.api.model.UserEvent;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

import java.util.List;

@RestController
@RequestMapping("/api/users")
public class UserController {

  @GetMapping
  public List<User> list() {
    return List.of();
  }

  @GetMapping("/search")
  public List<User> search(
      @RequestParam("q") String q,
      @RequestParam(name = "page", required = false) Integer page,
      @RequestHeader(value = "X-Trace", required = false) String trace) {
    return List.of();
  }

  @GetMapping("/{id}")
  public User getUser(@PathVariable("id") String id) {
    return new User(id, "Ada Lovelace");
  }

  @PostMapping
  @ResponseStatus(HttpStatus.CREATED)
  public User create(@Valid @RequestBody CreateUserRequest request) {
    return new User("1", request.name());
  }

  @DeleteMapping("/{id}")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  public void delete(@PathVariable String id) {}

  @GetMapping(value = "/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<UserEvent> events() {
    return Flux.empty();
  }
}
