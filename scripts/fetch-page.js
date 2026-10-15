#!/usr/bin/env node
/**
 * fetch-page.js — 渲染任意 URL 并抽取正文 (websearch 技能第二命令)
 *
 * 用法:
 *   node fetch-page.js <url> [--format text|md|html] [--wait css] [--fullpage]
 *                       [--timeout ms] [--run module.js]
 *
 * --run 调用方注入: 加载 module.js 并在导航后以 ({page, browser, ctx, url,
 * attached}) 调用其导出的 async 函数; 模块接管页面后的全部行为 (默认抽取/
 * 验证页等待/延时关 tab 全部跳过)。返回 number=退出码; string/object=打印
 * (object 转 JSON), 退出码默认 0, 可用 {exit, out} 覆盖; 抛错退出 2。
 *
 * 退出码: 0 成功 | 2 失败 | 4 参数错误
 */
const os = require('os');
const path = require('path');

function parseArgs(argv) {
  const o = { format: 'text', fullpage: false, timeoutMs: 30000, url: '', wait: '', runModule: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format') o.format = argv[++i];
    else if (a === '--wait') o.wait = argv[++i];
    else if (a === '--fullpage') o.fullpage = true;
    else if (a === '--timeout') o.timeoutMs = parseInt(argv[++i], 10);
    else if (a === '--run') o.runModule = argv[++i];
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
      'script,style,noscript,iframe,svg,header,footer,nav,aside,' +
      'form[role="search"],form[class*="search" i],' +
      '[role=navigation],[role=banner],[role=complementary],' +
      '.nav,.menu,.sidebar,.footer,.header,.comment,.ad,.ads,.advert,' +
      '#comment,#comments,#sidebar,#nav,.related,.recommend';

    if (fullpage) {
      // 真实 DOM: cloneNode 脱离渲染树, innerText 恒为空(SPA 如 Jira 拿不到内容)
      // 本 tab 由脚本自建并在取数后延时关闭, 直接移除噪声再取 innerText
      document.querySelectorAll(noise).forEach((n) => n.remove());
      const text = (document.body?.innerText || document.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
      return text;
    }

    const clone = document.cloneNode(true);
    clone.querySelectorAll(noise).forEach((n) => n.remove());

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

/**
 * Detached helper source: sleep, then close the tab via raw CDP.
 * Runs as a background node process (parent exits right after the fetch), so
 * the caller is never blocked by the delay. Tolerates the tab having been
 * closed manually in the meantime (or the browser being gone): any failure
 * is swallowed -- a missing target just means there is nothing to close.
 */
const TAB_CLOSER_SRC = `
// node -e CODE A B C -> argv = [execPath, A, B, C] (no script-name placeholder)
const [cdpBase, targetId, delayMs] = process.argv.slice(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await sleep(Number(delayMs) || 300000);
  try {
    const ver = await (await fetch(cdpBase + '/json/version')).json();
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.send(JSON.stringify({ id: 1, method: 'Target.closeTarget', params: { targetId } }));
    await sleep(500);
    ws.close();
  } catch (e) { /* tab already closed manually, or browser gone */ }
  process.exit(0);
})();
`;

/** Schedule the tab to be closed after a grace period (default 5 min) instead
 * of immediately, so the user can glance at the page. WS_TAB_CLOSE_DELAY_MS
 * overrides the delay; falls back to an immediate close on any error. */
async function scheduleTabClose(cdpUrl, page) {
  try {
    const session = await page.context().newCDPSession(page);
    const { targetInfo } = await session.send('Target.getTargetInfo');
    const delay = Number(process.env.WS_TAB_CLOSE_DELAY_MS) || 300000;
    const { spawn } = require('child_process');
    const child = spawn(process.execPath,
      ['-e', TAB_CLOSER_SRC, cdpUrl, targetInfo.targetId, String(delay)],
      { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    await page.close().catch(() => {});
  }
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
    else if (!o.runModule) await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    // --run: hand the page to a caller-supplied module (injection hook for
    // page automation beyond fetching). The module owns everything after the
    // navigation -- default extraction, interstitial waiting and tab-close
    // scheduling are all skipped. Contract:
    //   module.exports = async ({ page, browser, ctx, url, attached }) =>
    //     number | string | { exit?: number, out?: string|object };
    // A number is the exit code; a string/object is printed (object as JSON)
    // with exit 0 unless `exit` overrides; thrown errors exit 2.
    if (o.runModule) {
      const mod = require(path.resolve(o.runModule));
      const r = await mod({ page, browser, ctx, url: o.url, attached });
      if (typeof r === 'number') return r;
      const exit = (r && typeof r === 'object' && Number.isInteger(r.exit)) ? r.exit : 0;
      const out = (r && typeof r === 'object') ? r.out : r;
      if (out !== undefined && out !== null) {
        console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
      }
      return exit;
    }

    // Verification/login interstitial detection (Atlassian step-up, MFA, SSO, captcha):
    // keep the tab OPEN and poll long enough for the user to complete it manually,
    // then re-extract once the page navigates away to real content.
    const isInterstitial = await page.evaluate(() => {
      const t = (document.body && document.body.innerText) || '';
      const u = location.href;
      return /Verify your identity|emailed you a code|verification code/i.test(t)
        || /login|signin|verifyidentity|sso|challenge/i.test(u);
    }).catch(() => false);

    if (isInterstitial) {
      const deadline = Date.now() + (Number(process.env.WS_VERIFY_WAIT_MS) || 300000); // default 5 min
      console.error('[fetch-page] verification/login page detected: tab left OPEN; waiting for manual completion (max ' + Math.round((deadline - Date.now()) / 1000) + 's, override with WS_VERIFY_WAIT_MS)...');
      while (Date.now() < deadline) {
        await page.waitForTimeout(5000);
        const still = await page.evaluate(() => {
          const t = (document.body && document.body.innerText) || '';
          return /Verify your identity|emailed you a code|verification code/i.test(t);
        }).catch(() => false);
        if (!still) break; // user completed verification; page navigated to content
      }
      // give the post-verification redirect a moment, then fall through to extraction
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    }

    if (o.format === 'html') {
      const html = await page.content();
      if (attached) await scheduleTabClose(cdp, page);
      console.log(html);
      return 0;
    }

    const text = await extractMain(page, o);
    if (!text) { console.error('[fetch-page] 未抽取到正文'); return 2; }
    console.log(text.slice(0, 50000));
    // attach 模式: 自建 tab 延时关闭(默认 5 分钟后,期间用户可回看/手动关闭);
    // 若正文疑似仍是验证/登录页(用户未在等待窗口内完成),保持 tab 打开以便人工继续
    if (attached) {
      const looksInterstitial = /Verify your identity|emailed you a code/i.test(text);
      if (!looksInterstitial) await scheduleTabClose(cdp, page);
      else console.error('[fetch-page] tab left open: page still on verification/login; complete it in the visible Chrome window and rerun');
    }
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
  --run module.js         调用方注入: 导航后将 page 交给模块接管 (见脚本头注释)

退出码: 0 成功 | 2 失败 | 4 参数错误`);
}

run().then((c) => process.exit(c)).catch((e) => { console.error('[fetch-page] 未预期错误:', e.message); process.exit(2); });
