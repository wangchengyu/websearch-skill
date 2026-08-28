/**
 * engines/uapis.js — Level 0 引擎: UAPI Pro 聚合搜索 (https://uapis.cn)
 *
 * 优势: 服务端聚合多引擎、结果自带相关性评分(score)、无浏览器需求、
 *      国内直连稳定(不经代理)。作为所有查询链的首选引擎。
 *
 * 文档: https://uapis.cn/docs/api-reference/post-search-aggregate
 * 鉴权: 通过环境变量 UAPIS_API_KEY 提供 (如 ~/.zshrc 中 export)。
 *      未设置时先尝试免鉴权请求; 若服务端拒绝则报错并提示设置方法。
 */
const { createGate, sleep } = require('../lib/ratelimit');

const ENDPOINT = 'https://uapis.cn/api/v1/search/aggregate';
const MIN_INTERVAL_MS = 1200;

class BlockedError extends Error {
  constructor(reason) {
    super(`被风控: ${reason}`);
    this.name = 'BlockedError';
    this.reason = reason;
  }
}

function getGate(statePath) {
  return createGate({ engine: 'uapis', minIntervalMs: MIN_INTERVAL_MS, statePath });
}

/** API Key: 仅从环境变量 UAPIS_API_KEY 读取, 不再内置任何硬编码 key */
function apiKey() {
  return process.env.UAPIS_API_KEY || '';
}

/**
 * @returns {Promise<Array<{title,url,snippet,engine}>>} 已按 API 返回 score 排序
 */
async function search(query, opts = {}) {
  const { limit = 8, statePath, timeoutMs = 15000 } = opts;
  const gate = getGate(statePath);
  const w = gate.waitMs();
  if (w > 0) await sleep(Math.min(w, 2000));
  gate.commit();

  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  const key = apiKey();
  if (key) headers['Authorization'] = `Bearer ${key}`;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, count: Math.max(limit, 5) }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status === 429) throw new BlockedError('uapis-rate-limit');
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      key
        ? `鉴权失败(HTTP ${res.status}): UAPIS_API_KEY 无效或已过期`
        : '缺少 API Key: 请设置环境变量 UAPIS_API_KEY (如 export UAPIS_API_KEY=uapi-xxx 写入 ~/.zshrc 后重开终端)'
    );
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const d = await res.json();
  return (d.results || []).slice(0, limit).map((r) => ({
    title: String(r.title || '').trim(),
    url: String(r.url || '').trim(),
    snippet: String(r.snippet || '').replace(/\s+/g, ' ').trim(),
    engine: 'uapis',
  })).filter((r) => r.title && r.url);
}

module.exports = { search, BlockedError };
