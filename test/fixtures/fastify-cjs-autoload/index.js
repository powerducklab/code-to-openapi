const path = require("node:path");
const fastify = require("fastify");
const startServer = require("./lib/server");

const config = { prefix: process.env.API_PREFIX || "/api" };
const server = fastify({ logger: false });

server.register(startServer, config);

server.listen({ port: 3000 });

module.exports = server;
