import Router from "@koa/router";
import type { User, UserInput, ErrorBody } from "../types.js";

const router = new Router({ prefix: "/users" });

// GET /users?q=...
router.get("/", async (ctx) => {
  const q = ctx.query.q;
  if (!q) {
    ctx.status = 400;
    const err: ErrorBody = { message: "missing q" };
    ctx.body = err;
    return;
  }
  const result: User[] = [];
  ctx.body = result;
});

// GET /users/:id  (path param + header)
router.get("/:id", async (ctx) => {
  const id = ctx.params.id;
  const token = ctx.get("X-Token");
  if (!token) {
    ctx.status = 401;
    const err: ErrorBody = { message: "unauthorized" };
    ctx.body = err;
    return;
  }
  const user: User = { id, name: "Ada", email: "ada@example.com" };
  ctx.body = user;
});

// POST /users  (typed body, 201 response)
router.post("/", async (ctx) => {
  const body: UserInput = ctx.request.body;
  const created: User = { id: "1", name: body.name, email: body.email };
  ctx.status = 201;
  ctx.body = created;
});

export default router;
