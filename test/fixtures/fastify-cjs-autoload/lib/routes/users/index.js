const fp = require("fastify-plugin");
const schema = require("./schema");

async function users(server, options) {
  const prefix = options.prefix || "";

  server.route({
    method: "POST",
    path: prefix + "users",
    schema: schema.register,
    handler: registerUser,
  });

  server.route({
    method: "POST",
    path: `${prefix}users/login`,
    schema: schema.login,
    handler: onLogin,
  });

  server.get(prefix + "profiles/:username", { schema: schema.get }, getProfile);

  async function registerUser(request, reply) {
    return reply.code(201).send({ user: { token: "jwt", username: request.body.username } });
  }

  async function onLogin(request, reply) {
    const existing = await server.db.users.findByEmail(request.body.email);
    if (existing) {
      return reply.code(409).send({ message: "Email already registered" });
    }
    return { user: { token: "jwt", email: request.body.email } };
  }

  async function getProfile(request) {
    return {
      profile: {
        username: request.params.username,
        bio: null,
        following: false,
      },
    };
  }
}

module.exports = fp(users);
