const { addFullUrlToMedia } = require('../mediaService')

/**
 * 为聚类列表批量补全封面 thumbnailUrl，并裁剪为前端所需字段。
 * @param {Array<{clusterId:number,name:string,mediaCount:number,coverImage?:{thumbnailStorageKey?:string}|null,timeRange?:any}>} list - getClustersByUserId / getRecentClustersByUserId 返回的 list。
 * @returns {Promise<Array<{ clusterId:number, name:string, mediaCount:number, coverImage:{thumbnailUrl:string}|null, timeRange:any }>>} 补齐后的聚类列表。
 */
async function attachClusterCoverUrls(list) {
  const coverImages = list
    .filter((cluster) => cluster.coverImage?.thumbnailStorageKey)
    .map((cluster) => ({
      mediaId: cluster.clusterId,
      thumbnailStorageKey: cluster.coverImage.thumbnailStorageKey
    }))

  const urlsMap = new Map()
  if (coverImages.length > 0) {
    const urls = (await addFullUrlToMedia(coverImages)) || []
    urls.forEach((urlItem) => {
      if (urlItem?.mediaId != null && urlItem?.thumbnailUrl) {
        urlsMap.set(urlItem.mediaId, urlItem.thumbnailUrl)
      }
    })
  }

  return list.map((cluster) => {
    const url = urlsMap.get(cluster.clusterId) || null
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
