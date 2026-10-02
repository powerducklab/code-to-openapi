import { FastifyInstance } from "fastify";

import * as controllers from "./controllers/index.js";

// Namespaced plugin: routes reference handlers as `controllers.create`, where
// `controllers` is a namespace import re-exported through a barrel (`export *`).
const usersPlugin = async (fastify: FastifyInstance) => {
  fastify.post(
    "/",
    {
      schema: {
        body: {
          type: "object",
          required: ["email"],
          properties: {
            email: { type: "string", format: "email" },
          },
        },
      },
    },
    controllers.create,
  );

  fastify.get("/:id", controllers.getOne);
};

export default usersPlugin;
