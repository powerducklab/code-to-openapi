import { Module } from "@nestjs/common";
import { UsersController } from "./users/users.controller.js";
import { AdminController } from "./auth/admin.controller.js";

@Module({
  controllers: [UsersController, AdminController],
})
export class AppModule {}
