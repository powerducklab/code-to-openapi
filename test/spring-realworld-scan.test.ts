import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "spring-realworld");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
  expect(converted.documentValid).toBe(true);
  return { result, converted, doc: converted.document as any };
}

describe("spring real-world patterns", () => {
  it("specializes nested list envelopes with snake_case DTOs", async () => {
    const { doc } = await scan();

    const schema = doc.paths["/api/envs"].get.responses["200"].content["application/json"].schema;
    expect(schema).toEqual({ $ref: "#/components/schemas/CommonResult_ProjectEnvRespList" });

    const envelope = doc.components.schemas.CommonResult_ProjectEnvRespList;
    expect(envelope.properties.data.items).toEqual({
      $ref: "#/components/schemas/ProjectEnvResp",
    });

    const env = doc.components.schemas.ProjectEnvResp;
    expect(env.properties.env_id).toEqual({ type: "integer", format: "int64" });
    expect(env.properties.server_list.items).toEqual({
      $ref: "#/components/schemas/EnvServerResp",
    });
    expect(env.properties.env_var_list).toEqual({
      type: "object",
      additionalProperties: { $ref: "#/components/schemas/EnvParamResp" },
    });
  });

  it("expands unannotated POJO query beans even with validation groups", async () => {
    const { doc } = await scan();
    const params = doc.paths["/api/envs"].get.parameters;
    const names = params.map((p: any) => p.name).sort();
    expect(names).toEqual(["name", "projectId"]);
    for (const p of params) {
      expect(p.in).toBe("query");
      expect(p.schema).toBeDefined();
    }
  });

  it("renders bounded wildcard collection items", async () => {
    const { doc } = await scan();
    const schema = doc.paths["/api/foos/wild"].get.responses["200"].content["application/json"].schema;
    expect(schema.$ref).toContain("FooRespList");
    const envelope = doc.components.schemas[schema.$ref.split("/").pop()];
    expect(envelope.properties.data.items).toEqual({
      $ref: "#/components/schemas/FooResp",
    });
  });

  it("synthesizes Spring Data Page components", async () => {
    const { doc } = await scan();
    const schema = doc.paths["/api/foos/page"].get.responses["200"].content["application/json"].schema;
    expect(schema.$ref).toBe("#/components/schemas/CommonResult_Page_FooResp");
    const page = doc.components.schemas.Page_FooResp;
    expect(page.properties.content.items).toEqual({
      $ref: "#/components/schemas/FooResp",
    });
    expect(page.properties.totalElements).toBeDefined();
    expect(page.properties.totalPages).toBeDefined();
  });

  it("unwraps CompletableFuture envelopes", async () => {
    const { doc } = await scan();
    const schema = doc.paths["/api/foos/async"].get.responses["200"].content["application/json"].schema;
    expect(schema).toEqual({ $ref: "#/components/schemas/CommonResult_FooResp" });
  });

  it("unwraps ResponseEntity payloads", async () => {
    const { doc } = await scan();
    const schema = doc.paths["/api/bars/{id}"].get.responses["200"].content["application/json"].schema;
    expect(schema).toEqual({ $ref: "#/components/schemas/BarResp" });
  });

  it("derives interface DTO properties from getters", async () => {
    const { doc } = await scan();
    const account = doc.components.schemas.AccountView;
    expect(account.properties.accountId).toEqual({ type: "integer", format: "int64" });
    expect(account.properties.displayName).toEqual({ type: "string" });
    expect(account.properties.active).toEqual({ type: "boolean" });
  });

  it("indexes record DTOs and request bodies", async () => {
    const { doc } = await scan();
    const widget = doc.components.schemas.WidgetRecord;
    expect(widget.properties.widgetId).toEqual({ type: "string" });
    expect(widget.properties.quantity).toEqual({ type: "integer", format: "int32" });
    const body = doc.paths["/api/widgets"].post.requestBody.content["application/json"].schema;
    expect(body).toEqual({ $ref: "#/components/schemas/WidgetRecord" });
  });

  it("renders dynamic JSON fields as free-form objects and arrays", async () => {
    const { doc } = await scan();
    const dynamic = doc.components.schemas.DynamicResp;
    expect(dynamic.properties.info).toEqual({ type: "object" });
    expect(dynamic.properties.config).toEqual({ type: "object" });
    expect(dynamic.properties.settings).toEqual({ type: "object" });
    expect(dynamic.properties.headers).toEqual({ type: "array", items: { type: "object" } });
    expect(dynamic.properties.tags).toEqual({ type: "array", items: { type: "object" } });
  });

  it("keeps same-named envelopes in different packages as distinct components", async () => {
    const { doc } = await scan();
    const wsSchema = doc.paths["/ws/foo"].get.responses["200"].content["application/json"].schema;
    const wsName = wsSchema.$ref.split("/").pop();
    expect(wsName).not.toBe("CommonResult_FooResp");
    const wsEnvelope = doc.components.schemas[wsName];
    expect(Object.keys(wsEnvelope.properties).sort()).toEqual(["code", "data", "message"]);
    expect(wsEnvelope.properties.data).toEqual({ $ref: "#/components/schemas/FooResp" });

    const mainEnvelope = doc.components.schemas.CommonResult_FooResp;
    expect(Object.keys(mainEnvelope.properties).sort()).toEqual(["code", "data", "msg", "time"]);
  });
});
