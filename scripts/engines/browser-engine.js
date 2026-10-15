/**
 * engines/browser-engine.js — Playwright 浏览器引擎层 (L2)
 *
 * 统一流程: 启动(每次CLI一次) → 新建隐身上下文 → 打开 SERP → 等结果选择器
 *          → 风控判定 → DOM 解析。全部选择器集中在顶部常量区。
 *
 * 反爬对策 (DESIGN.md D3):
 * - 系统 Chrome 新版 headless (--disable-blink-features=AutomationControlled)
 * - navigator.webdriver 抹除
 * - 语言感知 locale / 引擎间随机延迟 / 每引擎跨进程节流(状态文件)
 */
const { chromium } = require('playwright');
const { buildUrl } = require('../lib/routing');
const { createGate, sleep } = require('../lib/ratelimit');
const detector = require('../lib/detector');
const parser = require('../lib/parser');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 各引擎结果页等待选择器与解析引擎名 */
const SELECTORS = {
  bing: { wait: '#b_results li.b_algo', parseAs: 'bing' },
  baidu: { wait: '#content_left .result, #content_left div.c-container[id]', parseAs: 'baidu', warmup: 'https://www.baidu.com/' },
  // Google: h3 为结果标题稳定锚点 (冷上下文极易触发 consent/captcha, 强烈建议 CDP 附身模式)
  google: { wait: '#search h3, #rso h3, #main h3', parseAs: 'google' },
};

class BlockedError extends Error {
  constructor(reason) {
    super(`被风控: ${reason}`);
    this.name = 'BlockedError';
    this.reason = reason;
  }
}

let browserPromise = null;

/**
 * CDP 附身模式: 连接用户已开启调试端口的真实 Chrome。
 * 环境变量 WS_CDP_URL=http://127.0.0.1:9222 时启用。
 * 优势: 复用用户全部登录态/Cookie/指纹, 强风控站点(百度/知乎)直接通过;
 *       浏览器窗口用户可见可控, 必要时可人工介入(登录/验证码)。
 */
function getCdpUrl() {
  return process.env.WS_CDP_URL || null; // 例如 http://127.0.0.1:9222
}

function launch() {
  if (!browserPromise) {
    const cdp = getCdpUrl();
    if (cdp) {
      browserPromise = chromium.connectOverCDP(cdp, { timeout: 8000 });
      return browserPromise;
    }
    // 默认有头模式(用户可见浏览器窗口); WS_HEADLESS=1 时才无头(供自动化/CI)
    const headless = process.env.WS_HEADLESS === '1';
    browserPromise = chromium.launch({
      channel: 'chrome',
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--disable-default-apps',
      ],
    });
  }
  return browserPromise;
}

async function newPage(lang) {
  const browser = await launch();

  // CDP 附身模式: 复用用户真实浏览器默认上下文(保留登录态/书签栏外观),
  // 不覆写 UA/locale/viewport —— 否则反而破坏真实指纹。
  if (getCdpUrl()) {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const page = await ctx.newPage();
    return { ctx, page, attached: true };
  }

  const ctx = await browser.newContext({
    userAgent: UA,
    locale: lang === 'zh' ? 'zh-CN' : 'en-US',
    viewport: { width: 1366 + Math.floor(Math.random() * 200), height: 900 },
  });
  const page = await ctx.newPage();
  // 隐身注入: 在任何页面脚本前执行 (仅 launch 模式; 附身模式注入反而不自然)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return { ctx, page, attached: false };
}

/**
 * 浏览器引擎搜索统一入口。
 * @param {'bing'|'baidu'} engine
 */
