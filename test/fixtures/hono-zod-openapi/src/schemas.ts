import { z } from "@hono/zod-openapi";

export const UserBase = z.object({
  email: z.string().email().openapi({ description: "Email address" }),
  username: z.string().min(2),
  bio: z.string().nullable(),
  image: z.string().url().nullable(),
});

export const CreateUser = z.object({
  user: UserBase.merge(z.object({ password: z.string().min(8) })),
});

export const UpdateUser = z.object({
  user: CreateUser.shape.user.partial(),
});

export const LoginUser = z.object({
  user: z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }),
});

export const User = z.object({
  user: UserBase.merge(
    z.object({
      token: z.string().openapi({ description: "JWT token" }),
    }),
  ),
});

export const UserParams = z.object({
  id: z.string().uuid(),
});

export const ListUsersQuery = z.object({
  q: z.string().optional(),
  page: z.string().optional(),
});
