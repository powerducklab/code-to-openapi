// Monkey-patched Express Response method (mirrors real-world boilerplates).
import { response } from "express";

response.ok = function (httpStatusCode, message, data = null) {
  return this.status(httpStatusCode).json({ message, data });
};
