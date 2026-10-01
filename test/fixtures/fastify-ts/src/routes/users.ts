import type { FastifyPluginAsync } from "fastify";
import type { User } from "../types.js";

const users: User[] = [{ id: "1", name: "Ada Lovelace" }];

const usersPlugin: FastifyPluginAsync = async (app) => {
  app.get(
    "/",
    {
      schema: {
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
              },
              required: ["id", "name"],
            },
          },
        },
      },
    },
    async (): Promise<User[]> => {
      return users;
    },
  );

  app.get(
    "/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
            required: ["id", "name"],
          },
          404: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      },
    },
    async (request, reply) => {
      const user = users.find((item) => item.id === request.params.id);
      if (!user) {
        reply.code(404).send({ message: "not found" });
        return;
      }
      return user;
    },
  );

  app.post(
    "/",
    {
      schema: {
        body: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        response: {
          201: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
            required: ["id", "name"],
          },
        },
      },
    },
    async (request, reply) => {
      const created: User = { id: "2", name: request.body.name };
      reply.code(201).send(created);
    },
  );
};

export default usersPlugin;
