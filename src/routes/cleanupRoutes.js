const express = require("express");
const router = express.Router();
const { handleGetGroups } = require("../controllers/cleanupController");

router.get("/groups", handleGetGroups);

module.exports = router;
