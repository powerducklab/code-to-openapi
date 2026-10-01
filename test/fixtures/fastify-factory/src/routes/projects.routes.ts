import type { FastifyPluginAsync } from "fastify";

export interface Project {
  id: string;
  name: string;
}

export interface ProjectsDeps {
  list: (orgId: string) => Promise<Project[]>;
  create: (orgId: string, input: { name: string }) => Promise<Project>;
}

export function projectsRoutes(deps: ProjectsDeps): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Params: { orgId: string } }>(
      "/api/orgs/:orgId/projects",
      async (request) => {
        return { projects: await deps.list(request.params.orgId) };
      },
    );

    app.post<{
      Params: { orgId: string };
      Body: { name: string; description?: string };
    }>("/api/orgs/:orgId/projects", async (request) => {
      const project = await deps.create(request.params.orgId, {
        name: request.body.name,
      });
      return { project };
    });

    const startFlow = (provider: string) =>
      async (_request: unknown, reply: { redirect: (url: string) => unknown }) => {
        return reply.redirect(`https://provider.example/${provider}`);
      };

    app.get("/api/flow/google", startFlow("google"));

    async function serveManifest(
      request: { params: { orgId: string } },
      reply: { type: (media: string) => { send: (body: unknown) => void } },
    ) {
      const manifest = { orgId: request.params.orgId };
      reply.type("application/json").send(manifest);
    }

    app.get<{ Params: { orgId: string } }>(
      "/api/orgs/:orgId/manifest",
      async (request, reply) => {
        await serveManifest(request, reply);
      },
    );

    app.options("/api/orgs/:orgId/projects", async (_request, reply) => {
      reply.code(204).send();
    });

    app.get("/api/orgs/:orgId/ping", async () => ({ ok: true }));
  };
}
