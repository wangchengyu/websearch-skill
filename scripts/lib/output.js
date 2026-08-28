/**
 * lib/output.js — CLI 输出格式化（面向 LLM/终端消费）
 */

/** 文本模式: 编号列表, 紧凑但可读 */
function formatText(results) {
  if (!results.length) return '(无结果)';
  const width = String(results.length).length;
  return results
    .map((r, i) => {
      const n = String(i + 1).padStart(width);
      const lines = [`[${n}] ${r.title}`, `    ${r.url}`];
      if (r.snippet) lines.push(`    ${r.snippet}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/** JSON 模式: 结构化输出, 字段与 SearchResult 一致 */
function formatJson(results, extra = {}) {
  return JSON.stringify({ ...extra, count: results.length, results }, null, 2);
}

/** 错误信息 → stderr 行 */
function formatError(message, hint) {
  let out = `[websearch] 错误: ${message}`;
  if (hint) out += `\n[websearch] 建议: ${hint}`;
  return out;
}

module.exports = { formatText, formatJson, formatError };
