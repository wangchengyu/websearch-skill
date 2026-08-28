# skill-websearch

pi coding agent 的网页搜索技能：HTTP 快路径 + Playwright 浏览器兜底，附带正文渲染抓取。

## 特性

- **四引擎**：UAPI 聚合搜索（Level 0 首选，直连稳定、带相关性评分）/ DuckDuckGo Lite（纯 HTTP）/ Bing / 百度（真实 Chrome 渲染）
- **语言感知路由**：默认 uapis 首选；之后中文 `bing→baidu`、英文 `ddg→bing`
- **API Key**：通过环境变量 `UAPIS_API_KEY` 提供（写入 `~/.zshrc`：`export UAPIS_API_KEY=uapi-xxx`）；未设置时尝试免鉴权请求，被拒则报错提示
- **百度净化模式**：自动追加「李彦宏」后缀规避广告（[2025-01 网络热点技巧](https://www.163.com/dy/article/JLAOEB3E051492T3.html)），`--no-clean` 关闭
- **反爬韧性**：webdriver 标志抹除、系统 Chrome、跨进程节流、风控显式报错（不静默给假结果）
- **相关性前置校验**：引擎返回结构合法但无关的垃圾 SERP 时视同风控降级
- **百度跳转链接解析**：搜索结果中的 `/link?url=` 临时链接在同会话内自动还原为真实 URL
- **默认有头浏览器**：浏览器操作默认可见窗口便于观察；设 `WS_HEADLESS=1` 切换无头模式
- **fetch-page**：任意 URL 正文抽取，导航/广告/评论噪声剔除

---

## 部署为 pi Skill

### 方式一：复制部署（推荐，全局可用）

前置条件：Node.js ≥ 22，系统已装 Chrome。

```bash
# 1. 进入项目目录，安装依赖（生成 node_modules）
cd Z:/Users/projects/02.learning/skill-websearch
npm install --omit=dev

# 2. 部署到 pi 全局技能目录
#    Windows (Git Bash/PowerShell 均可)
mkdir -p ~/.pi/agent/skills
cp -r . ~/.pi/agent/skills/websearch

#    部署内容 = SKILL.md + scripts/ + node_modules/ + package.json
#    （tests/ DESIGN.md 等开发文件不复制也不影响运行）
```

> 省流量做法：只复制运行时必需的 5 个部分 —— `SKILL.md`、`package.json`、`scripts/`、
> 运行 `npm install --omit=dev playwright cheerio` 在目标目录重新安装依赖。
> Playwright 浏览器二进制 (~400MB) 存放在 `%LOCALAPPDATA%\ms-playwright`，
> 多个技能/项目共享同一份，无需重复下载；首次缺失时执行 `npx playwright install chromium` 补齐。

### 方式二：pi package 安装（通过 git）

项目若推送到 GitHub/GitLab 仓库并带 `pi` 清单（见下节），可：

```bash
pi install git:github.com/<you>/skill-websearch
```

### 方式三：仅当前项目可见（项目级技能）

在某个项目的 `.pi/skills/` 下放置：

```bash
mkdir -p <目标项目>/.pi/skills
cp -r . <目标项目>/.pi/skills/websearch
```

注意：项目级技能首次加载时 pi 会询问是否信任该项目目录。

### 方式四：settings.json 指向任意路径（免复制）

编辑 `~/.pi/agent/settings.json`：

```json
{
  "skills": ["Z:/Users/projects/02.learning/skill-websearch"]
}
```

适合边开发边用（改完即时生效，无需同步副本）。缺点是换机器路径失效。

### 验证部署

```bash
# 目录抽查: SKILL.md 必须存在于技能根目录
ls ~/.pi/agent/skills/websearch/SKILL.md

# 实弹验证 CLI 本身可独立工作
node ~/.pi/agent/skills/websearch/scripts/search.js "test" --json --limit 2
```

然后重启 pi 或在 pi 内执行 `/reload`：
- 启动头部应出现 `websearch` 技能名
- 对话中直接说「帮我搜一下 XXX」即可自动触发
- 手动调用：`/skill:websearch 搜索词`

### 升级与卸载

```bash
# 升级 = 重新覆盖（保留状态文件）
cp -r SKILL.md scripts ~/.pi/agent/skills/websearch/

# 卸载
rm -rf ~/.pi/agent/skills/websearch
# 节流状态文件如一并清除:
rm -rf ~/.pi/websearch-skill
```

### 打包为 pi package（可选）

若要通过 `pi install npm:<pkg>` / `git:` 分发，在 `package.json` 增加 `pi` 清单：

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "skills": ["./"]
  }
}
```

`skills` 条目指向包含 SKILL.md 的目录；之后他人执行 `pi install npm:@you/skill-websearch`
即可获得完全相同的能力，pi 会把它装入 `~/.pi/agent/npm/` 并自动注册技能。

---

## 跨平台迁移：打压缩包带去 macOS / Linux

代码本身是纯 JavaScript + 相对路径，**跨平台兼容**。但不要直接把整个目录压过去 ——
`node_modules` 里的 playwright-core 驱动是按平台分的，浏览器二进制也不在项目里。
正确做法：

### 步骤 1：Windows 上打干净包（排除 node_modules）

```bash
cd Z:/Users/projects/02.learning/skill-websearch
zip -r websearch-skill.zip . \
    -x "node_modules/*" -x "*.zip" -x "ppt-assets/*"
