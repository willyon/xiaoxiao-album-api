const express = require("express");
const router = express.Router();
const { handleGetSummary, handleGetGroups } = require("../controllers/cleanupController");

router.get("/summary", handleGetSummary);
router.get("/groups", handleGetGroups);

module.exports = router;
