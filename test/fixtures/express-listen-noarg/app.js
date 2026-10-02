const express = require("express");
const app = express();

app.get("/", function (req, res) {
  res.json({ ok: true });
});

// `app.listen()` with NO argument must not crash the scanner: the pack must
// guard arguments[0] before testing whether it is a numeric literal.
app.listen();
