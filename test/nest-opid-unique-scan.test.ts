import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "fixtures", "nest-opid-unique");

describe("nest operationId uniqueness across controllers", () => {
  it("qualifies shared method names with the controller class", async () => {
    const result = await scanProject({ root, includeTests: true });
    const ids = result.project.operations.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("ArticlesController_findAll");
    expect(ids).toContain("ArticlesController_create");
    expect(ids).toContain("UsersController_findAll");
    expect(ids).toContain("UsersController_create");
  });
});
