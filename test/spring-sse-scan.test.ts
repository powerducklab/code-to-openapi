import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "spring-sse");

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

describe("spring SSE event schemas", () => {
  it("emits named events with a concrete data component $ref", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const orders = op(ops, "get", "/stream/orders");
    expect(orders.extensions?.["x-protocol"]).toBe("sse");
    const item = orders.responses[0].content[0].itemSchema;
    expect(item.properties.event.enum.sort()).toEqual(["created", "updated"]);
    expect(item.properties.data).toEqual({ $ref: "#/components/schemas/OrderDto" });
    expect(orders.gaps).not.toContain("sse-events-unknown");
  });

  it("uses the data schema directly when no event name is set", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const simple = op(ops, "get", "/stream/simple");
    expect(simple.responses[0].content[0].itemSchema).toEqual({
      $ref: "#/components/schemas/OrderDto",
    });
    expect(simple.gaps).not.toContain("sse-events-unknown");
  });

  it("keeps sse-events-unknown when the emitter is built dynamically", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const proxy = op(ops, "get", "/stream/proxy");
    expect(proxy.gaps).toContain("sse-events-unknown");
  });
});
