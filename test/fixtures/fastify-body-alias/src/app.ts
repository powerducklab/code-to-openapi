import Fastify from "fastify";

interface CreatePostPayload {
  heading: string;
  subHeading?: string;
  body: string;
}

const app = Fastify({ logger: true });

// Schema-less route: the body shape is inferred from `const payload =
// request.body; payload.<field>` accesses in the handler.
app.post("/posts", async (request, reply) => {
  const payload: CreatePostPayload = request.body;
  const slug = payload.heading.toLowerCase();
  const text = `${payload.heading}\n${payload.subHeading ?? ""}\n${payload.body}`;
  void slug;
  void text;
  reply.code(201).send({ id: "1" });
});

app.listen({ port: 3200 });

// Production login shape: runtime narrowing after a defensive body alias.
app.post("/api/admin/login", async (request, reply) => {
  const body = (request.body ?? {}) as { password?: unknown };
  const candidate = typeof body.password === "string" ? body.password : "";
  if (!candidate) throw new Error("Invalid operator password");
  void body.password; // A later unnarrowed read must not erase string evidence.
  reply.send({ authenticated: true });
});

app.post("/opaque", async (request, reply) => {
  const body = (request.body ?? {}) as { value?: unknown };
  reply.send({ received: Boolean(body.value) });
});

app.post("/fallback", async (request, reply) => {
  const body = (request.body ?? { localOnly: "default" }) as { localOnly: string };
  reply.send({ received: body.localOnly });
});

interface RelayBody { messages?: unknown; tools?: unknown; organizationId?: string }
function sanitizePayload(body: RelayBody | undefined) {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) throw new Error("messages required");
  const messages = body.messages;
  let tools: unknown[] | undefined;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new Error("tools must be array");
    tools = body.tools;
  }
  return { messages, tools };
}
app.post("/api/ai/chat/completions", async (request, reply) => {
  const body = request.body as RelayBody | undefined;
  const { messages, tools } = sanitizePayload(body);
  void body?.organizationId;
  const upstream = await fetch("https://example.invalid", { method: "POST", body: JSON.stringify({ messages, tools }) });
  reply.header("content-type", upstream.headers.get("content-type") ?? "application/json");
  reply.send(await upstream.text());
});
