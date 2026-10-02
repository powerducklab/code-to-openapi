const express = require("express");
const app = express();

app.get("/page", (req, res) => {
  res.render("index", { user: req.user });
});

app.get("/old", (req, res) => {
  res.redirect("/page");
});

app.get("/users/:id", (req, res) => {
  res.json({ id: req.params.id });
});

app.listen(3000);
module.exports = app;
