import type { User, ErrorBody } from "../../../../types.js";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const token = request.headers.get("x-token");
  if (!token) {
    const err: ErrorBody = { message: "unauthorized" };
    return Response.json(err, { status: 401 });
  }
  const user: User = { id, name: "Ada", email: "ada@example.com" };
  return Response.json(user);
}

export async function DELETE() {
  return new Response(null, { status: 204 });
}
