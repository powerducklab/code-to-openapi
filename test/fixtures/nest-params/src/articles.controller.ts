import { Controller, Get, Param, Query } from "@nestjs/common";

import { ListArticlesQueryDto } from "./dto.js";

@Controller("articles")
export class ArticlesController {
  // `@Param("slug") slug` with NO type annotation: at the HTTP layer every
  // path parameter is a string, so the gap must be closed with { type: string }.
  @Get(":slug")
  findOne(@Param("slug") slug) {
    return slug;
  }

  // `@Query()` with a DTO class: expand the DTO properties into query params.
  @Get()
  findAll(@Query() query: ListArticlesQueryDto) {
    return query;
  }
}
