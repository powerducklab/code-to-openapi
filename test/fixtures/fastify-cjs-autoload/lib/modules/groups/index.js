// Plain plugin (not wrapped in fastify-plugin) with default
// dirNameRoutePrefix: the directory name becomes the route prefix.
module.exports = async function groupsRoutes(server) {
  server.get("/gping", async () => ({ group: "pong" }));
};
