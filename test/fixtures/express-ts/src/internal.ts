import { Router, type Request, type Response } from "express";

// This router is intentionally never mounted on a listening app.
const internal = Router();

internal.get("/secret", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

export default internal;
