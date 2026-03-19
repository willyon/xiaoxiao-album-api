/*
 * @Description: 城市词典刷新调度器（去抖 + 最大延迟）
 * 用于在导入/分析连续进行时，避免频繁查询 media.city。
 */
const logger = require("../utils/logger");
const { refreshCityDictionary } = require("./cityDictionaryProvider");

let debounceTimer = null;
let maxDelayTimer = null;
let firstScheduleAt = null;

// 去抖间隔（毫秒），默认 1 分钟，可通过环境变量覆盖
// 批量导入场景：更希望在“导入结束后”再刷新，因此默认放大去抖时间
const DEBOUNCE_MS = Number(process.env.CITY_DICT_REFRESH_DEBOUNCE_MS || 1 * 60 * 1000);
// 最大延迟时间（毫秒）。默认关闭（0），以确保只在导入停止后刷新；
// 如需在持续导入时也周期刷新，可设置为正数（例如 30*60*1000）。
const MAX_DELAY_MS = Number(process.env.CITY_DICT_REFRESH_MAX_DELAY_MS || 0);

function scheduleCityDictionaryRefresh(reason = "import") {
  const now = Date.now();

  if (!firstScheduleAt) {
    firstScheduleAt = now;
    if (MAX_DELAY_MS > 0) {
      if (maxDelayTimer) {
        clearTimeout(maxDelayTimer);
      }
      maxDelayTimer = setTimeout(() => {
        maxDelayTimer = null;
        firstScheduleAt = null;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        _executeRefresh("maxDelay");
      }, MAX_DELAY_MS);
    }
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (maxDelayTimer) {
      clearTimeout(maxDelayTimer);
      maxDelayTimer = null;
    }
    firstScheduleAt = null;
    _executeRefresh(reason);
  }, DEBOUNCE_MS);
}

function _executeRefresh(reason) {
  try {
    const dict = refreshCityDictionary();
    logger.info({
      message: "cityDictionary.refresh.completed",
      details: { reason, size: Array.isArray(dict) ? dict.length : null },
    });
  } catch (error) {
    logger.warn({
      message: "cityDictionary.refresh.failed",
      details: { reason, error: error?.message },
    });
  }
}

module.exports = {
  scheduleCityDictionaryRefresh,
};

