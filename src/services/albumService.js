/*
 * @Author: zhangshouchang
 * @Date: 2025-01-XX
 * @Description: 相册业务逻辑服务
 */
const albumModel = require("../models/albumModel");
const mediaModel = require("../models/mediaModel");
const storageService = require("../services/storageService");
const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");
const logger = require("../utils/logger");

/**
 * 获取最近使用的相册列表（前 limit 个，按 max(created_at, last_used_at) 倒序，含封面 URL）
 * excludeAlbumId 可选，排除该相册（如当前相册）；返回 total 为排除后的相册总数，用于前端判断是否显示「选择其他相册」
 */
async function getRecentAlbumsList({ userId, limit = 8, excludeAlbumId = null }) {
  const albums = albumModel.getRecentAlbumsByUserId({ userId, limit, excludeAlbumId });
  const total = albumModel.getAlbumsCountByUserId({ userId, excludeAlbumId });

  const albumsWithCover = await Promise.all(
    albums.map(async (album) => {
      let coverImageUrl = null;
      if (album.coverImageId) {
        const coverImage = await _getMediaById(album.coverImageId);
        if (coverImage && coverImage.thumbnailStorageKey) {
          coverImageUrl = await storageService.getFileUrl(coverImage.thumbnailStorageKey);
        }
      }
      const timeRange = albumModel.getAlbumTimeRange(album.albumId);
      return {
        ...album,
        coverImageUrl,
        timeRange: timeRange || undefined,
      };
    }),
  );

  return { list: albumsWithCover, total };
}

/**
 * 获取用户的自定义相册列表（包含封面图片URL）
 * excludeAlbumId 可选，排除该相册（如当前相册）
 */
async function getAlbumsList({ userId, pageNo = 1, pageSize = 20, search = null, excludeAlbumId = null }) {
  const allAlbums = albumModel.getAlbumsByUserId({ userId, search, excludeAlbumId });

  // 分页处理
  const total = allAlbums.length;
  const offset = (pageNo - 1) * pageSize;
  const albums = allAlbums.slice(offset, offset + pageSize);

  // 按需更新封面：如果相册有图片但没有封面，自动更新封面
  albums.forEach((album) => {
    if (!album.coverImageId && album.imageCount > 0) {
      // 封面为空但相册有图片，更新封面为最新添加的图片
      albumModel.updateAlbumCover(album.albumId);
      // 获取更新后的封面ID
      album.coverImageId = albumModel.getAlbumCoverMediaId(album.albumId);
    }
  });

  // 为每个相册添加封面图片URL与整本相册时间范围
  const albumsWithCover = await Promise.all(
    albums.map(async (album) => {
      let coverImageUrl = null;

      if (album.coverImageId) {
        // 查询封面图片的存储信息
        const coverImage = await _getMediaById(album.coverImageId);
        if (coverImage && coverImage.thumbnailStorageKey) {
          coverImageUrl = await storageService.getFileUrl(coverImage.thumbnailStorageKey);
        }
      }

      const timeRange = albumModel.getAlbumTimeRange(album.albumId);

      return {
        ...album,
        coverImageUrl,
        timeRange: timeRange || undefined,
      };
    }),
  );

  return {
    list: albumsWithCover,
    total,
  };
}

/**
 * 创建相册
 */
async function createAlbum({ userId, name, description }) {
  // 验证相册名称
  if (!name || name.trim().length === 0) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
      message: "相册名称不能为空",
    });
  }

  if (name.length > 50) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
      message: "相册名称不能超过50个字符",
    });
  }

  // 检查相册名称是否已存在
  const existingAlbums = albumModel.getAlbumsByUserId({ userId });
  const nameExists = existingAlbums.some((album) => album.name === name.trim());

  if (nameExists) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.DUPLICATE_ENTRY,
      messageType: "warning",
      message: "相册名称已存在",
    });
  }

  const result = albumModel.createAlbum({
    userId,
    name: name.trim(),
    description: description?.trim() || null,
  });

  return albumModel.getAlbumById({
    albumId: result.albumId,
    userId,
  });
}

/**
 * 更新相册
 */
