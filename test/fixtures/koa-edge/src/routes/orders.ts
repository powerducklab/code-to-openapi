import Router from "koa-router";
import type { Order } from "../types.js";

const router = new Router();
router.prefix("/orders");

// GET /orders/:id
router.get("/:id", (ctx) => {
  const order: Order = { id: ctx.params.id, total: 9.9 };
  ctx.body = order;
});

export default router;
