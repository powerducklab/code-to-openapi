import type { FastifyInstance } from "fastify";

// Identifier-form plugin: the function itself is the plugin (first parameter
// is the Fastify instance), registered as `app.register(convertRoutes, opts)`.
export async function convertRoutes(fastify: FastifyInstance) {
  fastify.post("/api/convert", async (request: unknown) => {
    return { received: Boolean(request) };
  });
}
