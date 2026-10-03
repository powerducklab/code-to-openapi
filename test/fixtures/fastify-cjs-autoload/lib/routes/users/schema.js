const S = require("fluent-json-schema");

const login = {
  body: S.object()
    .prop("email", S.string().format("email").required())
    .prop("password", S.string().minLength(8).required()),
  response: {
    200: S.object().prop(
      "user",
      S.object()
        .prop("token", S.string().required())
        .prop("email", S.string().format("email")),
    ),
    409: S.object().prop("message", S.string()),
  },
};

const register = {
  body: S.object()
    .prop("username", S.string().minLength(3).required())
    .prop("email", S.string().format("email").required())
    .prop("password", S.string().minLength(8).required()),
  response: {
    201: S.object().prop(
      "user",
      S.object().prop("token", S.string()).prop("username", S.string()),
    ),
  },
};

const getProfile = {
  params: S.object().prop("username", S.string().required()),
  response: {
    200: S.object().prop(
      "profile",
      S.object()
        .prop("username", S.string())
        .prop("bio", S.string())
        .prop("following", S.boolean()),
    ),
  },
};

module.exports = {
  login,
  register,
  get: getProfile,
};
