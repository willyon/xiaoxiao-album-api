/*
 * @Description: 对 residual 分词后的 token 做过滤：
 * - 全词命中 STOP_WORDS / WEAK_VERBS → 剔除
 * - 整个 token 仅为一个 U+3400–U+9FFF 码点（CJK 统一表意文字常用区单字）→ 剔除，避免 FTS 多词 AND 被单字噪声拖累；英文/数字单字符保留
 *
 * 作用范围（剔除 = 不进入核心词，也就不参与）：
 * - 长句视觉 FTS：`getCoreTokensOnlyForResidual` 拼 MATCH
 * - 向量字面护栏：`buildFinalLexicalTokensForResidual` → 经 `expandTermsWithSynonyms` 展开，再 `passLexicalGate`
 *
 * 英文纯 ASCII token 先 lowerCase 再与两表比对。
 */
const { segmentFieldForSearchTerms } = require("./chineseSegmenter");
const { expandTermsWithSynonyms } = require("./searchSynonymExpansion");

/** 中文：单字虚词 + 二字及以上功能词；与分词结果全词匹配则剔除 */
const STOP_WORDS = new Set([
  // --- 单字虚词 / 介助 / 代词（显式列出）
  "的",
  "了",
  "着",
  "过",
  "在",
  "和",
  "与",
  "或",
  "及",
  "把",
  "被",
  "给",
  "从",
  "向",
  "往",
  "到",
  "对",
  "为",
  "以",
  "于",
  "由",
  "将",
  "是",
  "有",
  "就",
  "也",
  "还",
  "又",
  "都",
  "才",
  "只",
  "很",
  "太",
  "更",
  "最",
  "挺",
  "真",
  "好",
  "多",
  "少",
  "不",
  "没",
  "未",
  "别",
  "吗",
  "呢",
  "吧",
  "啊",
  "呀",
  "哦",
  "嗯",
  "啦",
  "哇",
  "哈",
  "唉",
  "哟",
  "嘛",
  "呗",
  "地",
  "得",
  "所",
  "之",
  "其",
  "某",
  "各",
  "每",
  "这",
  "那",
  "哪",
  "啥",
  "您",
  "你",
  "我",
  "他",
  "她",
  "它",
  "咱",
  "们",
  "等",
  // --- 二字及以上：代词与指代
  "我们",
  "你们",
  "他们",
  "她们",
  "它们",
  "自己",
  "人家",
  "大家",
  "彼此",
  "各位",
  "什么",
  "怎么",
  "怎样",
  "如何",
  "为何",
  "哪里",
  "哪儿",
  "这边",
  "那边",
  "这里",
  "那里",
  "这些",
  "那些",
  "这个",
  "那个",
  "这样",
  "那样",
  "如此",
  "某样",
  "其它",
  "其他",
  "其余",
  "某个",
  "某些",
  "各种",
  "各自",
  "一切",
  "所有",
  "每个",
  // 数量与程度（泛化）
  "一个",
  "一些",
  "一点",
  "一下",
  "一直",
  "一定",
  "许多",
  "不少",
  "很多",
  "非常",
  "比较",
  "更加",
  "特别",
  "尤其",
  "十分",
  "相当",
  "极其",
  "有点",
  "有些",
  // 连词与逻辑
  "但是",
  "然而",
  "不过",
  "而且",
  "并且",
  "或者",
  "还是",
  "以及",
  "要么",
  "因此",
  "所以",
  "因为",
  "如果",
  "虽然",
  "于是",
  "然后",
  "接着",
  "同时",
  "另外",
  "此外",
  "总之",
  "即便",
  "除非",
  // 能愿与判断套话
  "可以",
  "能够",
  "应该",
  "需要",
  "必须",
  "得以",
  "是否",
  "有没有",
  "是不是",
  "要不要",
  "能不能",
  "会不会",
  "可不可以",
  // 介词类常见双音节
  "关于",
  "对于",
  "至于",
  "根据",
  "按照",
  "通过",
  "为了",
  "除了",
  "有关",
  // 时间状态（弱约束）
  "正在",
  "将要",
  "快要",
  "已经",
  "曾经",
  "仍然",
  "依然",
  "本来",
  "原来",
  "其实",
  "果然",
  "终于",
  "马上",
  "立刻",
  "忽然",
  "突然",
  "渐渐",
  "慢慢",
  "匆匆",
  // 结构补片
  "的话",
  "而言",
  "来说",
  "之一",
  "似的",
  "与否",
]);

