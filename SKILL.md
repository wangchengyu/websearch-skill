---
name: websearch
description: Web search and page reading via real search engines (UAPI/DDG/Bing/Baidu). Use when the user needs external/current information, documentation lookup, fact verification, or anything requiring internet search. Provides structured results and full-page text extraction with anti-bot resilience. Supports CDP attach mode to reuse the user's real browser with login sessions.
---

# Web Search

Search the internet and read web pages. Four engines with automatic fallback plus an explicit real-browser Google engine, zero interactive prompts.

## Setup

Requires Node 22+. Dependencies are pre-installed in this skill's `node_modules/`. On a fresh machine only:

```bash
cd <skill directory> && npm install --omit=dev
npx playwright install chromium   # fallback browser (~150MB → ~/Library/Caches/ms-playwright)
```

## Commands

### Search

```bash
node scripts/search.js "query terms" [--json] [--limit N]
```

| Option | Meaning |
|--------|---------|
| `--engine auto\|uapis\|ddg\|bing\|baidu\|google` | `auto` is default: uapis first for both languages; then English `ddg→bing`, Chinese `bing→baidu`. `google` is **explicit-only** (never in auto chain) — see [Google real-browser search](#google-real-browser-search) |
| `--lang zh\|en` | Force language routing |
| `--json` | Structured output: `{query, engine, lang, count, results:[{title,url,snippet,engine}]}` |
| `--no-clean` | Disable Baidu ad-free suffix (李彦宏 marker) |

**Exit codes:** `0` ok · `2` all engines failed · `3` blocked by anti-bot → rephrase query or retry later · `4` bad args

**Always use `--json` for programmatic parsing; plain text otherwise.**

## Google real-browser search (routing rule)

**When the user explicitly says to search on Google** (phrases like 「用google搜」「google一下」「search Google for ...」「google it」), do NOT use the uapis API or other engines. Use the dedicated `google` engine, which drives a real browser to google.com and scrapes the SERP:

```bash
node scripts/search.js "query" --engine google --json --limit 10
```

Google is extremely sensitive to fresh/automated fingerprints (consent wall, CAPTCHA). **Always prefer CDP attach mode** for google searches — a bare `chromium.launch` context gets blocked most of the time. If `WS_CDP_URL` is not yet set, start the debug Chrome first (see [CDP attach mode](#cdp-attach-mode-reuse-the-users-real-browser)); the script prints a hint reminding you of this when no CDP URL is configured.

Blocked reasons specific to google: `google-consent` (EU consent wall — in attach mode just click Accept once in the visible tab), `google-captcha` / `google-unusual-traffic` (solve once in the visible tab, or retry later). In attach mode the tab is visible: when manual action is needed, tell the user, wait, then rerun the search.

### Read a page

```bash
node scripts/fetch-page.js <url> [--fullpage] [--wait css] [--format html]
```

Extracts main-content text (noise like nav/ads/comments removed). Use `--wait "css-selector"` for SPA pages that render late.

## Recommended workflow

1. Try plain `search.js "query" --json` first — the uapis aggregate engine handles ~90% of queries in ~1s without any browser.
2. If the site blocks reading or you need a login-walled page → use **CDP attach mode** (below), then `fetch-page.js <url>`.
3. Cite URL in your answer.

## CDP attach mode (reuse the user's real browser)

Default mode launches a fresh Chrome per run (no cookies, weak fingerprint → strong anti-bot sites block it).
Setting `WS_CDP_URL` attaches to a real Chrome the user controls instead — its login sessions and genuine
fingerprint are reused, so hard sites (百度安全验证, 知乎 403) pass naturally. The user can also log in
manually once inside the visible window; the session persists for all future runs.

### How to use (macOS)

```bash
# Step 1: start the dedicated Chrome with debug port (isolated profile, NOT the daily browser)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir="$HOME/chrome-ai-profile" &

# Step 2: verify the port is up
curl -s --max-time 3 http://127.0.0.1:9222/json/version

# Step 3: run any command in attach mode
export WS_CDP_URL="http://127.0.0.1:9222"
node scripts/search.js --engine baidu "query"
node scripts/fetch-page.js https://zhuanlan.zhihu.com/p/xxxxx
```

(Windows paths differ, e.g. `C:\Program Files\Google\Chrome\Application\chrome.exe` — see README.md.)

### Rules in attach mode

- Only open/close your own tabs; never close, restart, or navigate the user's existing tabs.
- Never overwrite UA/locale/fingerprint and skip stealth injection — attaching is only useful because the profile looks human.
- In attach mode new pages are created via `browser.contexts()[0].newPage()`.
- `shutdown()` must only disconnect (`browser.close()` on a CDP connection), never kill the browser process.
- A fetched tab is NOT closed immediately: fetch-page.js schedules its close 5 minutes later (grace period so the user can review the page; `WS_TAB_CLOSE_DELAY_MS` overrides). The delayed close runs in a detached background process — the caller returns immediately, and a tab closed manually during the window is tolerated silently.
- If a site needs login/验证码: open that site in a new tab, tell the user, wait for them to finish, then proceed.
- Unset `WS_CDP_URL` env var after finishing if other work should return to default launch mode.

### When to choose which

| Situation | Mode |
|-----------|------|
| General search, uapis reachable | No browser at all |
| User explicitly asks for **Google** | Browser via `--engine google` (CDP attach preferred) |
| Site blocks fetch, no login needed | Launch (default headless-off, visible window) |
| Login-walled content (知乎专栏, 百度账号区) or persistent blocks | **CDP attach** + user logs in once |

## Etiquette / constraints

- These are polite-rate-limited tools: the same engine enforces a minimum interval across runs (state file under `~/.pi/websearch-skill/`). If you get exit code 3 (blocked), **do not hammer retries** — space them out or switch engines.
- Do not run searches in tight loops. Batch questions into one query when possible.
- Baidu engine automatically appends a cleanliness suffix to queries internally; the JSON `query` field always shows your original input.

## Environment notes

- macOS host: launch mode drives the system Chrome at `/Applications/Google Chrome.app` via `channel: 'chrome'`; the Playwright Chromium fallback lives in `~/Library/Caches/ms-playwright` (run `npx playwright install chromium` if missing).

- System proxy (`HTTPS_PROXY` env var) is honored automatically for HTTP requests (fetch requires Node ≥22 with `NODE_USE_ENV_PROXY=1`; search.js re-execs itself with it when needed).
- Browser traffic follows OS proxy settings.
- `UAPIS_API_KEY` **required** for authenticated uapis.cn API access — set it in your shell profile (`export UAPIS_API_KEY=uapi-xxx` in `~/.zshrc`); if unset the engine first tries an unauthenticated request and errors with setup instructions when rejected.
- `WS_HEADLESS=1` forces headless (CI); omit it so the user can watch what happens.
