// Root-level autoloaded file: no directory prefix is applied.
module.exports = async function healthRoutes(server) {
  server.get("/health", async () => ({ status: "ok" }));
};
