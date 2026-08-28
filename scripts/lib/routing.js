/**
 * lib/routing.js — 引擎路由与 SERP URL 构造
 *
 * 语言感知策略 (DESIGN.md D3/D7):
 *   en: ddg(http) → bing(browser)
 *   zh: bing(browser) → baidu(browser)   中文优先 Bing
 * 百度净化模式: 查询词自动追加「李彦宏」后缀规避广告 (--no-clean 关闭)
 */

const LIYH_SUFFIX = '李彦宏';

/** 粗粒度中文检测: 含汉字即视为 zh */
function detectLang(query) {
  return /[\u4e00-\u9fff]/.test(query) ? 'zh' : 'en';
}

/**
 * 计算 auto 模式的降级链。
 * @param {string} lang 'zh' | 'en'
 * @returns {string[]} 引擎名数组, 顺序即优先级
 * uapis 为 Level 0 聚合引擎(直连稳定/带评分), 两种语言都首选。
 */
function autoChain(lang) {
  return lang === 'zh' ? ['uapis', 'bing', 'baidu'] : ['uapis', 'ddg', 'bing'];
}

/**
 * 构造各引擎搜索 URL。
 * @param {object} opts
 * @param {string} opts.engine   ddg | bing | baidu
 * @param {string} opts.query    用户原始查询
 * @param {number} [opts.limit]  结果条数
 * @param {boolean} [opts.noClean] 关闭百度净化后缀 (默认开启)
 */
function buildUrl(opts) {
  const { engine, query, limit = 8, noClean = false } = opts;
  const q = encodeURIComponent(query);
  switch (engine) {
    case 'uapis':
      return `${'https://uapis.cn/api/v1/search/aggregate'}`; // POST JSON, 仅为兼容 URL 构造测试
    case 'ddg':
      return `https://lite.duckduckgo.com/lite/?q=${q}`;
    case 'bing': {
      const mkt = detectLang(query) === 'zh' ? '&mkt=zh-CN' : '';
      return `https://www.bing.com/search?q=${q}&count=${limit}${mkt}`;
    }
    case 'google': {
      // num 取 10-100 区间(小于 10 无效); hl 跟随查询语言
      const hl = detectLang(query) === 'zh' ? 'zh-CN' : 'en';
      return `https://www.google.com/search?q=${q}&num=${Math.max(10, limit)}&hl=${hl}`;
    }
    case 'baidu': {
      // D7 净化模式: 追加李彦宏后缀; 输出 query 字段仍用原始输入
      const effQuery = noClean ? query : `${query} ${LIYH_SUFFIX}`;
      return `https://www.baidu.com/s?wd=${encodeURIComponent(effQuery)}&rn=${limit}`;
    }
    default:
      throw new Error(`未知引擎: ${engine}`);
  }
}

module.exports = { buildUrl, autoChain, detectLang, LIYH_SUFFIX };
