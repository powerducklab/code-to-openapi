import express, { Router } from "express";

import { login, listUsers } from "./controllers/index.js";

const app = express();
const api = Router();

// Handlers are imported from a barrel that re-exports them via `export *`.
api.post("/login", login);
api.get("/users", listUsers);

app.use("/api", api);

export default app;
