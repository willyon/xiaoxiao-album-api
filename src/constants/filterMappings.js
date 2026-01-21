/**
 * 筛选条件映射配置
 * 
 * 用于将前端选择的值转换为后端数据库查询需要的值
 */

/**
 * 颜色主题映射：前端3分类 → 后端5分类
 * 前端使用3分类（bright-vibrant, neutral, dark）
 * 后端使用5分类（vibrant, bright, neutral, muted, dim）
 */
const COLOR_THEME_FRONTEND_TO_BACKEND = {
  'bright-vibrant': ['vibrant', 'bright'], // 明快（合并鲜艳+明亮）
  neutral: ['neutral'], // 普通
  dark: ['muted', 'dim'] // 暗调（合并柔和+暗淡）
};

/**
 * 年龄段映射：前端5分类 → 后端9分类
 * 前端使用5分类（baby, child, teenager, adult, senior）
 * 后端使用9分类（0-2, 3-9, 10-19, 20-29, 30-39, 40-49, 50-59, 60-69, 70+）
 */
const AGE_GROUP_FRONTEND_TO_BACKEND = {
  baby: ['0-2'], // 婴儿
  child: ['3-9'], // 儿童
  teenager: ['10-19'], // 青少年
  adult: ['20-29', '30-39', '40-49', '50-59'], // 成人
  senior: ['60-69', '70+'] // 老年人
};

module.exports = {
  COLOR_THEME_FRONTEND_TO_BACKEND,
  AGE_GROUP_FRONTEND_TO_BACKEND
};
