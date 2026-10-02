import { Elysia } from "elysia";
import type { User, UserInput, ErrorBody } from "./types.js";

const app = new Elysia();

app.get("/health", () => ({ status: "ok" }));

app.group("/api", (api) => {
  // GET /api/users?q=...  (query param; 400 + 200 responses)
  api.get(
    "/users",
    ({
      query,
      set,
    }: {
      query: { q?: string };
      set: { status: number };
    }) => {
      if (!query.q) {
        set.status = 400;
        const err: ErrorBody = { message: "missing q" };
        return err;
      }
      const result: User[] = [];
      return result;
    },
  );

  // GET /api/users/:id  (path param + header; 401 + 200 responses)
  api.get(
    "/users/:id",
    ({
      request,
      set,
    }: {
      request: { headers: { get: (k: string) => string | null } };
      set: { status: number };
    }) => {
      const token = request.headers.get("x-token");
      if (!token) {
        set.status = 401;
        const err: ErrorBody = { message: "unauthorized" };
        return err;
      }
      const user: User = { id: "1", name: "Ada", email: "ada@example.com" };
      return user;
    },
  );

  // POST /api/users  (typed body -> $ref, 201 response -> $ref)
  api.post(
    "/users",
    ({
      body,
      set,
    }: {
      body: UserInput;
      set: { status: number };
    }) => {
      set.status = 201;
      const created: User = { id: "1", name: body.name, email: body.email };
      return created;
    },
  );
});

export default app;
