import { createRoute, z } from "@hono/zod-openapi";

export const StatusCodes = {
  OK: 200,
  CREATED: 201,
  UNPROCESSABLE_ENTITY: 422,
} as const;

import {
  CreateUser,
  ListUsersQuery,
  LoginUser,
  UpdateUser,
  User,
  UserParams,
} from "./schemas.js";

const ErrorBody = z.object({
  errors: z.record(z.string(), z.array(z.string())),
});

export const login = createRoute({
  method: "post",
  path: "/login",
  request: {
    body: {
      content: {
        "application/json": { schema: LoginUser },
      },
    },
  },
  responses: {
    [StatusCodes.OK]: {
      content: {
        "application/json": { schema: User },
      },
      description: "Authenticated user",
    },
    [StatusCodes.UNPROCESSABLE_ENTITY]: {
      content: {
        "application/json": { schema: ErrorBody },
      },
      description: "Validation error",
    },
  },
});

export const register = createRoute({
  method: "post",
  path: "/users",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: CreateUser },
      },
    },
  },
  responses: {
    [StatusCodes.CREATED]: {
      content: {
        "application/json": { schema: User },
      },
      description: "Created user",
    },
  },
});

export const updateUser = createRoute({
  method: "put",
  path: "/user",
  request: {
    body: {
      content: {
        "application/json": { schema: UpdateUser },
      },
    },
  },
  responses: {
    [StatusCodes.OK]: {
      content: {
        "application/json": { schema: User },
      },
      description: "Updated user",
    },
  },
});

export const getUser = createRoute({
  method: "get",
  path: "/users/{id}",
  request: {
    params: { schema: UserParams },
  },
  responses: {
    [StatusCodes.OK]: {
      content: {
        "application/json": { schema: User },
      },
      description: "User profile",
    },
  },
});

export const listUsers = createRoute({
  method: "get",
  path: "/users",
  request: {
    query: { schema: ListUsersQuery },
  },
  responses: {
    [StatusCodes.OK]: {
      description: "User list",
    },
  },
});
