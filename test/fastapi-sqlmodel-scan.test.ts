import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "fastapi-sqlmodel");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert({ validate: true });
  return { result, converted };
}

function op(ops: any[], method: string, path: string) {
  const found = ops.find((o) => o.method === method && (o.fullPath ?? o.path) === path);
  expect(found, `${method} ${path}`).toBeDefined();
  return found;
}

describe("SQLModel model recognition", () => {
  it("treats SQLModel subclasses (incl. table=True) as components and resolves response_model", async () => {
    const { result, converted } = await scan();
    expect(converted.ok, converted.diagnostics.map((d) => d.message).join("; ")).toBe(true);
    expect(converted.documentValid).toBe(true);

    // The list endpoint yields an array of HeroPublic.
    const list = op(result.project.operations, "get", "/heroes");
    const r200 = list.responses.find((r: any) => r.statusCode === "200");
    const arr = r200.content[0].schema ?? r200.content[0].itemSchema;
    expect(arr.items.$ref).toContain("HeroPublic");

    // The item endpoint resolves directly to the HeroPublic component.
    const item = op(result.project.operations, "get", "/heroes/{hero_id}");
    const item200 = item.responses.find((r: any) => r.statusCode === "200");
    expect(item200.content[0].schema.$ref).toContain("HeroPublic");

    // HeroPublic is a real component inheriting HeroBase fields and adding id.
    const components = Object.keys(converted.document.components?.schemas ?? {});
    expect(components).toContain("HeroPublic");
    const hero = converted.document.components!.schemas!.HeroPublic as any;
    expect(Object.keys(hero.properties).sort()).toEqual(["age", "id", "name", "secret_name"]);
  });
});
