/*
 * @Author: zhangshouchang
 * @Date: 2025-01-XX
 * @Description: 相册业务逻辑服务
 */
const albumModel = require("../models/albumModel");
const imageModel = require("../models/imageModel");
const storageService = require("../services/storageService");
const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");
const logger = require("../utils/logger");

/**
 * 获取用户的相册列表（包含封面图片URL）
 */
async function getAlbumsList({ userId, pageNo = 1, pageSize = 20 }) {
  // 确保"喜欢"相册存在（这样用户至少能看到一个相册）
  try {
    albumModel.getOrCreateFavoriteAlbum(userId);
  } catch (error) {
    // 继续执行，即使创建失败也尝试查询现有相册
  }

  const allAlbums = albumModel.getAlbumsByUserId({ userId });

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
      album.coverImageId = albumModel.getAlbumCoverImageId(album.albumId);
    }
  });

  // 为每个相册添加封面图片URL
  const albumsWithCover = await Promise.all(
    albums.map(async (album) => {
      let coverImageUrl = null;

      if (album.coverImageId) {
        // 查询封面图片的存储信息
        const coverImage = await _getImageById(album.coverImageId);
        if (coverImage) {
          coverImageUrl = await storageService.getFileUrl(coverImage.thumbnailStorageKey, coverImage.storageType);
        }
      }

      return {
        ...album,
        coverImageUrl,
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
  const nameExists = existingAlbums.some((album) => album.name === name.trim() && album.albumType === "custom");

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
    albumType: "custom",
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
    const nameExists = existingAlbums.some((a) => a.albumId !== albumId && a.name === name.trim() && a.albumType === "custom");

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
    const isInAlbum = albumModel.isImageInAlbum({ albumId, imageId: coverImageId });
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
    const coverImage = _getImageById(updatedAlbum.coverImageId);
    if (coverImage) {
      coverImageUrl = await storageService.getFileUrl(coverImage.thumbnailStorageKey, coverImage.storageType);
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

  // 注意：SQL 中已经包含了 album_type != 'favorite' 的保护
  // 如果尝试删除"喜欢"相册，SQL 会返回 affectedRows === 0
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
async function addImagesToAlbum({ userId, albumId, imageIds }) {
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
  // TODO: 添加图片验证逻辑（可以调用imageModel检查）

  const result = albumModel.addImagesToAlbum({ albumId, imageIds, userId, albumType: album.albumType });

  return result;
}

/**
 * 从相册中移除图片
 */
async function removeImagesFromAlbum({ userId, albumId, imageIds }) {
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

  const result = albumModel.removeImagesFromAlbum({ albumId, imageIds, userId, albumType: album.albumType });

  return result;
}

/**
 * 设置相册封面图片
 */
async function setAlbumCover({ userId, albumId, imageId }) {
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

  // 验证图片是否在相册中
  const isInAlbum = albumModel.isImageInAlbum({ albumId, imageId });
  if (!isInAlbum) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
      message: "封面图片必须属于该相册",
    });
  }

  const result = albumModel.setAlbumCover({ albumId, imageId });

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
    const coverImage = await _getImageById(updatedAlbum.coverImageId);
    if (coverImage) {
      coverImageUrl = await storageService.getFileUrl(coverImage.thumbnailStorageKey, coverImage.storageType);
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

  // 添加封面图片URL
  let coverImageUrl = null;
  if (album.coverImageId) {
    const coverImage = _getImageById(album.coverImageId);
    if (coverImage) {
      coverImageUrl = await storageService.getFileUrl(coverImage.thumbnailStorageKey, coverImage.storageType);
    }
  }

  return {
    ...album,
    coverImageUrl,
  };
}

/**
 * 切换图片喜欢状态
 */
async function toggleFavoriteImage({ userId, imageId, isFavorite }) {
  // 验证图片存在且属于当前用户
  // TODO: 添加图片验证逻辑

  const result = albumModel.toggleFavoriteImage({
    userId,
    imageId,
    isFavorite,
  });

  return result;
}

/**
 * 获取相册中的图片列表（包含完整URL）
 */
async function getAlbumImagesList({ userId, albumId, pageNo, pageSize }) {
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

  const queryResult = albumModel.getAlbumImages({
    albumId,
    pageNo,
    pageSize,
  });

  // 为图片添加完整URL（isFavorite字段已从数据库直接返回）
  const imagesWithUrl = await Promise.all(
    queryResult.data.map(async (image) => {
      const thumbnailUrl = await storageService.getFileUrl(image.thumbnailStorageKey, image.storageType);
      const highResUrl = await storageService.getFileUrl(image.highResStorageKey, image.storageType);

      return {
        ...image,
        albumId, // 添加 albumId 字段，统一返回格式
        thumbnailUrl,
        highResUrl,
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
function _getImageById(imageId) {
  const image = imageModel.getImageStorageInfo(imageId);
  return image
    ? {
        thumbnailStorageKey: image.thumbnailStorageKey,
        highResStorageKey: image.highResStorageKey,
        storageType: image.storageType,
      }
    : null;
}

module.exports = {
  getAlbumsList,
  createAlbum,
  getAlbumById,
  updateAlbum,
  deleteAlbum,
  addImagesToAlbum,
  removeImagesFromAlbum,
  toggleFavoriteImage,
  getAlbumImagesList,
  setAlbumCover,
};
