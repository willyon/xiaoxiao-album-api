/*
 * @Description: 收藏（喜欢）路由
 */
const express = require("express");
const router = express.Router();
const { addToFavorites, removeFromFavorites } = require("../controllers/favoritesController");

router.post("/images", addToFavorites);
router.delete("/images", removeFromFavorites);

module.exports = router;
