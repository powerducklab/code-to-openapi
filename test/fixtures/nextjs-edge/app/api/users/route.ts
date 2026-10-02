import type { User, UserInput, ErrorBody } from "../../../types.js";

export async function GET(request: Request) {
  const q = request.nextUrl.searchParams.get("q");
  if (!q) {
    const err: ErrorBody = { message: "missing q" };
    return Response.json(err, { status: 400 });
  }
  const result: User[] = [];
  return Response.json(result);
}

export async function POST(request: Request) {
  const body: UserInput = (await request.json()) as UserInput;
  const created: User = { id: "1", name: body.name, email: body.email };
  return Response.json(created, { status: 201 });
}
