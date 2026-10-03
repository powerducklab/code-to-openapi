const fp = require("fastify-plugin");
const schema = require("./schema");

async function meta(server, options) {
  server.route({
    method: "GET",
    url: options.prefix + "meta",
    schema: schema.meta,
    handler: async () => ({ items: [], either: "ok", tag: { name: "x" } }),
  });
}

module.exports = fp(meta);
