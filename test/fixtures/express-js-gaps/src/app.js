import express from "express";

const app = express();
app.use(express.json());

app.post("/collect", (req, res) => {
  const payload = req.body;
  const token = req.headers["x-token"];
  res.status(202).json({ received: payload, token });
});

app.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  const chunk = "event: ping\ndata: " + JSON.stringify({ at: Date.now() }) + "\n\n";
  res.write(chunk);
  res.end();
});

app.listen(4100);
