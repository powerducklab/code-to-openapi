import { Controller, Get, UseGuards } from "@nestjs/common";

interface Profile {
  id: string;
  email: string;
}

class JwtAuthGuard {}

@Controller("admin")
@UseGuards(JwtAuthGuard)
export class AdminController {
  @Get("profile")
  profile(): Profile {
    return { id: "1", email: "ada@example.com" };
  }
}
