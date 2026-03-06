/**
 * 筛选条件映射配置
 * 
 * 用于将前端选择的值转换为后端数据库查询需要的值
 */

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
  AGE_GROUP_FRONTEND_TO_BACKEND
};
