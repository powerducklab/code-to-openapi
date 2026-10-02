import fastify from "fastify";

import { bearer } from "./plugins/index.js";
import { routes } from "./routes/index.js";

// Class-held root instance: the fastify factory is assigned to a property in
// the constructor, and plugins are registered through `this.server`.
export class FastifyApp {
  private server: any;

  constructor() {
    this.server = fastify({ logger: true });
    this.server.register(bearer);
    this.server.register(routes, { prefix: "/api/v1" });
  }
}
