const S = require("fluent-json-schema");

// Mixes a fluent querystring with a native JSON Schema response that uses
// combinators, a local definitions table and $ref.
const meta = {
  querystring: S.object().prop(
    "kind",
    S.string().enum(["a", "b"]).required(),
  ),
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      definitions: {
        Tag: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "integer" } },
          },
        },
        either: {
          oneOf: [{ type: "string" }, { type: "integer" }],
        },
        tag: { $ref: "#/definitions/Tag" },
      },
    },
  },
};

module.exports = { meta };
