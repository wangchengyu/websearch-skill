#!/usr/bin/env node
/**
 * fetch-page.js — 渲染任意 URL 并抽取正文 (websearch 技能第二命令)
 *
 * 用法:
 *   node fetch-page.js <url> [--format text|md|html] [--wait css] [--fullpage]
 *                       [--timeout ms]
 *
 * 退出码: 0 成功 | 2 失败 | 4 参数错误
 */
const os = require('os');
const path = require('path');

function parseArgs(argv) {
  const o = { format: 'text', fullpage: false, timeoutMs: 30000, url: '', wait: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format') o.format = argv[++i];
    else if (a === '--wait') o.wait = argv[++i];
    else if (a === '--fullpage') o.fullpage = true;
    else if (a === '--timeout') o.timeoutMs = parseInt(argv[++i], 10);
    else if (a === '-h' || a === '--help') o.help = true;
    else if (!a.startsWith('--')) o.url = a;
    else return { error: `未知参数: ${a}` };
  }
  return { o };
}

/** 正文抽取: 去除噪声节点后取最大文本密度区域 */
function extractMain(page, opts) {
  return page.evaluate(({ fullpage }) => {
    const noise =
      'script,style,noscript,iframe,svg,header,footer,nav,aside,form,' +
      '[role=navigation],[role=banner],[role=complementary],' +
      '.nav,.menu,.sidebar,.footer,.header,.comment,.ad,.ads,.advert,' +
      '#comment,#comments,#sidebar,#nav,.related,.recommend';

    const clone = document.cloneNode(true);
    clone.querySelectorAll(noise).forEach((n) => n.remove());

    if (fullpage) {
      const text = (clone.body?.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
      return text;
    }

    // 正文候选打分: 文本长度 / 层级深度
    const candidates = Array.from(clone.querySelectorAll('article,main,[role=main],.content,#content,.post,.article,.entry'));
    let best = null, bestScore = 0;
    for (const el of candidates.length ? candidates : [clone.body]) {
      const t = el.innerText || el.textContent || '';
      const depth = depthOf(el);
      const score = t.length / Math.max(depth, 1);
      if (t.length > bestScore) { bestScore = t.length; best = el; }
    }
    const text = (best ? best.innerText || best.textContent : '').replace(/\n{3,}/g, '\n\n').trim();
    function depthOf(el) {
      let d = 0;
      while ((el = el.parentElement)) d++;
      return d;
    }
    return text;
  }, { fullpage: opts.fullpage });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.error(`[fetch-page] 参数错误: ${args.error}`); return 4; }
  const o = args.o;
  if (o.help) { printUsage(); return 0; }
  if (!o.url) { console.error('[fetch-page] 缺少 URL'); return 4; }
  if (!/^https?:\/\//i.test(o.url)) o.url = 'https://' + o.url;

  const { chromium } = require('playwright');
  let browser;
  let attached = false;
  try {
    // CDP 附身模式: 复用用户真实浏览器(登录态/指纹)
    const cdp = process.env.WS_CDP_URL;
    if (cdp) {
      browser = await chromium.connectOverCDP(cdp, { timeout: 8000 });
      attached = true;
    } else {
      // 默认有头(用户可见); WS_HEADLESS=1 时无头
      browser = await chromium.launch({
        channel: 'chrome',
        headless: process.env.WS_HEADLESS === '1',
        args: ['--disable-blink-features=AutomationControlled'],
      });
    }
    const ctx = attached
      ? (browser.contexts()[0] || await browser.newContext())
      : await browser.newContext({ locale: 'zh-CN' });
    const page = await ctx.newPage();
    await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));

    await page.goto(o.url, { waitUntil: 'domcontentloaded', timeout: o.timeoutMs });
    if (o.wait) await page.waitForSelector(o.wait, { timeout: 10000 }).catch(() => {});
    else await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    if (o.format === 'html') {
      console.log(await page.content());
      return 0;
    }

    const text = await extractMain(page, o);
    if (!text) { console.error('[fetch-page] 未抽取到正文'); return 2; }
    console.log(text.slice(0, 50000));
    return 0;
  } catch (e) {
    console.error(`[fetch-page] 失败: ${e.message.split('\n')[0]}`);
    return 2;
  } finally {
    if (browser) {
      // 附身模式仅断开连接(不关浏览器); launch 模式结束自建进程
      await browser.close().catch(() => {});
    }
  }
}

function printUsage() {
  console.log(`用法: node fetch-page.js <url> [options]

options:
  --format text|md|html   输出格式 (默认 text, md 为简易文本化)
  --wait css              显式等待选择器 (SPA 页面)
  --fullpage              全页文本而非正文区块
  --timeout ms            页面加载超时 (默认 30000)

退出码: 0 成功 | 2 失败 | 4 参数错误`);
}

run().then((c) => process.exit(c)).catch((e) => { console.error('[fetch-page] 未预期错误:', e.message); process.exit(2); });
