/*
 * @Author: zhangshouchang
 * @Date: 2025-07-26 21:00:09
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-07-26 21:58:18
 * @Description:提供基于 Redis 的冷却时间管理功能，用于限制特定操作（如邮件发送、验证码获取）的频率，防止重复提交。
 */

class CooldownManager {
  /**
   * @param {RedisClient} redisClient - Redis 实例
   * @param {Object} options - 可选配置
   * @param {number} options.defaultCooldown - 默认冷却时间（单位：秒）
   */
  constructor(redisClient, options = {}) {
    this.redis = redisClient;
    this.defaultCooldown = options.defaultCooldown || 60; // 默认60秒
  }

  /**
   * 构造 Redis 中的 key
   * @param {string} type - 冷却类型（如 "email"）
   * @param {string} identifier - 具体标识（如邮箱）
   * @returns {string}
   */
  getKey(type, identifier) {
    return `${type}_cooldown_${identifier}`;
  }

  /**
   * 判断是否仍在冷却中
   * @param {string} type
   * @param {string} identifier
   * @returns {Promise<boolean>}
   */
  async isCoolingDown(type, identifier) {
    const key = this.getKey(type, identifier);
    try {
      const exists = await this.redis.get(key);
      return !!exists;
    } catch (err) {
      console.warn(`[CooldownManager] Redis check failed for ${key}:`, err);
      // 如果 Redis 异常，默认不拦截，返回 false
      return false;
    }
  }

  /**
   * 设置冷却状态
   * @param {string} type
   * @param {string} identifier
   * @param {number} [duration] - 可选自定义冷却时间
   */
  async setCooldown(type, identifier, duration = this.defaultCooldown) {
    const key = this.getKey(type, identifier);
    try {
      await this.redis.set(key, "1", { EX: duration });
    } catch (err) {
      console.warn(`[CooldownManager] Redis set failed for ${key}:`, err);
    }
  }
  /**
   * 获取剩余冷却时间（秒）
   * @param {string} type
   * @param {string} identifier
   * @returns {Promise<number | null>} 返回剩余秒数，或 null 表示无冷却
   */
  async getRemainingCooldown(type, identifier) {
    const key = this.getKey(type, identifier);
    try {
      const ttl = await this.redis.ttl(key);
      if (ttl > 0) return ttl;
      return null;
    } catch (err) {
      console.warn(`[CooldownManager] TTL check failed for ${key}:`, err);
      return null;
    }
  }

  /**
   * 可选方法：清除冷却（通常很少用）
   * @param {string} type
   * @param {string} identifier
   */
  async clearCooldown(type, identifier) {
    const key = this.getKey(type, identifier);
    try {
      await this.redis.del(key);
    } catch (err) {
      console.warn(`[CooldownManager] Redis delete failed for ${key}:`, err);
    }
  }
}

module.exports = CooldownManager;
