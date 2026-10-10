import { describe, expect, it } from "vitest";

import { mergeScannedDocument } from "../src/core/merge.js";
import type { DiscoverySidecar, SidecarRoute } from "../src/core/sidecar.js";

function sidecar(routes: Array<[string, string, string, string]>): DiscoverySidecar {
  return {
    version: 1,
    scannedAt: "2026-10-01T00:00:00.000Z",
    files: { "src/app.ts": "hash" },
    routes: routes.map<SidecarRoute>(([method, path, file, fingerprint]) => ({
      key: `${method} ${path}`,
      method,
      path,
      file,
      fingerprint,
    })),
  };
}

describe("mergeScannedDocument", () => {
  it("inserts added routes and leaves unchanged user edits untouched", () => {
    const current = {
      openapi: "3.2.0",
      info: { title: "mine", version: "1.0.0" },
      paths: {
        "/old": {
          get: {
            summary: "User written summary",
            description: "User written description",
            tags: ["curated"],
            responses: { "200": { description: "User response text" } },
          },
        },
      },
    };
    const scanned = {
      openapi: "3.2.0",
      info: { title: "scanned", version: "2.0.0" },
      paths: {
        "/old": { get: { responses: { "200": { description: "scanned" } } } },
        "/new": { post: { responses: { "201": { description: "created" } } } },
      },
    };
    const previous = sidecar([["get", "/old", "src/app.ts", "a"]]);
    const next = sidecar([
      ["get", "/old", "src/app.ts", "a"],
      ["post", "/new", "src/app.ts", "b"],
    ]);

    const result = mergeScannedDocument({ current, scanned, previous, next });

    expect(result.added).toEqual([{ method: "post", path: "/new" }]);
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toBe(1);
    const merged = result.document as any;
    // User prose on the unchanged route is never touched.
    expect(merged.paths["/old"].get.summary).toBe("User written summary");
    expect(merged.paths["/old"].get.description).toBe("User written description");
    expect(merged.paths["/old"].get.tags).toEqual(["curated"]);
    expect(merged.paths["/old"].get.responses["200"].description).toBe(
      "User response text",
    );
    expect(merged.paths["/new"].post.responses["201"].description).toBe("created");
    // Top-level user metadata is untouched.
    expect(merged.info.title).toBe("mine");
  });

  it("refreshes changed contracts while preserving user prose and examples", () => {
    const current = {
      openapi: "3.2.0",
      info: { title: "mine", version: "1.0.0" },
      paths: {
        "/items": {
          get: {
            operationId: "myCustomId",
            summary: "My summary",
            description: "My description",
            tags: ["catalog"],
            "x-internal": { owner: "team-a" },
            parameters: [
              {
                name: "q",
                in: "query",
                description: "User described q",
                example: "widget",
                schema: { type: "string" },
              },
              {
                name: "debug",
                in: "query",
                description: "User-only flag",
                schema: { type: "boolean" },
              },
            ],
            responses: {
              "200": {
                description: "User response description",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/ItemList" },
                    example: { items: [] },
                  },
                },
              },
              "500": { description: "User documented 500" },
            },
          },
        },
      },
      components: {
        schemas: {
          ItemList: {
            type: "object",
            properties: { items: { type: "array", items: {} } },
          },
        },
      },
    };
    const scanned = {
      openapi: "3.2.0",
      info: { title: "scanned", version: "2.0.0" },
      paths: {
        "/items": {
          get: {
            operationId: "listItems",
            parameters: [
              { name: "q", in: "query", schema: { type: "string" } },
              { name: "limit", in: "query", required: true, schema: { type: "integer" } },
            ],
            responses: {
              "200": {
                description: "scanned",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/ItemList" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          ItemList: {
            type: "object",
            properties: {
              items: { type: "array", items: { $ref: "#/components/schemas/Item" } },
              total: { type: "integer" },
            },
          },
          Item: { type: "object", properties: { id: { type: "string" } } },
        },
      },
    };
    const previous = sidecar([["get", "/items", "src/app.ts", "v1"]]);
    const next = sidecar([["get", "/items", "src/app.ts", "v2"]]);

    const result = mergeScannedDocument({ current, scanned, previous, next });
    expect(result.changed).toEqual([{ method: "get", path: "/items" }]);

    const op = (result.document as any).paths["/items"].get;
    expect(op.summary).toBe("My summary");
    expect(op.description).toBe("My description");
    expect(op.tags).toEqual(["catalog"]);
    expect(op.operationId).toBe("myCustomId");
    expect(op["x-internal"]).toEqual({ owner: "team-a" });

    const byName = new Map(
      op.parameters.map((p: any) => [`${p.in}:${p.name}`, p]),
    );
    expect(byName.get("query:q").description).toBe("User described q");
    expect(byName.get("query:q").example).toBe("widget");
    expect(byName.get("query:limit").schema).toEqual({ type: "integer" });
    // User-only parameter is retained.
    expect(byName.has("query:debug")).toBe(true);

    const ok = op.responses["200"];
    expect(ok.description).toBe("User response description");
    expect(ok.content["application/json"].example).toEqual({ items: [] });
    // User-only status is retained.
    expect(op.responses["500"].description).toBe("User documented 500");
    // Add-only components: new Item schema imported, existing ItemList untouched.
    const schemas = (result.document as any).components.schemas;
    expect(schemas.Item).toBeDefined();
    expect(schemas.ItemList.properties.total).toBeUndefined();
  });

  it("keeps removed routes in the document and reports them", () => {
    const current = {
      openapi: "3.2.0",
      info: { title: "mine", version: "1.0.0" },
      paths: {
        "/gone": { delete: { responses: { "204": { description: "gone" } } } },
      },
    };
    const scanned = {
      openapi: "3.2.0",
      info: { title: "scanned", version: "2.0.0" },
      paths: {},
    };
    const previous = sidecar([["delete", "/gone", "src/app.ts", "a"]]);
    const next = sidecar([]);

    const result = mergeScannedDocument({ current, scanned, previous, next });
    expect(result.removed).toEqual([{ method: "delete", path: "/gone" }]);
    expect((result.document as any).paths["/gone"].delete).toBeDefined();
  });

  it("renames colliding scanned components and rewrites refs", () => {
    const current = {
      openapi: "3.2.0",
      info: { title: "mine", version: "1.0.0" },
      paths: {},
      components: {
        schemas: {
          User: { type: "object", properties: { internalId: { type: "string" } } },
        },
      },
    };
    const scanned = {
      openapi: "3.2.0",
      info: { title: "scanned", version: "2.0.0" },
      paths: {
        "/users": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/User" },
                },
              },
            },
            responses: { "201": { description: "created" } },
          },
        },
      },
      components: {
        schemas: {
          User: { type: "object", properties: { email: { type: "string" } } },
        },
      },
    };
    const previous = sidecar([]);
    const next = sidecar([["post", "/users", "src/app.ts", "a"]]);

    const result = mergeScannedDocument({ current, scanned, previous, next });
    const schemas = (result.document as any).components.schemas;
    // Existing user schema is untouched.
    expect(schemas.User.properties).toEqual({ internalId: { type: "string" } });
    expect(schemas.User2).toBeDefined();
    const body = (result.document as any).paths["/users"].post.requestBody.content[
      "application/json"
    ];
    expect(body.schema.$ref).toBe("#/components/schemas/User2");
  });
});

