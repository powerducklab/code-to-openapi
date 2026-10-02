package com.acme.enter;

import static org.springframework.web.bind.annotation.RequestMethod.POST;

import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/enter")
public class EnterApi {

  // Static import of RequestMethod.POST -> bare `method = POST`.
  @RequestMapping(path = "users", method = POST)
  public ResponseEntity<AuthParams> create(@RequestBody AuthParams body) {
    return ResponseEntity.ok(body);
  }

  // Fully qualified RequestMethod.DELETE.
  @RequestMapping(path = "users/{id}", method = org.springframework.web.bind.annotation.RequestMethod.DELETE)
  public ResponseEntity<Void> delete(
      @PathVariable("id") Integer id,
      @AuthenticationPrincipal User principal) {
    return ResponseEntity.noContent().build();
  }

  @GetMapping("search")
  public ResponseEntity<String> search(
      @RequestParam("q") String q,
      @AuthenticationPrincipal User principal,
      @RequestHeader("Authorization") String auth) {
    return ResponseEntity.ok(q);
  }
}
