module.exports = {
  list: function (req, res) {
    res.json({ users: [] });
  },
  create: function (req, res) {
    res.status(201).json({ id: 1, name: req.body.name });
  },
};