it('merges and reports removed extension methods through additionalOperations', () => {
  const operation = {responses:{'200':{description:'ok'}}};
  const current = {paths:{'/items':{additionalOperations:{PROPFIND:{...operation,summary:'My notes'}}}}};
  const scanned = {paths:{'/items':{additionalOperations:{PROPFIND:{responses:{'207':{description:'multi'}}},REPORT:operation}}}};
  const result = mergeScannedDocument({current,scanned,
    previous:sidecar([['PROPFIND','/items','a','old']]),
    next:sidecar([['PROPFIND','/items','a','new'],['REPORT','/items','a','added']]),
  });
  const item=(result.document as any).paths['/items'];
  expect(item.additionalOperations.PROPFIND.summary).toBe('My notes');
  expect(item.additionalOperations.PROPFIND.responses['207']).toBeDefined();
  expect(item.additionalOperations.REPORT).toBeDefined();
  expect(item.PROPFIND).toBeUndefined();
  expect(result.added).toHaveLength(1);expect(result.changed).toHaveLength(1);
  const removed=mergeScannedDocument({current:result.document,scanned:{paths:{}},previous:sidecar([['REPORT','/items','a','added']]),next:sidecar([])});
  expect(removed.removed).toEqual([{method:'REPORT',path:'/items'}]);
});
