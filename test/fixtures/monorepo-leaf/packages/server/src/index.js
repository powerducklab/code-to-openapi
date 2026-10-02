import express from "express";

const app = express();

app.get("/hello", (req, res) => res.json({ message: "hi" }));
app.post("/items", (req, res) => res.json({ created: true }));

app.listen(3000);
