/**
 * lib/parser.js — 各引擎 SERP HTML → SearchResult[]
 *
 * 选择器集中在此文件，引擎改版时只改这里。
 * 统一输出: { title, url, snippet, engine }
 */
const cheerio = require('cheerio');

/** 去除多余空白与零宽字符 */
function clean(s) {
  return (s || '')
    .replace(/[\u200b\u200e\u200f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 还原 DDG 的 uddg 重定向参数为目标 URL */
function unwrapDdg(href) {
  if (!href) return '';
  let u = href;
  if (u.startsWith('//')) u = 'https:' + u;
  try {
    const parsed = new URL(u);
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return uddg;
  } catch {
    /* 非 URL 形式, 原样返回 */
  }
  return u;
}

/** 规范化结果 URL: 仅保留 http(s), 剥离跟踪参数 */
function normalizeUrl(raw) {
  if (!raw) return '';
  let u = raw;
  if (u.startsWith('//')) u = 'https:' + u;
  if (!/^https?:\/\//i.test(u)) return '';
  try {
    const parsed = new URL(u);
    // Bing ck 跟踪链接: 尝试解码 u=a1<base64url> 段还原真实 URL
    if (/^(www\.)?bing\.com$/i.test(parsed.hostname) && /^\/ck\/a/.test(parsed.pathname)) {
      const m = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(u);
      if (m) {
        try {
          let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
          while (b64.length % 4) b64 += '=';
          const decoded = Buffer.from(b64, 'base64').toString('utf8');
          if (/^https?:\/\//.test(decoded)) return decoded.split('#')[0];
        } catch { /* fallthrough */ }
      }
      return ''; // 解不出的跟踪链接无引用价值
    }
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'rut', 'rn'].forEach(
      (p) => parsed.searchParams.delete(p)
    );
    return parsed.toString();
  } catch {
    return '';
  }
}

/** 解析 DDG Lite 结果页 */
function parseDdgLite(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('a.result-link').each((_, el) => {
    const $a = $(el);
    // snippet 是同表格中紧随其后的 result-snippet 单元格
    const $row = $a.closest('tr').next('tr').find('.result-snippet').first();
    const url = normalizeUrl(unwrapDdg($a.attr('href')));
    const title = clean($a.text());
    if (title && url) {
      out.push({ title, url, snippet: clean($row.text()), engine: 'ddg' });
    }
  });
  return dedupe(out);
}

/** 解析 Bing SERP（国际版与 cn 版结构一致: li.b_algo） */
function parseBing(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('#b_results li.b_algo').each((_, el) => {
    const $li = $(el);
    const $a = $li.find('h2 a').first();
    const snippet = clean($li.find('.b_caption p, p.b_lineclamp, .b_caption').first().text());
    const url = normalizeUrl($a.attr('href'));
    const title = clean($a.text());
    if (title && url) {
      out.push({ title, url, snippet, engine: 'bing' });
    }
  });
  return dedupe(out);
}

/** 还原 Google /url?q= 重定向为目标 URL */
function unwrapGoogle(href) {
  if (!href) return '';
  let u = href;
  if (u.startsWith('/url')) {
    try {
      const parsed = new URL('https://www.google.com' + u);
      const target = parsed.searchParams.get('q') || parsed.searchParams.get('url') || parsed.searchParams.get('continue');
      if (target) u = target;
    } catch { /* 保留原样 */ }
  }
  if (u.startsWith('//')) u = 'https:' + u;
  return u;
}

/** Google cite 显示 URL (如 "https://a.com › b › c") → 估算真实 URL; 不可靠时返回 '' */
function citeToUrl(cite) {
  let c = clean(cite);
  if (!c || c.includes('…')) return ''; // 被截断的路径段不可靠
  c = c.replace(/\s*›\s*/g, '/');
  if (/\s/.test(c)) return ''; // 残留空格说明结构异常
  if (!/^https?:\/\//i.test(c)) c = 'https://' + c.replace(/^\/+/, '');
  return normalizeUrl(c);
}

/** 解析 Google SERP (h3 为结果标题稳定锚点, 向上找链接、向下找摘要)
 *  注: 新版 Google 结果链接为加密 /goto?url=<token> 跳转, 解不出真实 URL;
 *      这里保留 _href (原姶 href, 供引擎层点击解析) 与 _cite (显示 URL, 兑底估算) */
function parseGoogle(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('#search h3, #rso h3, #main h3').each((_, el) => {
    const $h3 = $(el);
    const $a = $h3.closest('a');
    const href = $a.attr('href') || '';
    const title = clean($h3.text());
    if (!href || !title) return;
    if (/^\/search\?/.test(href)) return; // 站内链接(大家还在问/相关搜索)丢弃
    let url;
    if (/^https?:\/\//i.test(href)) url = normalizeUrl(href); // 少数直接外链
    else url = 'https://www.google.com' + href; // /goto?url= 加密跳转 → 引擎层解析
    if (!url) return;
    // 摘要: 从 h3 向上爬祖先, 找到包含摘要节点的那个结果容器
    // (标题与摘要在结果块的不同子树, 近层包装内找不到)
    const SNIP_SEL = 'div.VwiC3b, div[data-sncf], span.aCOpRe, .st';
    let $scope = $h3.parent();
    for (let hop = 0; hop < 16 && $scope.length && $scope[0].tagName !== 'body'; hop++) {
      if ($scope.find(SNIP_SEL).length) break;
      $scope = $scope.parent();
    }
    const snippet = clean($scope.find(SNIP_SEL).first().text());
    const cite = clean($scope.find('cite').first().text());
    out.push({
      title, url, snippet, engine: 'google',
      _href: href,
      _cite: cite,
    });
  });
  return dedupe(out);
}

/** 解析百度 SERP */
function parseBaidu(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('#content_left .result, #content_left div.c-container[id]').each((_, el) => {
    const $r = $(el);
    const $a = $r.find('h3 a').first();
    const rawHref = $a.attr('href') || '';
    let url;
    if (/^https?:\/\//i.test(rawHref) && !/baidu\.com\/link/.test(rawHref)) {
      url = normalizeUrl(rawHref); // 直接外链
    } else if (rawHref) {
      url = new URL(rawHref, 'https://www.baidu.com').toString(); // /link?url= 跳转链接, 标记待解析
    }
    const title = clean($a.text());
    const snippet = clean($r.find('.c-abstract, [class*="abstract"], .c-span9 p, .content-right').first().text());
    if (title && url) {
      out.push({ title, url, snippet, engine: 'baidu' });
    }
  });
  return dedupe(out);
}

/** 以规范化 URL 为键去重 */
function dedupe(results) {
  const seen = new Set();
  return results.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

const PARSERS = { ddg: parseDdgLite, bing: parseBing, baidu: parseBaidu, google: parseGoogle };

/** 引擎名 → 解析器入口 */
function parse(html, engine) {
  const fn = PARSERS[engine];
  if (!fn) throw new Error(`未知引擎: ${engine}`);
  return fn(html);
}

module.exports = { parse, parseDdgLite, parseBing, parseBaidu, parseGoogle, citeToUrl, normalizeUrl, unwrapDdg, unwrapGoogle, clean };
