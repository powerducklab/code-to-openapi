import express from "express";
import "./respond.js";

const app = express();

// 1. Local object literal handed to res.json.
app.get("/hello", (req, res) => {
  const payload = { message: "hi", count: 3 };
  res.json(payload);
});

// 2. Merge of req.body locals + literal.
app.post("/echo", (req, res) => {
  const text = req.body.text;
  res.json({ received: text, echoed: true });
});

// 3. Ternary of literals.
app.get("/flag", (req, res) => {
  const out = req.query.on ? { state: "on" } : { state: "off" };
  res.json(out);
});

// 4. Custom response method expanded across files.
app.get("/custom", (req, res) => {
  res.ok(200, "done", { id: 7, name: "Ada" });
});

app.listen(3000);
