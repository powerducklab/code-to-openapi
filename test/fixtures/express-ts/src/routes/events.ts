import { Router, type Request, type Response } from "express";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.write("event: tick\ndata: {}\n\n");
  res.write("event: done\ndata: {}\n\n");
});

export default router;
