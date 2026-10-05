import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

// Synthetic, framework-generic controller fixture (not a pinned third-party
// project). It locks the branch-level ControllerBase result classification,
// the [ApiController] automatic 400, the ASP.NET Core 9 bodiless-error
// ProblemDetails behavior, DTO projection (no field leakage), value-type
// request optionality, and the rule that [HttpGet(Name = ...)] is not a route
// template.
const root = join(__dirname, "fixtures", "aspnet-controller-branches");

async function document() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert({ validate: true });
  expect(converted.documentValid).toBe(true);
  return converted.document as any;
}

function resolveRef(doc: any, schema: any): any {
  if (schema && schema.$ref) {
    const key = schema.$ref.split("/").pop();
    return doc.components.schemas[key];
  }
  return schema;
}

describe("asp.net controller branch result classification", () => {
  it("classifies every ControllerBase result branch and keeps the DTO projection leak-free", async () => {
    const doc = await document();

    // [controller] token -> Widgets; every verb is recalled.
    expect(doc.paths["/api/Widgets"]).toBeDefined();
    expect(doc.paths["/api/Widgets/{id}"]).toBeDefined();
    const list = doc.paths["/api/Widgets"].get;
    const one = doc.paths["/api/Widgets/{id}"].get;
    const create = doc.paths["/api/Widgets"].post;
    const update = doc.paths["/api/Widgets/{id}"].put;
    const remove = doc.paths["/api/Widgets/{id}"].delete;
    [list, one, create, update, remove].forEach((o, i) => expect(o, `op ${i}`).toBeDefined());

    // [HttpGet(Name = "GetWeather")] must not append the route name to the path.
    expect(doc.paths["/Weather"]).toBeDefined();
    expect(doc.paths["/Weather/GetWeather"]).toBeUndefined();

    // GET list -> 200 array of the projected DTO.
    const listItems = resolveRef(doc, list.responses["200"].content["application/json"].schema.items);
    expect(Object.keys(listItems.properties).sort()).toEqual(["id", "name"]);
    expect(listItems.properties.secret).toBeUndefined();

    // GET {id} -> 200 DTO, 404 (ProblemDetails on net9), 400 binding failure.
    expect(Object.keys(one.responses).sort()).toEqual(["200", "400", "404"]);
    const oneDto = resolveRef(doc, one.responses["200"].content["application/json"].schema);
    expect(oneDto.properties.secret).toBeUndefined();
    expect(oneDto.properties.id.format).toBe("int64");
    expect(one.responses["404"].content["application/problem+json"]).toBeDefined();
    expect(one.responses["400"].content["application/problem+json"]).toBeDefined();

    // POST -> 201 CreatedAtAction DTO + automatic [ApiController] 400.
    expect(Object.keys(create.responses).sort()).toEqual(["201", "400"]);
    const created = resolveRef(doc, create.responses["201"].content["application/json"].schema);
    expect(created.properties.secret).toBeUndefined();
    expect(create.responses["400"].content["application/problem+json"].schema.properties.errors).toBeDefined();

    // PUT -> explicit BadRequest (400), NotFound (404), NoContent (204, empty); no 200.
    expect(Object.keys(update.responses).sort()).toEqual(["204", "400", "404"]);
    expect(update.responses["204"].content).toBeUndefined();
    expect(update.responses["404"].content["application/problem+json"]).toBeDefined();
    expect(update.responses["400"].content["application/problem+json"]).toBeDefined();

    // DELETE -> NotFound (404), binding 400, NoContent (204 empty).
    expect(Object.keys(remove.responses).sort()).toEqual(["204", "400", "404"]);
    expect(remove.responses["204"].content).toBeUndefined();
    expect(remove.responses["404"].content["application/problem+json"]).toBeDefined();
  });

  it("does not require value-type request members but keeps serialized keys required", async () => {
    const doc = await document();
    const schemas = doc.components.schemas;

    // Request DTO: long id / bool-less DTO here bind to defaults when omitted,
    // so no member is implicitly required.
    const requestDto = schemas["WidgetDto"];
    expect(requestDto).toBeDefined();
    expect(requestDto.required).toBeUndefined();
    expect(requestDto.properties.secret).toBeUndefined();

    // Serialized DTO: camelCase keys are always written (nulls are not ignored),
    // so the nullable name key stays required alongside id.
    const wireDto = schemas["serialized_WidgetDto"];
    expect(wireDto).toBeDefined();
    expect(wireDto.required.slice().sort()).toEqual(["id", "name"]);
    expect(wireDto.properties.name.type).toContain("null");

    // The request body itself is still required on POST/PUT.
    const create = doc.paths["/api/Widgets"].post;
    expect(create.requestBody.required).toBe(true);
  });

  it("serializes DateOnly as date and includes read-only computed properties", async () => {
    const doc = await document();
    const forecast = doc.components.schemas["serialized_Forecast"];
    expect(forecast).toBeDefined();
    expect(forecast.properties.date.type).toBe("string");
    expect(forecast.properties.date.format).toBe("date");
    // TemperatureF is a get-only computed property and still appears on the wire.
    expect(forecast.properties.temperatureF.type).toBe("integer");
    expect(forecast.properties.temperatureF.format).toBe("int32");
    expect(forecast.required).toContain("temperatureF");

    const weather = doc.paths["/Weather"].get;
    const items = resolveRef(doc, weather.responses["200"].content["application/json"].schema.items);
    expect(items.properties.summary.type).toContain("null");
  });
});
