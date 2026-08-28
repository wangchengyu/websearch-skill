/**
 * engines/ddg-http.js — Level 1 引擎: DuckDuckGo Lite (纯 HTTP)
 *
 * 特性:
 * - 走系统代理: 环境变量 HTTP(S)_PROXY 存在时需要 NODE_USE_ENV_PROXY=1,
 *   由 search.js 入口负责保障(必要时自动重启动)。
 * - 节流: 同进程串行调用间隔 3s (跨进程由状态文件协调)。
 * - 风控判定后抛 BlockedError, 由调度器降级。
 */
const { buildUrl } = require('../lib/routing');
const { createGate } = require('../lib/ratelimit');
const detector = require('../lib/detector');
const parser = require('../lib/parser');

const MIN_INTERVAL_MS = 3000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 风控信号错误类 */
class BlockedError extends Error {
  constructor(reason) {
    super(`被风控: ${reason}`);
    this.name = 'BlockedError';
    this.reason = reason;
  }
}

/**
 * 默认门闸实例。状态文件放全局目录, 跨 pi 会话生效。
 */
let gate = null;
function getGate(statePath) {
  if (!gate) {
    gate = createGate({ engine: 'ddg', minIntervalMs: MIN_INTERVAL_MS, statePath });
  }
  return gate;
}

/**
 * 执行搜索。
 * @returns {Promise<import('../lib/parser').SearchResult[]>}
 */
async function search(query, opts = {}) {
  const { limit = 8, lang = 'en', statePath, timeoutMs = 15000 } = opts;
  const g = getGate(statePath);
  const url = buildUrl({ engine: 'ddg', query });

  g.commit(); // 发起即记录
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': lang === 'zh' ? 'zh-CN,zh;q=0.9' : 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const d = detector.detect(html);
  if (d.blocked) throw new BlockedError(d.reason);

  return parser.parse(html, 'ddg').slice(0, limit);
}

module.exports = { search, BlockedError, MIN_INTERVAL_MS };
