import Fastify from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";

import { projectsRoutes } from "./routes/projects.routes.js";
import { convertRoutes } from "./routes/convert.routes.js";

export async function buildServer() {
  const app = Fastify({ logger: false });

  // Third-party middleware plugins expose no routes and must not be reported
  // as unresolved handlers.
  await app.register(helmet);
  await app.register(cors, { origin: true });

  // Factory-call plugin: register(buildRoutes(deps)).
  await app.register(
    projectsRoutes({
      list: async () => [],
      create: async (_orgId: string, input: { name: string }) => ({
        id: "p1",
        name: input.name,
      }),
    }),
  );

  // Identifier-form plugin.
  await app.register(convertRoutes);

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
