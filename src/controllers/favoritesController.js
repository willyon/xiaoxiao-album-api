/*
 * @Description: 收藏（喜欢）接口控制器
 */
const albumService = require("../services/albumService");

/**
 * 分页获取喜欢图片列表（响应含 album 元数据，供 AddToAlbumDialog 等使用）
 * GET /api/favorites?pageNo=1&pageSize=20
 */
async function getFavorites(req, res, next) {
  try {
    const userId = req.user.userId;
    const { pageNo = 1, pageSize = 20 } = req.query;

    const result = await albumService.getFavoritesList({
      userId,
      pageNo: parseInt(pageNo, 10) || 1,
      pageSize: parseInt(pageSize, 10) || 20,
    });

    res.sendResponse({ data: result });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getFavorites,
};