async function updateAlbum({ userId, albumId, name, description, coverImageId }) {
  // 验证相册存在且属于当前用户
  const album = albumModel.getAlbumById({ albumId, userId });
  if (!album) {
    throw new CustomError({
      httpStatus: 404,
      messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
      messageType: "error",
      message: "相册不存在",
    });
  }

  // 如果更新名称，检查名称是否已存在
  if (name !== undefined && name !== album.name) {
    if (!name || name.trim().length === 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "warning",
        message: "相册名称不能为空",
      });
    }

    if (name.length > 50) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "warning",
        message: "相册名称不能超过50个字符",
      });
    }

    const existingAlbums = albumModel.getAlbumsByUserId({ userId });
    const nameExists = existingAlbums.some((a) => a.albumId !== albumId && a.name === name.trim());

    if (nameExists) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.DUPLICATE_ENTRY,
        messageType: "warning",
        message: "相册名称已存在",
      });
    }
  }

  // 如果设置封面，验证图片是否在相册中
  if (coverImageId !== undefined) {
    const isInAlbum = albumModel.isMediaInAlbum({ albumId, mediaId: coverImageId });
    if (!isInAlbum) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "warning",
        message: "封面图片必须属于该相册",
      });
    }
  }

  const result = albumModel.updateAlbum({
    albumId,
    userId,
    name: name?.trim(),
    description: description?.trim(),
    coverImageId,
  });

  if (result.affectedRows === 0) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.DATA_UPDATE_FAILED,
      messageType: "error",
    });
  }

  // 返回更新后的相册信息（包含封面图片URL）
  const updatedAlbum = albumModel.getAlbumById({ albumId, userId });
  let coverImageUrl = null;
  if (updatedAlbum.coverImageId) {
    const coverImage = _getMediaById(updatedAlbum.coverImageId);
    if (coverImage) {
      coverImageUrl = await storageService.getFileUrl(coverImage.thumbnailStorageKey);
    }
  }

  return {
    ...updatedAlbum,
    coverImageUrl,
  };
}

/**
 * 删除相册
 */
async function deleteAlbum({ userId, albumId }) {
  // 验证相册存在且属于当前用户
  const album = albumModel.getAlbumById({ albumId, userId });
  if (!album) {
    throw new CustomError({
      httpStatus: 404,
      messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
      messageType: "error",
      message: "相册不存在",
    });
  }

  const result = albumModel.deleteAlbum({ albumId, userId });

  if (result.affectedRows === 0) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.DATA_DELETE_FAILED,
      messageType: "error",
    });
  }

  return { success: true };
}

/**
 * 添加图片到相册
 */
async function addMediasToAlbum({ userId, albumId, mediaIds }) {
  // 验证相册存在且属于当前用户
  const album = albumModel.getAlbumById({ albumId, userId });
  if (!album) {
    throw new CustomError({
      httpStatus: 404,
      messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
      messageType: "error",
      message: "相册不存在",
    });
  }

  // 验证图片存在且属于当前用户
  // TODO: 添加图片验证逻辑（可以调用 mediaModel 检查）

  const result = albumModel.addMediasToAlbum({ albumId, mediaIds, userId });

  return result;
}

/**
 * 从相册中移除图片
 */
async function removeMediasFromAlbum({ userId, albumId, mediaIds }) {
  // 验证相册存在且属于当前用户
  const album = albumModel.getAlbumById({ albumId, userId });
  if (!album) {
    throw new CustomError({
      httpStatus: 404,
      messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
      messageType: "error",
      message: "相册不存在",
    });
  }

  const result = albumModel.removeMediasFromAlbum({ albumId, mediaIds, userId });

  return result;
}

/**
 * 设置相册封面图片
 */
async function setAlbumCover({ userId, albumId, mediaId }) {
  // 验证相册存在且属于当前用户
  const album = albumModel.getAlbumById({ albumId, userId });
  if (!album) {
    throw new CustomError({
      httpStatus: 404,
      messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
      messageType: "error",
      message: "相册不存在",
    });
  }

  // 验证图片是否在相册中（model 层仍用 imageId 字段名，与 media 主键 id 一致）
  const isInAlbum = albumModel.isMediaInAlbum({ albumId, mediaId });
  if (!isInAlbum) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
      message: "封面图片必须属于该相册",
    });
  }

  const result = albumModel.setAlbumCover({ albumId, mediaId });

  if (result.affectedRows === 0) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.DATA_UPDATE_FAILED,
      messageType: "error",
    });
  }

  // 获取更新后的相册信息
  const updatedAlbum = albumModel.getAlbumById({ albumId, userId });
  let coverImageUrl = null;

  if (updatedAlbum.coverImageId) {
    const coverImage = await _getMediaById(updatedAlbum.coverImageId);
    if (coverImage && coverImage.thumbnailStorageKey) {
      coverImageUrl = await storageService.getFileUrl(coverImage.thumbnailStorageKey);
    }
  }

  return {
    albumId: updatedAlbum.albumId,
    coverImageId: updatedAlbum.coverImageId,
    coverImageUrl,
  };
}

