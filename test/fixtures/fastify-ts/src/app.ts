import Fastify from "fastify";
import usersPlugin from "./routes/users.js";

const app = Fastify({ logger: true });

app.get("/health", async () => {
  return { status: "ok" };
});

// Inline registered plugin with a route prefix.
app.register(
  async (admin) => {
    admin.post("/ping", async (_request, reply) => {
      reply.code(201).send({ pong: true });
    });
  },
  { prefix: "/admin" },
);

app.register(usersPlugin, { prefix: "/api/users" });

app.listen({ port: 3100 });
