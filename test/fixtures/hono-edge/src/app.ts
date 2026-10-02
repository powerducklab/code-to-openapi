import { Hono } from "hono";
import { userRoutes } from "./routes/users.js";

const app = new Hono();

app.get("/health", (c) => c.text("ok"));

app.route("/api", userRoutes);

export default app;
