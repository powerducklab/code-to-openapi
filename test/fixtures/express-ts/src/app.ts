import express from "express";
import users from "./routes/users.js";
import events from "./routes/events.js";

const app = express();

app.use(express.json());
app.use("/api/users", users);
app.use("/events", events);

app.get("/health", (_req, res) => {
  res.send("ok");
});

app.listen(3000);

export default app;
