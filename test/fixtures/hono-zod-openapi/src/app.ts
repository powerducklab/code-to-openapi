import { Hono } from "hono";
import { usersController } from "./users.controller.js";

const app = new Hono();

app.route("/api", usersController);

export default app;
