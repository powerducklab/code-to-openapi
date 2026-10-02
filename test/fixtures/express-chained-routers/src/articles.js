import { Router } from "express";

const router = Router();

router.get("/articles", (req, res) => res.json({ articles: [] }));
router.get("/articles/:slug", (req, res) => res.json({ slug: req.params.slug }));
router.post("/articles", (req, res) => res.json({ created: true }));

export default router;
