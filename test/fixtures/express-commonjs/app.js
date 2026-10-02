const express = require("express");
const app = express();
const userRoutes = require("./routes/user");

app.use("/users", userRoutes);
app.get("/", function (req, res) {
  res.json({ ok: true });
});

app.listen(3000);
