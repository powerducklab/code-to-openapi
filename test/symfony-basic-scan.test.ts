import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "symfony-basic");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  return { result, converted };
}

function op(ops: any[], method: string, path: string) {
  const found = ops.find((o) => o.method === method && (o.fullPath ?? o.path) === path);
  expect(found, `${method} ${path}`).toBeDefined();
  return found;
}

describe("Symfony attribute routing pack", () => {
  it("produces a valid document and claims only symfony", async () => {
    const { result, converted } = await scan();
    expect(converted.ok).toBe(true);
    expect(converted.documentValid).toBe(true);
    expect(result.report.frameworks).toEqual(["symfony"]);
  });

  it("concatenates class and method #[Route] prefixes into full paths", async () => {
    const { result } = await scan();
    const paths = result.project.operations.map((o) => o.path).sort();
    expect(paths).toContain("/api/books");
    expect(paths).toContain("/api/books/{id}");
    expect(paths).toContain("/api/books/{id}/html");
    expect(paths).toContain("/api/books/{id}/file");
    expect(paths).toContain("/api/books/{id}/go");
  });

  it("binds {id} path params and #[MapQueryParameter] query params", async () => {
    const { result } = await scan();
    const list = op(result.project.operations, "get", "/api/books");
    const q = list.parameters.filter((p: any) => p.in === "query").map((p: any) => p.name).sort();
    expect(q).toEqual(["page", "q"]);
    expect(list.parameters.find((p: any) => p.in === "query" && p.name === "page").schema).toEqual({ type: "integer" });

    const show = op(result.project.operations, "get", "/api/books/{id}");
    const idParam = show.parameters.find((p: any) => p.in === "path" && p.name === "id");
    expect(idParam).toBeDefined();
  });

  it("maps #[MapRequestPayload] to a JSON request-body component $ref", async () => {
    const { result } = await scan();
    const create = op(result.project.operations, "post", "/api/books");
    expect(create.requestBody.content[0].mediaType).toBe("application/json");
    expect(create.requestBody.content[0].schema).toEqual({ $ref: "#/components/schemas/BookDto" });
    expect(create.responses.some((r: any) => r.statusCode === "201")).toBe(true);
    const dto = result.project.components.find((c: any) => c.name === "BookDto");
    expect(dto).toBeDefined();
    expect(dto.schema.properties.title).toEqual({ type: "string" });
    expect(dto.schema.properties.year).toEqual({ type: "integer" });
  });

  it("documents $this->json, new JsonResponse, render, redirectToRoute and StreamedResponse", async () => {
    const { result } = await scan();
    const show = op(result.project.operations, "get", "/api/books/{id}");
    expect(show.responses[0].content[0].mediaType).toBe("application/json");

    const html = op(result.project.operations, "get", "/api/books/{id}/html");
    expect(html.responses[0].content[0].mediaType).toBe("text/html");

    const file = op(result.project.operations, "get", "/api/books/{id}/file");
    expect(file.responses[0].content[0].mediaType).toBe("application/octet-stream");

    const redir = op(result.project.operations, "get", "/api/books/{id}/go");
    expect(redir.responses.some((r: any) => r.statusCode === "301")).toBe(true);
    expect(redir.responses[0].content).toBeUndefined();
  });

  it("supports method-level #[Route] on __invoke and class-only invokable controllers", async () => {
    const { result } = await scan();
    const profile = op(result.project.operations, "get", "/profile");
    expect(profile.responses[0].content[0].mediaType).toBe("application/json");

    const about = op(result.project.operations, "get", "/about");
    expect(about.responses[0].content[0].mediaType).toBe("text/html");
  });
});
