import express from "express";

const app = express();
const router = express.Router();

router.get("/items/:itemId", (req, res) => {
  const itemId = req.params.itemId;
  const q = req.query.q;
  const tenant = req.headers["x-tenant"];
  res.json({ id: itemId, q, tenant });
});

router.post("/items", (req, res) => {
  const { name, price } = req.body;
  res.status(201).json({ id: "x", name, price });
});

app.use("/v1", router);
app.listen(4000);
