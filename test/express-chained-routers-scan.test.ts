import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "fixtures", "express-chained-routers");

describe("express chained Router().use() composition and expression exports", () => {
  it("resolves Router().use(a).use(b), export default Router()..., and app.use(routes)", async () => {
    const result = await scanProject({ root, includeTests: true });
    const converted = await result.convert({ validate: true });
    expect(converted.documentValid).toBe(true);
    const paths = result.project.operations.map((o) => (o.fullPath ?? o.path));
    expect(paths).toContain("/api/articles");
    expect(paths).toContain("/api/articles/{slug}");
    expect(paths).toContain("/api/articles");
    // 3 routes from articles controller.
    expect(result.project.operations.length).toBe(3);
  });
});