```

得到的包仅几百 KB（SKILL.md + scripts/ + tests/ + 配置），拷到目标机解压。

### 步骤 2：macOS 上安装依赖与浏览器

```bash
unzip websearch-skill.zip -d websearch && cd websearch
npm install                     # 自动下载 macOS 版 playwright-core / cheerio
npx playwright install chromium # macOS 版浏览器二进制 (~150MB, 存 ~/Library/Caches/ms-playwright)
node scripts/search.js "test" --json --limit 2   # 能返回结果即 OK
```

> Linux 同理；无系统 Chrome 时 launch 模式会自动回退到 Playwright 自带 Chromium。

### 步骤 3：macOS 路径差异对照

| 项目 | Windows | macOS |
|------|---------|-------|
| Chrome 可执行文件 | `C:\\Program Files\\Google\\Chrome\\...` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| Playwright 浏览器缓存 | `%LOCALAPPDATA%\\ms-playwright` | `~/Library/Caches/ms-playwright` |
| 节流状态目录 | `%USERPROFILE%\\.pi\\websearch-skill` | `~/.pi/websearch-skill`（代码自动适配） |
| pi 全局技能目录 | `%USERPROFILE%\\.pi\\agent\\skills` | `~/.pi/agent/skills` |

搜索/抓取核心逻辑无需任何修改 —— `channel: 'chrome'` 会让 Playwright 自动定位各平台的系统 Chrome。

### 步骤 4：CDP 附身模式的 Mac 写法

```bash
# 启动带调试端口的 Chrome (仅路径不同，其余参数一致)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --remote-debugging-port=9222 --user-data-dir="$HOME/chrome-ai-profile" &

export WS_CDP_URL="http://127.0.0.1:9222"
node scripts/fetch-page.js https://zhuanlan.zhihu.com/p/xxxxx
```

### 附：同架构机器间的整包快速拷贝（不推荐跨平台用）

若两台都是 Windows x64 且想省去目标机的 `npm install`，可整包压缩后拷贝。
**Windows ↔ macOS 之间禁止此法** —— 必须按步骤 2 在目标机重装依赖。

### CDP 附身模式（复用你自己的浏览器）

默认 launch 模式每次拉起全新 Chrome。设置 `WS_CDP_URL` 后改为连接已开启调试端口的真实浏览器，
完整保留登录态与真实指纹 —— 强风控站点（百度安全验证、知乎 403）可直接通过：

```powershell
# 步骤1: 以调试端口启动 Chrome (独立配置目录, 与日常上网隔离)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" \`
    --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\chrome-ai-profile"

# 步骤2: 附身模式运行
$env:WS_CDP_URL = "http://127.0.0.1:9222"
node scripts/search.js --engine baidu "查询词"
```

行为差异：
- 附身模式**不会**覆写 UA/locale 指纹，不注入隐身脚本（保持自然）
- 搜索用的标签页用完即关，但**绝不关闭或重启你的浏览器**
- 首次遇到需要登录的站点时，在可见窗口中手动登录一次，之后 AI 自动复用会话

> ⚠️ 安全提示：调试端口对本机所有进程开放。仅本地使用时开启，不要把 9222 端口暴露到公网。


---

## 使用

```bash
# 搜索（自动路由: 中文→bing→baidu, 英文→ddg→bing）
node scripts/search.js "renpy 8 new features" --json

# 指定引擎 / 语言路由
node scripts/search.js --engine baidu "python 教程"
node scripts/search.js --engine uapis "steam deck"   # 聚合引擎(首选)
node scripts/search.js --lang en "steam deck review"

# 读页面正文（浏览器默认有头可见, WS_HEADLESS=1 无头）
node scripts/fetch-page.js https://example.com
node scripts/fetch-page.js https://spa-site.com --wait ".main-content"
```

| search.js 参数 | 说明 |
|---|---|
| `--engine auto\|ddg\|bing\|baidu\|google` | 引擎或降级链 (`google` 仅显式指定时使用, 走真实浏览器+CDP) |
| `--limit N` | 结果条数（默认 8） |
| `--json` | 输出 `{query, engine, lang, count, results[]}` |
| `--no-clean` | 关闭百度净化后缀 |
| `WS_HEADLESS=1` | 无头模式环境变量 |

退出码：`0` 成功 · `2` 失败 · `3` 被风控（应稍后重试）· `4` 参数错误。

## 开发

```bash
npm test          # 离线单测 (35 用例, <1s, 含 fixture 快照测试)
npm run test:live # 联网冒烟 (RUN_LIVE=1)
node tests/fixtures/collect.js  # 重新采集 SERP fixtures（反爬快照会过期）
```

设计文档见 [DESIGN.md](DESIGN.md)，测试规划见 [TESTPLAN.md](TESTPLAN.md)。

## License

MIT。搜索引擎结果版权归各引擎所有，本工具仅做轻量自动化访问。
