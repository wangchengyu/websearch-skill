#!/usr/bin/env node
/**
 * search.js — websearch 技能搜索主入口
 *
 * 用法:
 *   node search.js "<query>" [--engine auto|ddg|bing|baidu|google] [--limit N]
 *                   [--lang zh|en] [--json] [--no-clean] [--timeout ms]
 *
 * 退出码: 0 成功 | 2 全部引擎失败 | 3 被风控 | 4 参数错误
 */
const path = require('path');
const os = require('os');

// ---- 代理保障: DDG 在部分网络仅代理可达 -------------------------------
// Node 22 的 fetch 读环境变量代理需要 NODE_USE_ENV_PROXY=1 (实验特性)。
// 若检测到代理环境变量但该标志缺失, 以增强环境重启自身一次。
function ensureProxyEnv() {
  const hasProxy = !!(
    process.env.HTTPS_PROXY || process.env.HTTP_PROXY ||
    process.env.https_proxy || process.env.http_proxy
  );
  if (hasProxy && !process.env.NODE_USE_ENV_PROXY && process.env.WS_REEXEC !== '1') {
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, NODE_USE_ENV_PROXY: '1', WS_REEXEC: '1' },
    });
    process.exit(r.status ?? 0);
  }
}

/** 入口包装: 统一回收浏览器进程 */
async function main() {
  ensureProxyEnv();
  let code = 2;
  try {
    code = await run();
  } catch (e) {
    console.error('[websearch] 未预期错误:', e.message);
    code = 2;
  } finally {
    await require('./engines/browser-engine').shutdown();
  }
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    query: '',
    engine: 'auto',
    limit: 8,
    lang: '',            // 空 = 自动检测
    json: false,
    noClean: false,
    timeoutMs: 25000,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--engine') opts.engine = argv[++i];
    else if (a === '--limit') opts.limit = parseInt(argv[++i], 10);
    else if (a === '--lang') opts.lang = argv[++i];
    else if (a === '--timeout') opts.timeoutMs = parseInt(argv[++i], 10);
    else if (a === '--json') opts.json = true;
    else if (a === '--no-clean') opts.noClean = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (!a.startsWith('--')) opts.query += (opts.query ? ' ' : '') + a;
    else return { error: `未知参数: ${a}` };
  }
  return { opts };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) return fail(4, args.error);
  const opts = args.opts;

  if (opts.help) {
    printUsage();
    return 0;
  }
  if (!opts.query) return fail(4, '缺少查询词');
  if (!['auto', 'uapis', 'ddg', 'bing', 'baidu', 'google'].includes(opts.engine)) return fail(4, `无效引擎: ${opts.engine}`);

  const routing = require('./lib/routing');
  const output = require('./lib/output');
  const sanity = require('./lib/sanity');
  const { sleep } = require('./lib/ratelimit');

  const lang = opts.lang || routing.detectLang(opts.query);
  const chain = opts.engine === 'auto' ? routing.autoChain(lang) : [opts.engine];

  // 状态文件: 全局目录, 跨会话节流
  const stateDir = path.join(
    process.env.USERPROFILE || process.env.HOME || os.homedir(),
    '.pi', 'websearch-skill'
  );
  const statePath = path.join(stateDir, 'state.json');

  const errors = [];
  for (let idx = 0; idx < chain.length; idx++) {
    const engine = chain[idx];
    try {
      let results;
      if (engine === 'uapis') {
        results = await require('./engines/uapis').search(opts.query, {
          limit: opts.limit, statePath, timeoutMs: Math.min(opts.timeoutMs, 15000),
        });
      } else if (engine === 'ddg') {
        results = await require('./engines/ddg-http').search(opts.query, {
          limit: opts.limit, lang, statePath, timeoutMs: Math.min(opts.timeoutMs, 15000),
        });
      } else {
        results = await require('./engines/browser-engine').search(engine, opts.query, {
          limit: opts.limit, lang, statePath, timeoutMs: opts.timeoutMs, noClean: opts.noClean,
        });
      }

      // 相关性前置校验: 引擎返回结构合法但内容无关的结果 → 同风控处理
      if (results.length > 0 && !sanity.isRelevant(opts.query, results)) {
        throw Object.assign(new Error('结果与查询无关 (疑似反爬垃圾页)'), {
          name: 'BlockedError', reason: 'irrelevant-serp',
        });
      }

      // 零结果且还有下一引擎 → 降级
      if (results.length === 0 && idx < chain.length - 1) {
        errors.push(`${engine}: 0 结果`);
        await sleep(500 + Math.random() * 1000);
        continue;
      }

      emit(results, opts, { query: opts.query, engine, lang });
      return 0;
    } catch (e) {
      const blocked = e.name === 'BlockedError';
      errors.push(`${engine}: ${e.message}`);
      if (idx < chain.length - 1) {
        await sleep(500 + Math.random() * 1000);
      } else {
        if (!opts.json) {
          console.error(output.formatError(
            errors.join('; '),
            blocked ? '请换关键词或稍后重试' : '检查网络或指定 --engine'
          ));
        } else {
          console.log(output.formatJson([], { query: opts.query, error: e.message }));
        }
        return blocked ? 3 : 2;
      }
    }
  }
  return 2;
}

function emit(results, o, meta) {
  if (o.json) console.log(require('./lib/output').formatJson(results, meta));
  else console.log(require('./lib/output').formatText(results));
}

function fail(code, msg) {
  console.error(`[websearch] 参数错误: ${msg}`);
  return code;
}

function printUsage() {
  console.log(`用法: node search.js "<query>" [options]

options:
  --engine auto|uapis|ddg|bing|baidu|google
                                 引擎/降级链 (默认 auto)
                                 auto: en=uapis→ddg→bing, zh=uapis→bing→baidu
                                 uapis 聚合引擎直连稳定、带相关性评分，为首选
                                 google 真实浏览器检索 google.com, 不进 auto 链;
                                 用户点名“用google搜”时使用, 建议配合 WS_CDP_URL 附身模式
  --limit N                      结果条数 (默认 8)
  --lang zh|en                   强制语言路由 (默认自动检测)
  --json                         JSON 输出 (含 query/engine/lang 元数据)
  --no-clean                     关闭百度净化后缀(李彦宏标记)
  --timeout ms                   单引擎超时 (默认 25000)

退出码: 0 成功 | 2 全部失败 | 3 被风控 | 4 参数错误`);
}

main();
