/*
 * @Description: 收藏（喜欢）路由
 */
const express = require("express");
const router = express.Router();
const { getFavorites, addToFavorites, removeFromFavorites } = require("../controllers/favoritesController");

router.get("/", getFavorites);
router.post("/images", addToFavorites);
router.delete("/images", removeFromFavorites);

module.exports = router;
