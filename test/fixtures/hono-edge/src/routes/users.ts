import { Hono } from "hono";
import type { User, UserInput, ErrorBody, OrderEvent } from "../types.js";

const users = new Hono();

// GET /api/users?q=...
users.get("/users", (c) => {
  const q = c.req.query("q");
  if (!q) {
    const err: ErrorBody = { message: "missing q" };
    return c.json(err, 400);
  }
  const result: User[] = [];
  return c.json(result);
});

// GET /api/users/:id  (path param + header)
users.get("/users/:id", (c) => {
  const id = c.req.param("id");
  const token = c.req.header("x-token");
  if (!token) {
    const err: ErrorBody = { message: "unauthorized" };
    return c.json(err, 401);
  }
  const user: User = { id, name: "Ada", email: "ada@example.com" };
  return c.json(user);
});

// POST /api/users  (typed body -> component $ref, 201 response -> $ref)
users.post("/users", async (c) => {
  const body = await c.req.json<UserInput>();
  const created: User = { id: "1", name: body.name, email: body.email };
  return c.json(created, 201);
});

// GET /api/users/:id/events  (SSE / streamSSE idiom)
users.get("/users/:id/events", (c) => {
  return c.streamSSE((stream) => {
    const evt: OrderEvent = { id: "e1", type: "created" };
    stream.writeData(evt);
  });
});

export const userRoutes = users;
