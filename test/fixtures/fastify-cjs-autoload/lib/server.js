const path = require("node:path");
const fp = require("fastify-plugin");
const autoload = require("@fastify/autoload");

// Mirrors the fastify realworld layout: fastify-plugin wrapping disables
// encapsulation, dirNameRoutePrefix is off, and each route module composes
// its mount path from the runtime `options.prefix`.
async function plugin(server, options) {
  await server.register(autoload, {
    dir: path.join(__dirname, "routes"),
    options,
    dirNameRoutePrefix: false,
  });

  // A second autoload keeps the default dirNameRoutePrefix behavior and
  // registers plain (non fastify-plugin) modules so directory names become
  // route prefixes.
  await server.register(autoload, {
    dir: path.join(__dirname, "modules"),
  });
}

module.exports = fp(plugin);
