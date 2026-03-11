/*
 * Object taxonomy 映射
 * - 目标：Raw label → Canonical label → Category / 中文别名
 * - 现阶段：以恒等映射为主，预留扩展点，避免阻塞功能落地
 */

/**
 * @typedef {Object} ObjectTaxonomyEntry
 * @property {string} canonical  规范化英文标签
 * @property {string|null} category  顶层类别（如 'animal' | 'vehicle'），暂无则为 null
 * @property {string|null} zh  中文别名，暂无则为 null
 */

/** @type {Record<string, ObjectTaxonomyEntry>} */
const OBJECT_TAXONOMY = {
  // ===== 人物 / 身体相关 =====
  person: { canonical: "person", category: "people", zh: "人物" },
  man: { canonical: "person", category: "people", zh: "男人" },
  woman: { canonical: "person", category: "people", zh: "女人" },
  boy: { canonical: "person", category: "people", zh: "男孩" },
  girl: { canonical: "person", category: "people", zh: "女孩" },
  baby: { canonical: "baby", category: "people", zh: "宝宝" },
  child: { canonical: "child", category: "people", zh: "小孩" },
  face: { canonical: "face", category: "people", zh: "人脸" },

  // ===== 宠物 / 动物 =====
  dog: { canonical: "dog", category: "animal", zh: "狗" },
  puppy: { canonical: "dog", category: "animal", zh: "小狗" },
  cat: { canonical: "cat", category: "animal", zh: "猫" },
  kitten: { canonical: "cat", category: "animal", zh: "小猫" },
  bird: { canonical: "bird", category: "animal", zh: "鸟" },
  pigeon: { canonical: "bird", category: "animal", zh: "鸽子" },
  sparrow: { canonical: "bird", category: "animal", zh: "麻雀" },
  fish: { canonical: "fish", category: "animal", zh: "鱼" },
  goldfish: { canonical: "fish", category: "animal", zh: "金鱼" },
  horse: { canonical: "horse", category: "animal", zh: "马" },
  cow: { canonical: "cow", category: "animal", zh: "牛" },
  sheep: { canonical: "sheep", category: "animal", zh: "羊" },
  rabbit: { canonical: "rabbit", category: "animal", zh: "兔子" },

  // ===== 交通工具 =====
  car: { canonical: "car", category: "vehicle", zh: "汽车" },
  truck: { canonical: "truck", category: "vehicle", zh: "卡车" },
  bus: { canonical: "bus", category: "vehicle", zh: "公交车" },
  bicycle: { canonical: "bicycle", category: "vehicle", zh: "自行车" },
  bike: { canonical: "bicycle", category: "vehicle", zh: "自行车" },
  motorcycle: { canonical: "motorcycle", category: "vehicle", zh: "摩托车" },
  train: { canonical: "train", category: "vehicle", zh: "火车" },
  airplane: { canonical: "airplane", category: "vehicle", zh: "飞机" },
  plane: { canonical: "airplane", category: "vehicle", zh: "飞机" },
  boat: { canonical: "boat", category: "vehicle", zh: "小船" },
  ship: { canonical: "ship", category: "vehicle", zh: "轮船" },

  // ===== 建筑 / 室内外环境 =====
  house: { canonical: "house", category: "building", zh: "房子" },
  home: { canonical: "house", category: "building", zh: "家" },
  building: { canonical: "building", category: "building", zh: "建筑" },
  skyscraper: { canonical: "building", category: "building", zh: "高楼" },
  tower: { canonical: "tower", category: "building", zh: "塔" },
  bridge: { canonical: "bridge", category: "building", zh: "桥" },
  street: { canonical: "street", category: "outdoor", zh: "街道" },
  road: { canonical: "street", category: "outdoor", zh: "马路" },
  park: { canonical: "park", category: "outdoor", zh: "公园" },
  garden: { canonical: "garden", category: "outdoor", zh: "花园" },
  beach: { canonical: "beach", category: "outdoor", zh: "海滩" },
  mountain: { canonical: "mountain", category: "outdoor", zh: "山" },

  // ===== 家具 / 室内物件 =====
  sofa: { canonical: "sofa", category: "furniture", zh: "沙发" },
  couch: { canonical: "sofa", category: "furniture", zh: "沙发" },
  chair: { canonical: "chair", category: "furniture", zh: "椅子" },
  table: { canonical: "table", category: "furniture", zh: "桌子" },
  bed: { canonical: "bed", category: "furniture", zh: "床" },
  desk: { canonical: "desk", category: "furniture", zh: "书桌" },
  tv: { canonical: "tv", category: "electronics", zh: "电视" },
  television: { canonical: "tv", category: "electronics", zh: "电视" },
  laptop: { canonical: "laptop", category: "electronics", zh: "笔记本电脑" },
  computer: { canonical: "computer", category: "electronics", zh: "电脑" },
  phone: { canonical: "phone", category: "electronics", zh: "手机" },
  smartphone: { canonical: "phone", category: "electronics", zh: "手机" },

  // ===== 食物 / 饮品 =====
  food: { canonical: "food", category: "food", zh: "食物" },
  pizza: { canonical: "pizza", category: "food", zh: "披萨" },
  burger: { canonical: "burger", category: "food", zh: "汉堡" },
  sandwich: { canonical: "sandwich", category: "food", zh: "三明治" },
  cake: { canonical: "cake", category: "food", zh: "蛋糕" },
  bread: { canonical: "bread", category: "food", zh: "面包" },
  coffee: { canonical: "coffee", category: "drink", zh: "咖啡" },
  tea: { canonical: "tea", category: "drink", zh: "茶" },
  beer: { canonical: "beer", category: "drink", zh: "啤酒" },
  wine: { canonical: "wine", category: "drink", zh: "红酒" },

  // ===== 植物 / 自然元素 =====
  tree: { canonical: "tree", category: "plant", zh: "树" },
  grass: { canonical: "grass", category: "plant", zh: "草地" },
  flower: { canonical: "flower", category: "plant", zh: "花" },
  leaf: { canonical: "leaf", category: "plant", zh: "树叶" },
  sky: { canonical: "sky", category: "nature", zh: "天空" },
  cloud: { canonical: "cloud", category: "nature", zh: "云" },
  sun: { canonical: "sun", category: "nature", zh: "太阳" },
  moon: { canonical: "moon", category: "nature", zh: "月亮" },
  star: { canonical: "star", category: "nature", zh: "星星" },
  river: { canonical: "river", category: "nature", zh: "河流" },
  lake: { canonical: "lake", category: "nature", zh: "湖泊" },
  waterfall: { canonical: "waterfall", category: "nature", zh: "瀑布" },
  snow: { canonical: "snow", category: "nature", zh: "雪" },
  ice: { canonical: "ice", category: "nature", zh: "冰" },

  // ===== 其他常见物体 =====
  book: { canonical: "book", category: "object", zh: "书" },
  camera: { canonical: "camera", category: "object", zh: "相机" },
  bag: { canonical: "bag", category: "object", zh: "包" },
  backpack: { canonical: "backpack", category: "object", zh: "背包" },
  suitcase: { canonical: "suitcase", category: "object", zh: "行李箱" },
  umbrella: { canonical: "umbrella", category: "object", zh: "雨伞" },
};

/**
 * 将 Raw label 映射为规范化标签信息。
 * 当前若未配置，默认 canonical=raw、category=null、zh=null。
 *
 * @param {string} raw
 * @returns {ObjectTaxonomyEntry}
 */
function mapObjectLabel(raw) {
  if (!raw || typeof raw !== "string") {
    return { canonical: "", category: null, zh: null };
  }
  const key = raw.trim().toLowerCase();
  const entry = OBJECT_TAXONOMY[key];
  if (entry) {
    return entry;
  }
  return { canonical: raw, category: null, zh: null };
}

module.exports = {
  OBJECT_TAXONOMY,
  mapObjectLabel,
};

