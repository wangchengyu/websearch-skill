/**
 * lib/detector.js — 风控/异常页判定
 *
 * 返回 { blocked: boolean, reason: string }
 * 规则来自 tests/fixtures/*.html 中的真实风控快照。
 */
const EMPTY = { blocked: false, reason: '' };

function detect(html) {
  const h = html || '';

  // DDG anomaly challenge（fixture: ddg-anomaly.html, 标记 anomaly/challenge）
  if (/anomaly/i.test(h) && /challenge|verify|unusual traffic/i.test(h)) {
    return { blocked: true, reason: 'ddg-anomaly-challenge' };
  }

  // 百度安全验证（fixture: baidu-captcha-http.html）
  if (/<title>[^<]*百度安全验证/.test(h) || /wappass\.baidu\.com/.test(h)) {
    return { blocked: true, reason: 'baidu-security-verify' };
  }

  // Bing 人机校验页（无 b_algo 且含验证特征）
  if (!/b_algo/.test(h) && /(verify you are human|prove.{0,20}human|complete the security check)/i.test(h)) {
    return { blocked: true, reason: 'bing-human-verify' };
  }

  // Google 风控页特征（同意页 / 人机验证 / 异常流量）
  if (/consent\.google\.com|before you continue to Google/i.test(h)) {
    return { blocked: true, reason: 'google-consent' };
  }
  if (/www\.google\.com\/search/i.test(h) && /(recaptcha|g-recaptcha|not a robot)/i.test(h)) {
    return { blocked: true, reason: 'google-captcha' };
  }
  if (/our systems have detected unusual traffic/i.test(h)) {
    return { blocked: true, reason: 'google-unusual-traffic' };
  }

  return EMPTY;
}

module.exports = { detect };