/** 中文：单字泛化动/能愿 + 二字及以上弱动词短语；全词匹配则剔除 */
const WEAK_VERBS = new Set([
  "玩",
  "看",
  "吃",
  "走",
  "跑",
  "拿",
  "做",
  "去",
  "来",
  "说",
  "想",
  "要",
  "会",
  "能",
  "打",
  "坐",
  "站",
  "躺",
  "睡",
  "穿",
  "洗",
  "喝",
  "听",
  "讲",
  "谈",
  "笑",
  "哭",
  "抱",
  "亲",
  "拍",
  "买",
  "卖",
  "开",
  "关",
  "用",
  "弄",
  "搞",
  "看看",
  "瞧瞧",
  "望望",
  "走走",
  "跑跑",
  "玩玩",
  "睡睡",
  "说说",
  "坐坐",
  "躺躺",
  "进行",
  "开始",
  "继续",
  "准备",
  "尝试",
  "打算",
  "觉得",
  "认为",
  "知道",
  "明白",
  "记得",
  "忘记",
  "希望",
  "喜欢",
  "讨厌",
]);

const CJK_UNIFIED_IDEOGRAPH_MIN = 0x3400;
const CJK_UNIFIED_IDEOGRAPH_MAX = 0x9fff;

/** 整个 token 仅为一个码点且落在 CJK 统一表意文字 U+3400–U+9FFF（不用 length，避免误伤英文/数字） */
function isSingleCjkUnifiedIdeographOnly(s) {
  const t = String(s).trim();
  if (!t) return false;
  const chars = Array.from(t);
  if (chars.length !== 1) return false;
  const cp = chars[0].codePointAt(0);
  return cp >= CJK_UNIFIED_IDEOGRAPH_MIN && cp <= CJK_UNIFIED_IDEOGRAPH_MAX;
}

function extractCoreTokens(tokens) {
  return (tokens || []).filter((t) => {
    if (!t) return false;
    const s = String(t).trim();
    if (!s) return false;
    const key = /^[\x00-\x7f]+$/.test(s) ? s.toLowerCase() : s;
    if (STOP_WORDS.has(key)) return false;
    if (WEAK_VERBS.has(key)) return false;
    if (isSingleCjkUnifiedIdeographOnly(s)) return false;
    return true;
  });
}

/** 与短句 term 路径一致：正向 key→values + 反向 value→keys 及整组同义词；反向索引在 searchSynonymExpansion 内懒构建一次 */
function expandCoreTokens(coreTokens) {
  return expandTermsWithSynonyms(coreTokens || []);
}

/** residual → 分词 → 剔除 STOP/WEAK + CJK 单字（U+3400–U+9FFF）→ 供长句视觉 FTS 拼串（不含同义词） */
function getCoreTokensOnlyForResidual(residual) {
  const raw = String(residual || "").trim();
  if (!raw) {
    return [];
  }
  return extractCoreTokens(segmentFieldForSearchTerms(raw));
}

/** 在核心词上叠合同义词，供向量字面护栏 passLexicalGate */
function buildFinalLexicalTokensForResidual(residual) {
  const core = getCoreTokensOnlyForResidual(residual);
  return expandCoreTokens(core);
}

/**
 * @param {string} descriptionText - media_search.description_text
 * @param {string[]} tokens - buildFinalLexicalTokensForResidual 的输出
 * @returns {boolean}
 */
function passLexicalGate(descriptionText, tokens) {
  if (!tokens || tokens.length === 0) {
    // 无可校验词则纯向量补召回一律不通过（避免仅剩虚词/弱动词时无边界放行）
    return false;
  }
  const text = String(descriptionText || "").toLowerCase();
  return tokens.some((token) => {
    if (!token) return false;
    return text.includes(String(token).toLowerCase());
  });
}

module.exports = {
  extractCoreTokens,
  expandCoreTokens,
  getCoreTokensOnlyForResidual,
  buildFinalLexicalTokensForResidual,
  passLexicalGate,
};