async function search(engine, query, opts = {}) {
  const { limit = 8, lang = 'en', statePath, timeoutMs = 25000, noClean = false } = opts;
  if (!SELECTORS[engine]) throw new Error(`未知浏览器引擎: ${engine}`);
  const { wait, parseAs } = SELECTORS[engine];

  // Google 对全新指纹极敏感: 无 CDP 附身模式时提示建议, 但仍尝试 launch 模式
  if (engine === 'google' && !getCdpUrl() && !process.env.WS_GOOGLE_NO_HINT) {
    console.error('[websearch] 提示: google 引擎建议启用 CDP 附身模式 (export WS_CDP_URL=http://127.0.0.1:9222),\n'
      + '           冷上下文直搜 Google 极易触发同意页/人机验证。继续尝试中...');
  }

  // 跨进程节流: 同引擎最小间隔 8s (超出本次超时则直接放弃)
  const gate = createGate({ engine, minIntervalMs: 8000, statePath });
  const w = gate.waitMs();
  if (w > 0 && w > timeoutMs * 0.8) {
    throw new Error(`${engine} 节流中, 还需等待 ${w}ms`);
  }
  if (w > 0) await sleep(w);

  gate.commit();
  const { ctx, page, attached } = await newPage(lang);
  try {
    // 百度需要先访问首页预热 Cookie (BAIDUID), 冷上下文直接打 /s 会被安全验证拦截
    if (SELECTORS[engine].warmup) {
      await page.goto(SELECTORS[engine].warmup, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
      await page.waitForTimeout(600);
    }
    const url = buildUrl({ engine, query, limit, noClean });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForSelector(wait, { timeout: Math.min(10000, timeoutMs) }).catch(() => {});
    await page.waitForTimeout(800); // 稳定异步注入

    const html = await page.content();

    const d = detector.detect(html);
    if (d.blocked) throw new BlockedError(d.reason);

    const parsed = parser.parse(html, parseAs).slice(0, limit);

    // 百度 /link 跳转是会话绑定临时链接: 在同一会话内立即解析为真实 URL,
    // 否则离开会话后链接很快 404。最多解析 4 条避免耗时过长。
    if (engine === 'baidu' && parsed.length) {
      await resolveBaiduLinks(ctx, parsed);
    }

    // Google /goto 加密跳转: 在 SERP 页内 meta-click 新标签页读最终 URL,
    // cite 显示 URL 兑底。
    if (engine === 'google' && parsed.length) {
      await resolveGoogleLinks(page, parsed);
      finalizeGoogleResults(parsed);
    }

    return parsed;
  } finally {
    // 附身模式绝不关上下文(那是用户正在用的浏览器会话); 只关自己开的标签页
    if (attached) {
      await page.close().catch(() => {});
    } else {
      await ctx.close();
    }
  }
}

/**
 * 同会话内解析百度跳转链接 (新标签页跟进重定向读最终 URL)。
 * 超时/失败时保留原链接。
 */
async function resolveBaiduLinks(ctx, results, max = 4) {
  let done = 0;
  for (const r of results) {
    if (done >= max) break;
    if (!/^https?:\/\/(www\.)?baidu\.com\/link/.test(r.url)) continue;
    done++;
    const page = await ctx.newPage();
    try {
      await page.goto(r.url, {
        waitUntil: 'domcontentloaded',
        timeout: 12000,
        referer: 'https://www.baidu.com/',
      });
      await page.waitForTimeout(600);
      const finalUrl = page.url();
      if (!/(^|\.)(baidu\.com)/i.test(finalUrl)) r.url = finalUrl.split('#')[0];
    } catch {
      /* 保留原链接 */
    } finally {
      await page.close().catch(() => {});
    }
  }
}

/**
 * Google /goto 加密跳转解析: 对每条结果 meta-click 打开新标签页, 读弹窗最终 URL。
 * 按原始 href 配对锚点, 避免与解析结果错位。
 */
async function resolveGoogleLinks(page, results, max = 10) {
  const ctx = page.context();
  let anchors;
  try {
    anchors = page.locator('#search a:has(h3), #rso a:has(h3), #main a:has(h3)');
    await anchors.first().waitFor({ state: 'attached', timeout: 3000 });
  } catch {
    return; // 锚点不可用 → 全部走 cite 兑底
  }
  const hrefs = await anchors
    .evaluateAll((els) => els.map((a) => a.getAttribute('href') || ''))
    .catch(() => []);

  for (const r of results.slice(0, max)) {
    if (!/^https?:\/\/(www\.)?google\.[a-z.]+\/(goto|url)/i.test(r.url)) continue;
    const idx = hrefs.indexOf(r._href);
    if (idx < 0) continue;
    // 两个 Promise 都必须被 await/catch, 避免未处理 rejection 崩溃进程
    const popupPromise = ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null);
    let clicked = true;
    try {
      await anchors.nth(idx).click({ modifiers: ['Meta'], timeout: 4000 });
    } catch {
      clicked = false;
    }
    const popup = await popupPromise;
    if (!clicked && !popup) {
      // 点击本身失败: SERP 被同页带走则回退并终止, 否则留给 cite 兑底
      if (!page.url().includes('/search')) {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
        return;
      }
      continue;
    }
    if (popup) {
      try {
        await popup.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
        await popup.waitForTimeout(400);
        const finalUrl = popup.url();
        if (/^https?:\/\//i.test(finalUrl) && !/google\.[a-z.]+\/(goto|url|search)/i.test(finalUrl)) {
          r.url = finalUrl.split('#')[0];
        }
      } finally {
        await popup.close().catch(() => {});
      }
    } else if (!page.url().includes('/search')) {
      // 点击成功但无弹窗: 可能被同页导航, 回退 SERP 并终止
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
      return;
    }
  }
}

/** Google 结果收尾: 未解析成功的用 cite 估算, 仍无 URL 的丢弃; 私有字段清除 */
function finalizeGoogleResults(results) {
  const { citeToUrl } = require('../lib/parser');
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i];
    if (/google\.[a-z.]+\/(goto|url)\?/i.test(r.url)) {
      const cited = citeToUrl(r._cite || '');
      if (cited) r.url = cited;
      else {
        results.splice(i, 1);
        continue;
      }
    }
    delete r._cite;
    delete r._href;
  }
  // 以最终 URL 去重 (不同加密 token 可能指向同一目标)
  const seen = new Set();
  for (let i = results.length - 1; i >= 0; i--) {
    if (seen.has(results[i].url)) results.splice(i, 1);
    else seen.add(results[i].url);
  }
}

/** CLI 结束时关闭浏览器 (供 search.js 显式调用) */
async function shutdown() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  if (!b) return;
  // 附身模式与 launch 模式都用 close(): 前者仅断开连接不杀浏览器, 后者结束自建进程
  await b.close().catch(() => {});
}

module.exports = { search, shutdown, BlockedError, getCdpUrl };
