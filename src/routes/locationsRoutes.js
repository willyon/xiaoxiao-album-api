/*
 * @Description: 地点路由
 */
const express = require("express");
const router = express.Router();
const { getLocations } = require("../controllers/locationsController");

router.get("/", getLocations);

module.exports = router;
