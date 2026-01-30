/*
 * @Description: 收藏（喜欢）路由
 */
const express = require("express");
const router = express.Router();
const { getFavorites } = require("../controllers/favoritesController");

router.get("/", getFavorites);

module.exports = router;
