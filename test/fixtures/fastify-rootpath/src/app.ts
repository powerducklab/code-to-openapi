import Fastify, { FastifyInstance } from "fastify";

import usersPlugin from "./users.plugin.js";

interface RootReply {
  service: string;
  now: string;
}

async function rootHandler(): Promise<RootReply> {
  return { service: "demo", now: new Date().toISOString() };
}

export function buildServer(): FastifyInstance {
  const app = Fastify();

  // Route mounted at the application root: must be emitted as "/" (OAS paths
  // are absolute), never an empty string.
  app.get("/", rootHandler);

  app.get("/health", async () => ({ ok: true }));

  app.register(usersPlugin, { prefix: "/users" });

  return app;
}
