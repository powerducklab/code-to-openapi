import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Sse,
  type MessageEvent,
} from "@nestjs/common";
import { Observable } from "rxjs";
import type { User } from "./user.interface.js";
import { CreateUserDto } from "./dto/create-user.dto.js";
import { SearchUsersDto } from "./dto/search-users.dto.js";

interface StreamEvent<T> {
  data: T;
  id?: string;
}

@Controller("users")
export class UsersController {
  @Get()
  list(): User[] {
    return [];
  }

  @Get("search")
  search(@Query() query: SearchUsersDto): User[] {
    return [];
  }

  @Get(":id")
  detail(@Param("id") id: string): User {
    return { id, name: "Ada Lovelace" };
  }

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateUserDto): User {
    return { id: "1", name: dto.name };
  }

  @Post("import")
  @HttpCode(200)
  importUsers(): { imported: boolean } {
    return { imported: true };
  }

  @Sse("events")
  events(): Observable<StreamEvent<User>> {
    return new Observable<StreamEvent<User>>();
  }
}

// Reference the Nest MessageEvent type so the fixture mirrors real usage while
// keeping the extracted stream shape deterministic without node_modules.
export type NestEvent = MessageEvent;
