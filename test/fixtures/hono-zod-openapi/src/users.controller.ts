import { OpenAPIHono } from "@hono/zod-openapi";
import * as routes from "./users.routes.js";

export const usersController = new OpenAPIHono();

usersController.openapi(routes.login, async (c) => {
  const body = c.req.valid("json");
  return c.json({ user: { ...body.user, token: "t" } }, 200);
});

usersController.openapi(routes.register, async (c) => {
  const body = c.req.valid("json");
  return c.json({ user: { ...body.user, token: "t" } }, 201);
});

usersController.openapi(routes.updateUser, async (c) => {
  const body = c.req.valid("json");
  return c.json({ user: body.user }, 200);
});

usersController.openapi(routes.getUser, async (c) => {
  const { id } = c.req.valid("param");
  return c.json({ user: { id } }, 200);
});

usersController.openapi(routes.listUsers, async (c) => {
  const query = c.req.valid("query");
  return c.json({ users: [], query }, 200);
});
