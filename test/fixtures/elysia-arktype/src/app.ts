import { Elysia } from "elysia";
import { type } from "arktype";

const UserResponse = type({
  id: "string.uuid",
  email: "string.email",
  bio: "string | null",
  image: "string.url | null",
});

const UsersResponse = type({
  users: UserResponse.array(),
});

const CreateUser = type({
  user: {
    username: "string >= 3",
    password: "8 <= string <= 100",
    website: "string.url?",
  },
});

export const app = new Elysia()
  .get("/users", () => ({ users: [] }), {
    response: UsersResponse,
  })
  .get("/users/:id", ({ params }) => ({ id: params.id }), {
    params: type({ id: "string.uuid" }),
    response: {
      200: UserResponse,
      404: type({ errors: "Record<string, string[]>" }),
    },
  })
  .post(
    "/users",
    ({ body, status }) => status(201, body),
    {
      body: CreateUser,
      response: { 201: UserResponse },
    },
  )
  .listen(3000);
