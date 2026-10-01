import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { User, UserDetail, Order, ErrorBody } from "../types.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().int().optional(),
});

type CreateUserBody = z.infer<typeof createUserSchema>;

router.get("/", (_req: Request, res: Response<User[]>) => {
  res.json([]);
});

router.get(
  "/:id",
  requireAuth,
  (req: Request<{ id: string }>, res: Response<UserDetail | ErrorBody>) => {
    const id = req.params.id;
    if (!id) {
      res.status(404).json({ message: "not found" });
      return;
    }
    res.json({ id, name: "Ada", email: "ada@example.com", createdAt: "2026-01-01" });
  },
);

router.post(
  "/",
  (req: Request<Record<string, string>, User, CreateUserBody>, res: Response<User>) => {
    const parsed = createUserSchema.parse(req.body);
    res.status(201).json({ id: "1", name: parsed.name, email: parsed.email });
  },
);

router.get(
  "/:id/orders",
  (
    req: Request<{ id: string }, Order[], unknown, { status?: string; limit?: number }>,
    res: Response<Order[]>,
  ) => {
    const status = req.query.status;
    const limit = req.query.limit;
    res.json([{ id: "o1", total: 12.5 }]);
  },
);

export default router;
