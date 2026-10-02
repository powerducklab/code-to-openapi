package com.acme.xsvc;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/articles")
public class ArticleController {
  private final ArticleService articleService;
  private final UserService userService;

  public ArticleController(ArticleService articleService, UserService userService) {
    this.articleService = articleService;
    this.userService = userService;
  }

  // Raw ResponseEntity: follow articleService.getArticle -> ArticleDto.
  @GetMapping("/{id}")
  public ResponseEntity getArticle(@PathVariable Long id) {
    return ResponseEntity.ok(articleService.getArticle(id));
  }

  // Raw ResponseEntity: follow listArticles -> List<ArticleDto>.
  @GetMapping
  public ResponseEntity list() {
    return ResponseEntity.ok(articleService.listArticles());
  }

  // Field type is an interface: follow userService.findById -> UserVo.
  @GetMapping("/users/{id}")
  public ResponseEntity getUser(@PathVariable Long id) {
    return ResponseEntity.ok(userService.findById(id));
  }

  // Nested generic envelope through the interface: PageResult<UserVo>.
  @GetMapping("/users/page")
  public ResponseEntity userPage() {
    return ResponseEntity.ok(userService.pageUsers());
  }

  // Dynamic Object return: must stay a gap (no fabricated DTO).
  @GetMapping("/dynamic")
  public ResponseEntity dynamic() {
    return ResponseEntity.ok(articleService.dynamic());
  }

  // Receiver is not an injected field: cannot be resolved statically.
  @GetMapping("/legacy")
  public ResponseEntity legacy() {
    return ResponseEntity.ok(com.acme.xsvc.support.LegacyHolder.render());
  }
}
