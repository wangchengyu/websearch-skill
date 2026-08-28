/**
 * lib/sanity.js — SERP 相关性前置校验
 *
 * 背景: Bing 在反爬状态下会返回 HTTP 200 + 完全无关的结果(导航站/缓存垃圾),
 * 结构合法但内容无价值。此模块以词级重叠判断结果集是否与查询相关,
 * 不相关视同被风控 → 调度器降级或报 blocked。
 */

/** 停用词: 过于常见导致误命中的词 */
const STOP = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'is', 'are',
  'how', 'what', 'with', 'by', 'at', 'from', 'de', 'la', '教程', '怎么', '什么',
]);

/** 分词: 英文按非字母数字切分取 ≥2 字符; 中文提取所有 ≥2 字滑窗 */
function tokenize(q) {
  const tokens = new Set();
  for (const seg of q.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (seg.length >= 2 && !STOP.has(seg) && !/^\d+$/.test(seg)) tokens.add(seg);
    // 中文二元组
    if (/[\u4e00-\u9fff]/.test(seg) && seg.length >= 2) {
      for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2));
    }
  }
  return tokens;
}

/**
 * 判定结果集是否与查询相关。
 * @returns {boolean} true = 至少有一条结果与查询存在词级重叠
 */
function isRelevant(query, results) {
  if (!results || !results.length) return false;
  const qTokens = tokenize(query);
  if (!qTokens.size) return true; // 无法分词时不拦截

  for (const r of results) {
    const hay = `${r.title} ${r.snippet}`.toLowerCase();
    let hits = 0;
    // 英文整词命中
    for (const t of qTokens) {
      if (hay.includes(t)) { hits++; if (hits >= 1) break; }
    }
    if (hits > 0) return true;
  }
  return false;
}

module.exports = { isRelevant, tokenize };
