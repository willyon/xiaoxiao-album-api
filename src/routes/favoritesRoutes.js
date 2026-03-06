/*
 * @Description: 收藏（喜欢）路由
 */
const express = require("express");
const router = express.Router();
const { addToFavorites, removeFromFavorites } = require("../controllers/favoritesController");

router.post("/media", addToFavorites);
router.delete("/media", removeFromFavorites);

module.exports = router;
