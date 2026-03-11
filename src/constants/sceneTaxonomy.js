/*
 * Scene taxonomy 映射
 * - 目标：Raw scene → Canonical scene → 中文别名
 * - 现阶段：以恒等映射为主，预留扩展点
 */

/**
 * @typedef {Object} SceneTaxonomyEntry
 * @property {string} canonical  规范化英文场景名
 * @property {string|null} zh  中文别名，暂无则为 null
 */

/** @type {Record<string, SceneTaxonomyEntry>} */
const SCENE_TAXONOMY = {
  // 居家 / 室内
  home: { canonical: "home", zh: "家" },
  living_room: { canonical: "home", zh: "客厅" },
  bedroom: { canonical: "home", zh: "卧室" },
  kitchen: { canonical: "kitchen", zh: "厨房" },
  bathroom: { canonical: "bathroom", zh: "浴室" },
  office: { canonical: "office", zh: "办公室" },
  workspace: { canonical: "office", zh: "工作区" },
  classroom: { canonical: "school", zh: "教室" },

  // 城市 / 街景
  city: { canonical: "city", zh: "城市" },
  street: { canonical: "street", zh: "街道" },
  downtown: { canonical: "city", zh: "市中心" },
  building: { canonical: "city", zh: "楼宇" },
  skyline: { canonical: "city", zh: "天际线" },
  shopping_mall: { canonical: "shopping_mall", zh: "商场" },

  // 自然 / 旅行
  beach: { canonical: "beach", zh: "海边" },
  sea: { canonical: "beach", zh: "海边" },
  seaside: { canonical: "beach", zh: "海边" },
  mountain: { canonical: "mountain", zh: "山" },
  forest: { canonical: "forest", zh: "森林" },
  park: { canonical: "park", zh: "公园" },
  lake: { canonical: "lake", zh: "湖泊" },
  river: { canonical: "river", zh: "河流" },
  desert: { canonical: "desert", zh: "沙漠" },
  snow: { canonical: "snow", zh: "雪景" },
  countryside: { canonical: "countryside", zh: "乡村" },

  // 用餐 / 聚会
  restaurant: { canonical: "restaurant", zh: "餐厅" },
  cafe: { canonical: "cafe", zh: "咖啡馆" },
  bar: { canonical: "bar", zh: "酒吧" },
  dining: { canonical: "restaurant", zh: "用餐" },
  party: { canonical: "party", zh: "聚会" },
  birthday_party: { canonical: "party", zh: "生日聚会" },
  wedding: { canonical: "wedding", zh: "婚礼" },

  // 亲子 / 娱乐
  playground: { canonical: "playground", zh: "游乐场" },
  amusement_park: { canonical: "playground", zh: "游乐园" },
  school: { canonical: "school", zh: "学校" },
  sports_field: { canonical: "sports", zh: "运动场" },
  stadium: { canonical: "sports", zh: "体育场" },

  // 交通 / 旅途
  airport: { canonical: "airport", zh: "机场" },
  train_station: { canonical: "station", zh: "火车站" },
  station: { canonical: "station", zh: "车站" },
  road_trip: { canonical: "road_trip", zh: "自驾游" },

  // 时间氛围
  night: { canonical: "night", zh: "夜景" },
  sunset: { canonical: "sunset", zh: "日落" },
  sunrise: { canonical: "sunrise", zh: "日出" },
};

/**
 * 将 Raw scene 映射为规范化场景信息。
 * 当前若未配置，默认 canonical=raw、zh=null。
 *
 * @param {string} raw
 * @returns {SceneTaxonomyEntry}
 */
function mapSceneLabel(raw) {
  if (!raw || typeof raw !== "string") {
    return { canonical: "", zh: null };
  }
  const key = raw.trim().toLowerCase();
  const entry = SCENE_TAXONOMY[key];
  if (entry) {
    return entry;
  }
  return { canonical: raw, zh: null };
}

module.exports = {
  SCENE_TAXONOMY,
  mapSceneLabel,
};

