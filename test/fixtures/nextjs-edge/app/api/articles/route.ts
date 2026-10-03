import * as z from "zod";

const articleCreateSchema = z.object({
  title: z.string(),
  tags: z.array(z.string()).optional(),
});

export async function POST(req: Request) {
  const json = await req.json();
  const body = articleCreateSchema.parse(json);
  return Response.json(
    { id: "art_1", title: body.title, tags: body.tags ?? [] },
    { status: 201 },
  );
}
