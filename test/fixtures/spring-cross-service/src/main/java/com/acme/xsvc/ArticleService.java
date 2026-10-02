package com.acme.xsvc;

import com.acme.xsvc.dto.ArticleDto;
import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class ArticleService {
  public ArticleDto getArticle(Long id) {
    return new ArticleDto();
  }

  public List<ArticleDto> listArticles() {
    return List.of();
  }

  // Dynamic return type: must NOT be promoted to a concrete schema.
  public Object dynamic() {
    return new java.util.HashMap<>();
  }
}
