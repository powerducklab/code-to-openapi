import { Controller, Get, Post } from "@nestjs/common";

@Controller("articles")
export class ArticlesController {
  @Get()
  findAll() { return []; }

  @Post()
  create() { return {}; }
}
