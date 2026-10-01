import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "spring-generic");

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

function component(converted: any, name: string) {
  const schema = converted.document.components?.schemas?.[name];
  expect(schema, `component ${name}`).toBeDefined();
  return schema;
}

describe("spring generic response wrappers", () => {
  it("substitutes generic type arguments and inherited fields", async () => {
    const { result, converted } = await scan();
    expect(converted.ok).toBe(true);
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    const compare = op(ops, "get", "/generic/compare");
    expect(compare.responses[0].content[0].schema).toEqual({
      $ref: "#/components/schemas/CommonResult_CompareResp",
    });

    const wrapper = component(converted, "CommonResult_CompareResp");
    expect(Object.keys(wrapper.properties).sort()).toEqual(["code", "data", "msg", "time"]);
    expect(wrapper.properties.data).toEqual({ $ref: "#/components/schemas/CompareResp" });
    expect(wrapper.properties.code).toEqual({ type: "integer" });
    expect(wrapper.properties.time).toEqual({ type: "string", format: "date-time" });

    // Snake-case naming strategy, nested DTOs and @JsonIgnore handling.
    const dto = component(converted, "CompareResp");
    expect(Object.keys(dto.properties).sort()).toEqual([
      "add",
      "change_history",
      "standard_history",
    ]);
    expect(dto.properties.add).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/CompareApiResp" },
    });
    const version = component(converted, "VersionResp");
    expect(version.properties).toMatchObject({
      version_id: { type: "string" },
      created_at: { type: "integer", format: "int64" },
    });
  });

  it("resolves nested generics through generic superclasses", async () => {
    const { result, converted } = await scan();
    const ops = result.project.operations;

    // CommonResult<PageResp<List<FooPO>>>; PageResp extends CommonDataResp<T>.
    const page = op(ops, "get", "/generic/page");
    expect(page.responses[0].content[0].schema).toEqual({
      $ref: "#/components/schemas/CommonResult_PageResp_FooPOList",
    });
    const pageSpec = component(converted, "PageResp_FooPOList");
    expect(pageSpec.properties.list).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/FooPO" },
    });
    // @JsonProperty overrides win over the snake-case strategy.
    expect(pageSpec.properties.per_page).toEqual({ type: "integer", format: "int32" });
    expect(pageSpec.properties.page).toEqual({ type: "integer", format: "int32" });
    expect(pageSpec.properties.total).toEqual({ type: "integer", format: "int32" });

    // CommonResult<List<FooPO>> inlines the collection in the data field.
    const list = op(ops, "get", "/generic/list");
    expect(list.responses[0].content[0].schema).toEqual({
      $ref: "#/components/schemas/CommonResult_FooPOList",
    });
    const listWrapper = component(converted, "CommonResult_FooPOList");
    expect(listWrapper.properties.data).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/FooPO" },
    });

    // CommonResult<CommonListResult<List<FooPO>>> nests specializations.
    const details = op(ops, "post", "/generic/details");
    expect(details.responses[0].content[0].schema).toEqual({
      $ref: "#/components/schemas/CommonResult_CommonListResult_FooPOList",
    });
    const inner = component(converted, "CommonListResult_FooPOList");
    expect(inner.properties.list).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/FooPO" },
    });
  });

  it("keeps raw non-generic wrappers with inherited fields", async () => {
    const { result, converted } = await scan();
    const ops = result.project.operations;

    const ping = op(ops, "post", "/generic/ping");
    expect(ping.responses[0].content[0].schema).toEqual({
      $ref: "#/components/schemas/BaseResult",
    });
    const base = component(converted, "BaseResult");
    expect(Object.keys(base.properties).sort()).toEqual(["code", "msg", "time"]);
  });

  it("emits a discriminated oneOf for Jackson polymorphic responses", async () => {
    const { result, converted } = await scan();
    const ops = result.project.operations;

    const events = op(ops, "get", "/generic/events");
    expect(events.responses[0].content[0].schema).toEqual({
      $ref: "#/components/schemas/CommonResult_EventRespList",
    });

    // The list item type is the polymorphic base.
    const wrapper = component(converted, "CommonResult_EventRespList");
    expect(wrapper.properties.data.items).toEqual({
      $ref: "#/components/schemas/EventResp",
    });

    const base = component(converted, "EventResp");
    expect(base.oneOf).toEqual([
      { $ref: "#/components/schemas/EmailEventResp" },
      { $ref: "#/components/schemas/SmsEventResp" },
    ]);
    expect(base.discriminator).toEqual({
      propertyName: "kind",
      mapping: {
        email: "#/components/schemas/EmailEventResp",
        sms: "#/components/schemas/SmsEventResp",
      },
    });

    // Subtype components keep inherited base fields and their own fields.
    const email = component(converted, "EmailEventResp");
    expect(email.properties.event_id).toEqual({ type: "string" });
    expect(email.properties.subject).toEqual({ type: "string" });
    const sms = component(converted, "SmsEventResp");
    expect(sms.properties.phone_number).toEqual({ type: "string" });
  });
});
