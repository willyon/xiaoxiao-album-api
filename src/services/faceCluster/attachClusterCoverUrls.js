const { addFullUrlToMedia } = require('../mediaService')

/**
 * 为聚类列表批量补全封面 thumbnailUrl，并裁剪为前端所需字段。
 * @param {Array<Object>} list - getClustersByUserId / getRecentClustersByUserId 返回的 list
 * @returns {Promise<Array<{ clusterId, name, mediaCount, coverImage, timeRange }>>}
 */
async function attachClusterCoverUrls(list) {
  const coverImages = list
    .filter((cluster) => cluster.coverImage?.thumbnailStorageKey)
    .map((cluster) => ({
      thumbnailStorageKey: cluster.coverImage.thumbnailStorageKey
    }))

  const urlsMap = new Map()
  if (coverImages.length > 0) {
    const keyToIndexMap = new Map()
    coverImages.forEach((img, index) => {
      keyToIndexMap.set(index, img.thumbnailStorageKey)
    })
    const urls = await addFullUrlToMedia(coverImages)
    urls.forEach((urlItem, index) => {
      const originalKey = keyToIndexMap.get(index)
      if (originalKey && urlItem?.thumbnailUrl) {
        urlsMap.set(originalKey, urlItem.thumbnailUrl)
      }
    })
  }

  return list.map((cluster) => {
    const url = cluster.coverImage?.thumbnailStorageKey ? urlsMap.get(cluster.coverImage.thumbnailStorageKey) : null
    return {
      clusterId: cluster.clusterId,
      name: cluster.name,
      mediaCount: cluster.mediaCount,
      coverImage: url ? { thumbnailUrl: url } : null,
      timeRange: cluster.timeRange
    }
  })
}

module.exports = {
  attachClusterCoverUrls
}
