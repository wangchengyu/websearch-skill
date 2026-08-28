/**
 * lib/ratelimit.js — 跨进程节流状态机
 *
 * 多次单次 CLI 调用之间通过状态文件共享"上次请求时间"，
 * 同引擎两次调用强制最小间隔；等待由调用方决策（sleep 或降级）。
 * 时钟可注入（测试用假时钟）。
 */
const fs = require('fs');
const path = require('path');

function loadState(statePath) {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.engines === 'object') return parsed;
    return { engines: {} };
  } catch {
    return { engines: {} }; // 不存在或损坏 → 视为首帧
  }
}

function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state));
}

/**
 * 创建引擎门闸。
 * @param {object} opts
 * @param {string} opts.engine     引擎名
 * @param {number} opts.minIntervalMs 同引擎最小调用间隔
 * @param {string} opts.statePath  状态文件路径
 * @param {() => number} [opts.now] 时钟注入点
 * @returns {{ waitMs(): number, commit(): void }}
 */
function createGate(opts) {
  const { engine, minIntervalMs, statePath, now = Date.now } = opts;

  return {
    /** 距离可以发起请求还差多少毫秒; 0 = 立即可行 */
    waitMs() {
      const st = loadState(statePath);
      const last = st.engines[engine];
      if (!last) return 0; // R-FIRST-01
      const elapsed = now() - last;
      if (elapsed >= minIntervalMs) return 0;
      return minIntervalMs - elapsed; // R-WAIT-01
    },
    /** 请求发出后记录时间戳 (R-PASS-01) */
    commit() {
      const st = loadState(statePath);
      st.engines[engine] = now(); // R-ISOLATION-01: 只写本引擎键
      saveState(statePath, st);
    },
  };
}

/** sleep 工具 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { createGate, sleep };
