const router = require("express").Router();
const ctrl = require("../controllers/user");

router.get("/", ctrl.list);
router.post("/", ctrl.create);
router.get("/:id", ctrl.getOne);

module.exports = router;
