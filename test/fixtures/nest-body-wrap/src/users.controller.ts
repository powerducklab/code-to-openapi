import { Body, Controller, Param, Post, Put } from "@nestjs/common";

import { CreateUserDto, UpdateUserDto } from "./dto.js";

@Controller("users")
export class UsersController {
  // `@Body('user')` selects req.body.user: the wire body is the envelope
  // `{ "user": CreateUserDto }`, so the DTO must be wrapped under the key.
  @Post()
  create(@Body("user") dto: CreateUserDto): void {
    void dto;
  }

  // `@Body()` with no key: the DTO itself is the body root (backward compatible).
  @Put(":id")
  update(@Param("id") id: string, @Body() dto: UpdateUserDto): void {
    void id;
    void dto;
  }
}
