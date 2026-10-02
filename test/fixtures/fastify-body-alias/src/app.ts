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
