import { Elysia, t } from "elysia";

const UserDto = t.Object({
  id: t.String({ format: "uuid" }),
  email: t.String({ format: "email" }),
  age: t.Optional(t.Integer({ minimum: 0, maximum: 150 })),
  tags: t.Array(t.String()),
  nickname: t.Nullable(t.String()),
});

export const app = new Elysia()
  .get(
    "/users/:id",
    ({ params }) => ({ id: params.id }),
    {
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      query: t.Object({ include: t.Optional(t.String()), page: t.Optional(t.Integer({ minimum: 1 })) }),
      response: {
        200: UserDto,
        404: t.Object({ error: t.String() }),
      },
    },
  )
  .post(
    "/users",
    ({ body }) => ({ id: "00000000-0000-0000-0000-000000000000" }),
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        profile: t.Optional(t.Object({ bio: t.String() })),
      }),
      response: t.Object({ id: t.String({ format: "uuid" }) }),
    },
  )
  .group("/articles", (group) =>
    group
      .get(
        "/",
        () => ({ articles: [] }),
        {
          response: t.Object({ articles: t.Array(UserDto) }),
        },
      )
      .post(
        "/",
        ({ body, status }) => status(201, body),
        {
          body: t.Object({ title: t.String({ minLength: 1 }), body: t.String() }),
          response: { 201: UserDto },
        },
      ),
  )
  .listen(3000);