/**
 * 恢复相册默认封面：与「添加/移除媒体后」一致，取相册内最近加入的一张图片或视频（见 albumModel.updateAlbumCover）
 */
async function restoreAlbumCover({ userId, albumId }) {
  const album = albumModel.getAlbumById({ albumId, userId });
  if (!album) {
    throw new CustomError({
      httpStatus: 404,
      messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
      messageType: "error",
      message: "相册不存在",
    });
  }

  albumModel.updateAlbumCover(albumId);

  const updatedAlbum = albumModel.getAlbumById({ albumId, userId });
  let coverImageUrl = null;
  if (updatedAlbum.coverImageId) {
    const coverImage = await _getMediaById(updatedAlbum.coverImageId);
    if (coverImage && coverImage.thumbnailStorageKey) {
      coverImageUrl = await storageService.getFileUrl(coverImage.thumbnailStorageKey);
    }
  }

  return {
    albumId: updatedAlbum.albumId,
    coverImageId: updatedAlbum.coverImageId,
    coverImageUrl,
  };
}

/**
 * 获取相册详情（包含封面图片URL）
 */
async function getAlbumById({ userId, albumId }) {
  const album = albumModel.getAlbumById({ albumId, userId });
  if (!album) {
    return null;
  }

  // 添加封面图片URL与整本相册时间范围
  let coverImageUrl = null;
  if (album.coverImageId) {
    const coverImage = _getMediaById(album.coverImageId);
    if (coverImage && coverImage.thumbnailStorageKey) {
      coverImageUrl = await storageService.getFileUrl(coverImage.thumbnailStorageKey);
    }
  }

  const timeRange = albumModel.getAlbumTimeRange(albumId);

  return {
    ...album,
    coverImageUrl,
    timeRange: timeRange || undefined,
  };
}

/**
 * 获取相册中的图片列表（包含完整URL）
 */
async function getAlbumMediasList({ userId, albumId, pageNo, pageSize }) {
  // 验证相册存在且属于当前用户
  const album = albumModel.getAlbumById({ albumId, userId });
  if (!album) {
    throw new CustomError({
      httpStatus: 404,
      messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
      messageType: "error",
      message: "相册不存在",
    });
  }

  const queryResult = albumModel.getAlbumMedias({
    albumId,
    pageNo,
    pageSize,
  });

  // 为图片添加完整URL（isFavorite字段已从数据库直接返回）
  const imagesWithUrl = await Promise.all(
    queryResult.data.map(async (image) => {
      let thumbnailUrl = null;
      let highResUrl = null;
      let originalUrl = null;
      if (image.thumbnailStorageKey) {
        thumbnailUrl = await storageService.getFileUrl(image.thumbnailStorageKey);
      }
      if (image.highResStorageKey) {
        highResUrl = await storageService.getFileUrl(image.highResStorageKey);
      }
      if (image.mediaType === "video" && image.originalStorageKey) {
        originalUrl = await storageService.getFileUrl(image.originalStorageKey);
      } else if (!image.highResStorageKey && image.originalStorageKey) {
        originalUrl = await storageService.getFileUrl(image.originalStorageKey);
      }

      return {
        ...image,
        albumId, // 添加 albumId 字段，统一返回格式
        thumbnailUrl,
        highResUrl,
        originalUrl,
      };
    }),
  );

  return {
    list: imagesWithUrl,
    total: queryResult.total,
  };
}

/**
 * 内部方法：根据ID获取图片存储信息
 */
function _getMediaById(imageId) {
  const image = mediaModel.getMediaStorageInfo(imageId);
  return image
    ? {
        thumbnailStorageKey: image.thumbnailStorageKey,
        highResStorageKey: image.highResStorageKey,
      }
    : null;
}

module.exports = {
  getAlbumsList,
  getRecentAlbumsList,
  createAlbum,
  getAlbumById,
  updateAlbum,
  deleteAlbum,
  addMediasToAlbum,
  removeMediasFromAlbum,
  getAlbumMediasList,
  setAlbumCover,
  restoreAlbumCover,
};
