# pi-xai 扩展包功能盘点（面向 DSH 移植）

> 目标：将 pi-xai (v0.18.0) 的能力移植到 DeepSeek Harness（DSH，Cordis 插件式 agent 框架）。
> 本报告为只读调研产物：逐模块职责、完整注册面、凭据体系、可复用/绑定判定、DSH 移植映射。
> 仓库：`A:\Workspace\dsh-pi-xai`，分支 `dsh`（已检出远端 main，纯 TypeScript）。
> 依赖：peerDependencies = `@earendil-works/pi-ai >=0.80.0`、`@earendil-works/pi-coding-agent >=0.80.0`；deps 仅 `typebox`。

---

## 0. 架构总览

- 入口 `index.ts` 导出一个 `export default async function (api: ExtensionAPI)`，即 Pi 的单入口扩展函数。
- 内部模块按职责拆分：config/oauth/stream/provider/images/image-gen/video-gen/vision/goal/plan-mode/prompt-suggest/usage-status/web-fetch。
- 核心协议是 **xAI Responses API**（`POST /responses`），同时兼容 **Grok CLI 订阅代理**（`https://cli-chat-proxy.grok.com/v1`，需额外 CLI 身份头）与 **公开 API**（`https://api.x.ai/v1`，API key）。
- 底部状态栏 / 文本幽灵 / UI 提示依赖 Pi 的 `ctx.ui` 抽象；Provider 注册依赖 Pi 的 `registerProvider` OAuth 结构。

### Pi ExtensionAPI 使用面（index.ts + 各模块实际用到的 API）

| 方法 | 用途 |
|---|---|
| `api.registerProvider(name, config)` | 注册 `grok-build` provider（openai-responses + OAuth） |
| `api.registerTool(defineTool({...}))` | 注册 10 个工具（见 §2.2） |
| `api.registerCommand(name, {...})` | 注册 12+ 条命令（见 §2.3） |
| `api.on(hook, cb)` | 挂 8 类事件 hook（见 §2.4） |
| `api.getActiveTools()` / `api.setActiveTools()` | plan mode 下临时收缩/恢复活动工具集 |
| `defineTool` | 工具定义包装（typebox `Type.Object` 参数 schema） |
| `ctx.ui.notify(msg, level)` | 通知横幅（info/warning/error） |
| `ctx.ui.setStatus(key, text)` / `ctx.ui.theme.fg("dim", text)` | 底部状态栏 |
| `ctx.ui.setWidget(key, ...)` / `ctx.ui.getEditorText()` / `ctx.ui.setEditorText()` | 文本幽灵（prompt suggest） |
| `ctx.sessionManager.getSessionId()` | 会话 id → `prompt_cache_key` / `x-grok-conv-id` |
| `ctx.cwd` | 工作目录（图片路径解析、plan 文件） |
| `ctx.model` (id/provider/input/baseUrl) | 路由判断、usage status |
| `ctx.signal` | 请求取消 |
| `ctx.sendUserMessage?.(text)` | 向用户注入一条消息（/goal、/imagine、/plan 委托模型执行） |
| `ctx.hasUI` | 无 UI 检测（usage status 跳过绘制） |
| `api.registerProvider` 的 `oauth` 结构 | `{name, usesCallbackServer, login, refreshToken, getApiKey}` |

---

## 1. 逐模块职责、签名、依赖、Pi API 使用

### 1.1 `xai-config.ts` — 配置与特性开关（约 183 行）

**职责**：读取 Pi 设置（user `~/.pi/agent/settings.json` + project `.pi/settings.json` 的 `xai` 命名空间），解析 baseUrl 与各类布尔功能开关；Groki 模型 id 归一化。

**关键导出/签名**：
- 常量 `XAI_API_BASE = "https://api.x.ai/v1"`；`XAI_CLI_BASE = "https://cli-chat-proxy.grok.com/v1"`
- `USER_PI_SETTINGS_PATH`、`PROJECT_PI_SETTINGS_PATH`
- `getPiSettingsPaths(): {user, project}`
- `resolveXaiConfig(): ResolvedXaiConfig`（`{xai:{baseUrl, text: Record}}`；user 与 project 合并，project 优先；默认 baseUrl=CLI 代理）
- `grokModelId(model: string): string`（取 '/' 后段、小写）
- `grokSupportsReasoningEffort(model): boolean`——prefix 命中 `[grok-3-mini, grok-4.20-multi-agent, grok-4.6, grok-4.5, grok-4.3]`
- `grokWantsEncryptedReasoningInclude(model): boolean`——非 `grok-build*` 且（支持 reasoning effort 或含 "reasoning"）时 true
- `getAgenticConfig(config): {enabled, tools: string[]}`——`xai.text.agentic`（false 关；`agenticTools` string[] 覆盖；默认 `["web_search","x_search","code_interpreter"]`）
- `isMultiAgentToolEnabled(config=resolveXaiConfig()): boolean`——默认开，`xai.text.multiAgent:false` 关
- `isImageGenEnabled(config): boolean`——默认开，`xai.text.imageGen:false` 关
- `isVideoGenEnabled(config): boolean`——默认开；`videoGen:false` 关；装了兄弟包 `pi-xai-imagine` 则关
- `isSiblingPackageListed(name): boolean`（扫 settings.json 的 `packages[]`）
- `isUsageStatusEnabled(config): boolean`——默认**关**，`xai.text.usageStatus:true/statusbar` 开
- `setUsageStatusEnabled(enabled, settingsPath=USER)`——持久化到用户设置

**依赖**：仅 node:fs/os/path。**不使用** ExtensionAPI（纯函数）。

### 1.2 `xai-stream.ts` — Grok CLI 代理请求头（约 65 行）

**职责**：生成 Grok CLI 订阅代理所需的静态身份头 + 会话亲和头。

**关键导出**：
- `GROK_CLI_VERSION = "0.2.101"`（需随官方 CLI 联动 bump）
- `GROK_CLI_CLIENT_IDENTIFIER = "grok-shell"`；`GROK_CLI_TOKEN_AUTH = "xai-grok-cli"`
- `grokCliUserAgent(version?): string` → `grok-shell/0.2.101 (os; arch)`
- `isGrokCliProxyBaseUrl(baseUrl): boolean`（hostname === `cli-chat-proxy.grok.com`）
- `grokCliModelHeaders(modelId): Record<string,string>`——含 `x-grok-client-identifier/version/mode`、`x-xai-token-auth`、`x-authenticateresponse: authenticate-response`、`x-grok-model-override`
- `xaiRequestHeaders(modelId, baseUrl, sessionId?): Record`——==代理向请求合并 `grokCliModelHeaders` + `x-grok-conv-id`；公开 API 返回 `{}`

**依赖**：node:os。**不使用** ExtensionAPI。

### 1.3 `xai-oauth.ts` — 凭据体系（约 1701 行，重点）

**职责**：xAI Grok Build OAuth（Web PKCE + Device Code）、Grok CLI 导入、多来源凭据解析、JWT 过期判断、billing/usage 查询与格式化。

**关键导出（细目）**：
- OAuth 常量：`XAI_OAUTH_ISSUER=https://auth.x.ai`、`XAI_OAUTH_DEVICE_CODE_URL=https://auth.x.ai/oauth2/device/code`、`XAI_OAUTH_TOKEN_URL=https://auth.x.ai/oauth2/token`、`XAI_OAUTH_CLIENT_ID=b1a00492-073a-47ea-816f-4c329264a828`、`XAI_OAUTH_SCOPE="openid profile email offline_access grok-cli:access api:access conversations:read conversations:write"`、`XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS=3600`（JWT 提前 1h 刷新）
- PKCE：`XAI_OAUTH_REDIRECT_HOST=127.0.0.1`、`XAI_OAUTH_REDIRECT_PORT=56121`、`XAI_OAUTH_REDIRECT_PATH=/callback`、`XAI_OAUTH_DISCOVERY_URL`
- `GROK_CLI_AUTH_PATH = ~/.grok/auth.json`（可变，测试可注入）、`PI_AUTH_PATH = ~/.pi/agent/auth.json`（可变）
- `XaiAuthError`（`reloginRequired:boolean` + `code:string`）
- `decodeJwtPayload(token): Record|null`
- `isXaiAccessTokenExpiring(accessToken, skewSeconds=3600): boolean`——依据 JWT `exp`（真实源）
- `isXaiStaleTokenError(text): boolean`（`[wke=unauthenticated:` 或 `oauth2 access token could not be validated`）
- `isXaiEntitlementError(text): boolean`（未激活订阅/资源耗尽/无权限字眼，且非 stale）
- `readGrokCliAuth(): GrokCliAuth|undefined`（解析 auth.json 主键 `https://auth.x.ai::<clientid>` 与 legacy scope key）
- `parseCallbackInput(input): CallbackResult|undefined`（full URL / ?query / bare code 三态）
- `loginXai(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>`——主登录入口（详情见 §3）
- `refreshXaiToken(credentials): Promise<OAuthCredentials>`
- `getXaiApiKeyFromCredentials(cred): string`（返回 `cred.access`）
- billing/usage：`GROK_BUILD_BILLING_URL=https://cli-chat-proxy.grok.com/v1/billing`、`GROK_USAGE_PAGE_URL=https://grok.com/?_s=usage`；类型 `MonthlyUsage{monthlyLimit,used,billingPeriodEnd}`、`WeeklyUsage{creditUsagePercent,billingPeriodEnd}`、`BillingUsage{monthly,weekly?}`；别名 `GrokBuildBilling`（deprecated）
- `usageProgressBar(percentLeft, width=20): string`（█░）
- `formatDurationLeft(iso)` / `formatDurationUntil(iso)` / `formatResetShort(iso)`
- `pickTighterUsageLimit(usage): {percentLeft, resetIso, source}`
- `formatUsageStatusText(usage): string` → `Grok 40% left · 3d 12h`
- `formatQuota(usage, {now, showStatusbarTip}): string[]`（Codex 风格多行）
- `formatGrokBuildBilling(usage, opts): string`（=formatQuota.join）
- `fetchBillingUsage(accessToken): Promise<BillingUsage>`（详见 §3.6）
- `fetchGrokBuildBilling(accessToken)`（deprecated 别名）
- `getEffectiveXaiApiKey(options?: {env?, settingsApiKey?, settingsSource?}): Promise<{apiKey, source}|undefined>`——凭据解析主函数（详见 §3.4）
- `autoImportGrokCliIfNeeded(): Promise<boolean>`（启动时自动导入，见 §3.3）
- 测试钩子：`__setTestGrokCliAuthPath` / `__setTestPiAuthPath` / `__resetTestPathsToDefaults`

**依赖**：xai-stream（`GROK_CLI_VERSION`）。类型来自 @earendil-works/pi-ai 的 `OAuthCredentials`、`OAuthLoginCallbacks`。**不使用** ExtensionAPI 实例（纯逻辑 + node:fs/http/readline/crypto），但登录 UI 通过 callback 对象对接 Pi。

### 1.4 `xai-provider.ts` — 模型目录 + Provider 注册（约 184 行）

**职责**：定义 Grok Build 模型目录；注册 `grok-build` provider；注册 `before_provider_headers` 会话头 hook。

**关键导出**：
- `interface GrokBuildModelSpec { id, name, reasoning, contextWindow, maxTokens, input:("text"|"image")[], cost:{input,output,cacheRead,cacheWrite}, thinkingLevelMap? }`
- `GROK_BUILD_MODELS`（完整目录见 §2.1）
- 成本常量（$/M tokens，估算非订阅积分）：`COST_BUILD={1,2,0.2,0.2}`、`COST_COMPOSER_FAST={3,15,0.5,0}`、`COST_43={1.25,2.5,0.2,0}`、`COST_45={2,6,0.5,0}`、`COST_420={1.25,2.5,0.2,0}`
- `registerXaiProvider(api: ExtensionAPI): void`
- `registerGrokCliConvHeaders(api: ExtensionAPI): void`

**Pi API 使用**：`api.registerProvider`（见 §2.1 结构）、`api.on("before_provider_headers", ...)`、`ctx.sessionManager.getSessionId()`、`ctx.model.{provider,baseUrl}`。

### 1.5 `xai-images.ts` — Responses 图片归一化（约 197 行）

**职责**：把本地路径 / OpenAI image_url 形状转成 xAI `input_image`；修复空函数输出。

**关键导出（全部纯函数，可原样复用）**：
- `normalizeImageInput(value, cwd): string|undefined`——http(s)/data:image 透传；相对/绝对本地 `.jpg/.jpeg/.png` readFileSync → `data:<mime>;base64,...`；**限定 workspace 内**（realpath 前缀校验）
- `normalizeImageParts(value, cwd): unknown`——递归把 `{type:"image"}`、`{type:"image_url"}` → `{type:"input_image", image_url, detail:"auto"}`；本地路径解析；递归处理 `content` / `output`
- `rewriteFunctionCallOutputImages(input: Record[], supportsImages): Record[]`——把 `function_call_output` 的 output 数组压成纯文本；图片单独拆成后续 user 消息附带（xAI 拒绝 function_call_output 内嵌图）
- helper：`imageMimeTypeForPath`、`ensurePathWithinWorkspace`、`resolveLocalImagePath`、`stripShellQuotes`、`unescapeShellPath`

**依赖**：node:fs/path/url。**不使用** ExtensionAPI。

### 1.6 `xai-image-gen.ts` — 文生图 / 图编（大约 276 行）

**职责**：xAI Imagine `image_gen` / `image_edit` 协议。

**关键导出**：
- `XAI_IMAGINE_MODEL = "grok-imagine-image-quality"`
- `generateImage(apiKey, baseUrl, {prompt, aspect_ratio?, model?}): Promise<{path, model}>`——POST `/images/generations`，body `{model, prompt, n:1, aspect_ratio:"auto", resolution:"1k", response_format:"b64_json"}`；b64 存临时 `tmp/pi-xai/images/gen-<ts>.jpg`
- `resolveImagineImageRef(value, cwd): string`（路径/url/data URI → API 安全 URL；本地图片转 data URI）
- `editImage(apiKey, baseUrl, {prompt, image:string|string[], aspect_ratio?, model?}, cwd?): Promise<{path,model}>`——POST `/images/edits`；单图 `body.image={url}`，多图 `body.images=[{url}]` + aspect_ratio
- `imagineUsageMessage()` / `imagineInstruction(prompt)`（引导模型原样调用 image_gen）
- `registerXaiImageGen(api)`（默认开）

**Pi API 使用**：`api.registerCommand("imagine", ...)`、`api.registerTool(defineTool({name:"image_gen"|"image_edit"}))`、`ctx.ui.notify`、`ctx.sendUserMessage`。

### 1.7 `xai-video-gen.ts` — 图生视频（约 200 行）

**职责**：Grok `image_to_video`（图片起手 → 视频轮询下载）。

**关键导出**：
- `XAI_VIDEO_MODEL = "grok-imagine-video"`；`IMAGE_TO_VIDEO_TOOL = "image_to_video"`
- `clampVideoDuration(raw): 6|10`
- `imagineVideoUsageMessage()` / `imagineVideoInstruction(prompt)`（指导 image_gen + image_to_video 两段式）
- `imageToVideo({image, prompt?, duration?, model?, cwd?}): Promise<{path, requestId, model, duration?}>`——POST `/videos/generations` → 轮询 `GET /videos/{requestId}`（status done/failed/expired，2.5s 间隔 300s 超时）→ 下载 mp4 存临时目录
- `registerXaiVideoGen(api)`（默认开但 pi-xai-imagine 在场自动关）

**Pi API 使用**：`api.registerCommand("imagine-video", ...)`、`api.registerTool(defineTool({name:"image_to_video"}))`、`ctx.ui.notify`、`ctx.sendUserMessage`、`ctx.cwd`。

### 1.8 `xai-vision.ts` — 图片理解路由（约 747 行）

**职责**：当活动模型不声明图像输入（尤其 Composer）时，把 `read` 工具返回的图片经问答链路用视觉模型描述，替换为文本。

**关键导出**：
- 配置：`getConfigPath()=~/.pi/xai-vision.json`、`getCachePath()=~/.pi/xai-vision-cache.json`、默认 `DEFAULT_DESCRIBE_MODEL="grok-4.6"`、`DEFAULT_MAX_IMAGES=4`、`DEFAULT_CACHE_MAX_ENTRIES=100`、`DEFAULT_PROMPT`
- `type VisionMode="off"|"composer"|"all"`；`VisionConfig{mode, model, maxImages, cacheEnabled, cacheMaxEntries}`
- `isComposerModel(id)`、`resolveVisionMode(config)`、`shouldRouteVision(config, modelId, modelInput)`（模型声明 image 输入则绝不路由；composer 模式仅 Composer；all 覆盖所有文本模型）
- `describableModels(): string[]`（有 image 输入且非 grok-build* 的模型 id）
- `loadConfig` / `saveConfig` / `normalizeConfig`
- 缓存：`loadCache` / `saveCache` / `updateCache`（串行化写盘）/ `clearCache` / `cacheStats` / `makeCacheKey` / `makeCacheEntry` / `pruneCache`
- `describeImage(img, model, prompt, apiKey, baseUrl, signal?): Promise<string>`（POST /responses，带 3 次指数退避重试，30s 超时）
- `handleReadResult(event: ToolResultEvent, ctx): Promise<{content:TextContent[]}|undefined>`
- `registerXaiVision(api)`

**Pi API 使用**：`api.on("tool_result", handleReadResult)`（只处理 `read`/`Read`）、5 条命令 `xai-vision:status|:on|:composer|:off|:cache-clear`、`ctx.model.{id,input}`、`ctx.signal`、`ctx.ui.notify`。

### 1.9 `xai-goal.ts` — Grok Build 风格 goal 模式（约 325 行）

**职责**：`/goal` 命令 + `update_goal` 工具，session 内目标状态机。

**关键导出**：
- `UPDATE_GOAL_TOOL_NAME="update_goal"`、`GOAL_COMMAND_NAME="goal"`
- `type GoalStatus="active"|"paused"|"blocked"|"completed"`；`GoalState{objective,status,log[string][],blockedReason?,updatedAt}`
- `getGoalState()` / `setGoal(objective)` / `clearGoal()` / `pauseGoal()` / `resumeGoal()`
- `applyUpdateGoal({completed?, message?, blocked_reason?}): {ok, summary, state?}`（blocked 需 blocked_reason；paused 只接受 complete/blocked；log 上限 40）
- `goalUsageMessage()` / `goalInstruction(objective)` / `formatGoalStatus()`
- `registerXaiGoal(api)`

**Pi API 使用**：`api.registerTool(update_goal)`、`api.registerCommand("goal")`、`ctx.ui.notify`、`ctx.ui.setStatus("xai-goal", ...)`、`ctx.sendUserMessage`（委托注入 goal 指令）、3 个 hook：`session_start`（清目标）、`before_agent_start`（注入活动目标 customType:"xai-goal"，display:false）。
> ⚠️ **这是一个纯内存单例 `let goal`**，无持久化、无 classifier/subagent harness。

### 1.10 `xai-plan-mode.ts` — 只读计划模式（约 254 行）

**职责**：`enter_plan_mode` / `exit_plan_mode` 工具 + `/plan` 命令；进入只读工具集，bash 白名单。

**关键导出**：
- `PLAN_FILE = ".pi/plan.md"`；`PLAN_DISABLED = {edit, write}`；`PLAN_PREFERRED = [read, bash, grep, find, ls]`
- `DESTRUCTIVE` 正则（rm/rmdir/mv/cp/mkdir/touch/chmod/chown/sudo/kill/reboot/`>`/`>>`/npm install/git add|commit|push|reset）
- `SAFE_BASH` 白名单正则（cat/head/tail/grep/rg/find/ls/pwd/echo/wc/sort/uniq/diff/file/stat/tree/which/env/git status|log|diff|show|branch|remote/node -e/python3 -c）
- `isSafePlanBash(command): boolean`
- `planFilePath(cwd)` / `readPlanFile(cwd)` / `seedPlanFile(cwd): {path, created}`
- `isPlanModeActive(): boolean`
- `registerXaiPlanMode(api)`

**Pi API 使用**：2 个工具 + `api.registerCommand("plan")`、`api.setActiveTools` / `api.getActiveTools`（临时收缩/恢复）、`ctx.ui.setStatus("xai-plan", ...)`、`ctx.cwd`、hook：`tool_call`（planMode 下拦截 bash 非白名单）、`before_agent_start`（注入 plan 提示，customType:"xai-plan-mode"）、`session_start`（重置）。

### 1.11 `xai-prompt-suggest.ts` — 下一条提示幽灵（约 362 行，默认关）

**职责**：回合结束后用 `grok-composer-2.5-fast` 预测用户下一条输入，在空文本框显示灰色幽灵文本；Enter 触发发送（剥离 ANSI）；不绑定 Tab。

**关键导出**：
- `SUGGEST_SYSTEM`（预测系统提示词，含 NONE 静默规则）
- `DEFAULT_MODEL="grok-composer-2.5-fast"`、`MAX_CHARS=120`、`MAX_WORDS=16`、`TRANSCRIPT_BUDGET=12000`、`MSG_CAP=800`
- `isPromptSuggestEnabled()`（默认关；`XAI_PROMPT_SUGGESTIONS`/`GROK_PROMPT_SUGGESTIONS` env 1/0 覆盖）
- `setPromptSuggestEnabled` / `getSuggestion` / `clearSuggestion`
- `stripAnsi(s)` / `asGhostText(plain)`（`\x1b[2;90m...\x1b[0m`）
- `filterSuggestion(raw): string|undefined`（NONE→undefined；去引号/换行；长度/词数校验；单字白名单；屏蔽 `let me`/`i'll` 等）
- `buildTranscript(messages): string|undefined`（反向取最近 user/assistant，需含 assistant，预算内）
- `fetchSuggestion(transcript)`（POST /responses，stream:false，store:false，max_output_tokens:64，temperature:0.4，15s 超时）
- `registerXaiPromptSuggest(api)`

**Pi API 使用**：`api.registerCommand("xai-suggest", on|off|clear|status)`、hook：`input`（转换剥离 ANSI/回填幽灵文本，`{action:"transform", text}`）、`agent_end`（触发预测）、`session_start`（重置）；`ctx.ui.getEditorText/setEditorText/setWidget`、`ctx.ui.notify`。

### 1.12 `xai-usage-status.ts` — 底部配额状态栏（约 126 行）

**职责**：可选 footer `Grok 40% left · 3d 12h`（默认关）。

**关键导出**：
- `XAI_USAGE_STATUS_KEY="xai-usage"`、`USAGE_STATUS_TTL_MS=5*60*1000`
- `noteBillingUsage(usage, fetchedAt?)` / `clearBillingUsageCache()`
- `isGrokModel(model): boolean`（provider 为 grok-build/xai 或 id 以 grok- 开头）
- `paintUsageStatus(ctx, usage, now?)` / `clearUsageStatus(ctx)`
- `refreshUsageStatus(ctx, {force?, now?})`（TTL 缓存 + 单飞；无 UI 跳过；仅 Grok 模型时绘制）
- `toggleUsageStatusbar(ctx)`（持久化开关）
- `registerXaiUsageStatus(api)`

**Pi API 使用**：hook `session_start`/`model_select`（刷新）/`session_shutdown`（清除）；`ctx.ui.setStatus(key, theme.fg("dim", text))`、`ctx.hasUI`、`ctx.model`、`ctx.ui.notify`。

### 1.13 `xai-web-fetch.ts` — 客户端网页抓取（约 194 行）

**职责**：URL→text/markdown，带 SSRF 防护。

**关键导出（全纯函数）**：
- `upgradeToHttps(url)`（http:// → https://）
- `ssrfBlockReason(urlStr): string|null`（协议校验、localhost/私有 IP/元数据主机拦截）
- `isPrivateIp(ip): boolean`（v4/v6 私有判定）
- `htmlToRoughMarkdown(html): string`（script/style 剥除、br→换行、h1-6→#、a→[t](h)、列表→`-`、实体解码）
- `truncateText(s, max=80000)`
- `webFetch(urlInput): Promise<{url, finalUrl, contentType, text}>`（重定向再校验 SSRF、大小限制 1.5MB、html→markdown）
- `registerXaiWebFetch(api)`

**Pi API 使用**：`api.registerTool(defineTool({name:"web_fetch"}))`。

---

## 2. 全部注册面清单

### 2.1 注册的 Provider：`grok-build`（唯一）

`api.registerProvider("grok-build", {...})`（xai-provider.ts）：
- `baseUrl` = `resolveXaiConfig().xai.baseUrl`
- `api: "openai-responses"`
- `authHeader: true`
- `oauth`: `{name:"xAI (Grok Build)", usesCallbackServer:true, login:loginXai, refreshToken:refreshXaiToken, getApiKey:getXaiApiKeyFromCredentials}`
- `models`: 来自 `GROK_BUILD_MODELS`，当 baseUrl 是 CLI 代理时每个模型挂 `headers: grokCliModelHeaders(m.id)`

**模型目录（`GROK_BUILD_MODELS`，8 个）**：

| id | name | reasoning | contextWindow | maxTokens | input | cost (in/out/cacheR/cacheW) | thinkingLevelMap |
|---|---|---|---|---|---|---|---|
| `grok-composer-2.5-fast` | Composer 2.5 | false | 200_000 | 30_000 | text | 3/15/0.5/0 | off→none；minimal/low/medium/high/xhigh→null |
| `grok-build` | Grok Build | true | 500_000 | 30_000 | text,image | 1/2/0.2/0.2 | — |
| `grok-4.6` | Grok 4.6 | true | 500_000 | 131_072 | text,image | 2/6/0.5/0 | off→null,minimal→low,low→low,medium→medium,high→high,xhigh→xhigh,max→xhigh |
| `grok-4.5` | Grok 4.5 | true | 500_000 | 131_072 | text,image | 2/6/0.5/0 | off→null,minimal→low,low→low,medium→medium,high→high,xhigh→null |
| `grok-4.3` | Grok 4.3 | true | 1_000_000 | 131_072 | text,image | 1.25/2.5/0.2/0 | — |
| `grok-4.20-0309-reasoning` | Grok 4.20 Reasoning | true | 2_000_000 | 131_072 | text,image | 1.25/2.5/0.2/0 | — |
| `grok-4.20-0309-non-reasoning` | Grok 4.20 Non-Reasoning | false | 2_000_000 | 131_072 | text,image | 1.25/2.5/0.2/0 | off→none，其余→null |
| `grok-4.20-multi-agent-0309` | Grok 4.20 Multi-Agent | true | 2_000_000 | 131_072 | text,image | 1.25/2.5/0.2/0 | — |

> 说明：`thinkingLevelMap` 是 Pi 内部“思维等级→API effort 字符串”映射；`null` 表示该级别不支持/不可用（Composer 用 `off:"none"` 关闭思考，其余不支持级别置 null，模型侧会忽略）。

### 2.2 注册的工具（`api.registerTool`，共 10 个）

| 工具名 | 参数 schema 要点 |
|---|---|
| **`xai_generate_text`** | prompt:String◆; model?(默认 grok-4.6); reasoningEffort?(low/medium/high/xhigh); system?; previousResponseId?; maxOutputTokens?; temperature?; store?(默认 true); include?; tools?; responseFormat?（JSON schema string→json_schema strict:true）; timeout?（推理模型默认 3600000，其余 300000）。默认模型 `grok-4.6`；reasoning.encrypted_content 自动 include（store!==false 且模型支持时） |
| **`xai_multi_agent`** | prompt:String◆; reasoningEffort?(low/mid/high/xhigh→4/16 agents); tools?; previousResponseId?; store?; include?; timeout?(默认3600000)。硬编码模型 `grok-4.20-multi-agent-0309` |
| **`xai_x_search`** | query:String◆; from_date?(YYYY-MM-DD); to_date?。模型 `grok-4.20-0309-reasoning`，工具 `{type:"x_search",from_date?,to_date?}`，store:false |
| **`image_gen`** | prompt:String◆; aspect_ratio?(默认 auto，如 1:1/16:9/9:16); model?(默认 grok-imagine-image-quality) |
| **`image_edit`** | prompt:String◆; image:String|String[]◆; aspect_ratio?; model? |
| **`image_to_video`** | image:String◆; prompt?; duration?(6|10, 默认6); model?(默认 grok-imagine-video) |
| **`update_goal`** | completed?(Boolean); message?(String); blocked_reason?(String) |
| **`enter_plan_mode`** | 无参 |
| **`exit_plan_mode`** | 无参 |
| **`web_fetch`** | url:String◆ |

（`xai_multi_agent` 仅在 `isMultiAgentToolEnabled()` 为真时注册。）

### 2.3 注册的命令（`api.registerCommand`，共 13 条）

| 命令 | 作用 |
|---|---|
| `/xai-usage` | 显示 Grok Build 用量；子命令 `statusbar`/`status` 切换 footer；`show`/`quota` 等价查看 |
| `/goal` | `/goal <objective>` | status | pause | resume | clear | edit <new>（子命令分派） |
| `/plan` | `/plan [on|off|status|show]`（无参 = 切换） |
| `/xai-suggest` | 提示幽灵 on/off/clear/status |
| `/imagine` | 生成图（引导模型调用 image_gen，prompt 原样） |
| `/imagine-video` | 生成视频（引导 image_gen + image_to_video 两段） |
| `/xai-vision:status` | 视觉路由状态/模式/描述模型/缓存统计 |
| `/xai-vision:on` | 全部文本模型启用路由 |
| `/xai-vision:composer` | 仅 Composer（默认） |
| `/xai-vision:off` | 关闭路由 |
| `/xai-vision:cache-clear` | 清空视觉描述缓存 |

> 注：`/login grok-build` 是 **Pi 核心内置命令**，pi-xai 不注册它，而是把 `loginXai` 挂到 provider 的 `oauth.login`，由 Pi 调用触发。移植到 DSH 时需自行接入登录命令/流程。

### 2.4 注册的 hook / 事件（`api.on`）

| hook | 触发逻辑 |
|---|---|
| **`before_provider_request`** | 仅当 `payload.model` 以 `grok-` 开头时执行：①合并 agentic 内置工具（`mergeXaiTools`）②`stripSlashEnums`（xAI 422：删除含 `/` 的 enum）③删 `seed/parallel_tool_calls/prompt_cache_retention/service_tier` ④空 tools 删除 ⑤temp 钳制 [0,2]、top_p 钳制 [0,1] ⑥reasoning：仅支持 reasoning effort 的模型保留 `{effort}` ⑦`ensureXaiEncryptedReasoningInclude` ⑧`rewriteXaiProviderInput`（role 折叠 + 图片归一化）⑨`ensureXaiPromptCacheKey(payload, sessionManager.getSessionId())`. 原地改 payload，返回 undefined |
| **`before_provider_headers`** | 仅当 `ctx.model.provider==="grok-build"` 且 baseUrl 是 CLI 代理时，`event.headers["x-grok-conv-id"]=sessionId` |
| **`message_end`** | 仅 grok-\* 模型，把 `url.[[N]](cite)` 粘合修正为 `url [[N]](cite)`（`glueCitationSpacing`） |
| **`tool_result`** | `handleReadResult`：仅 `read`/`Read` 且应路由时，将图片块替换为视觉模型描述文本 |
| **`tool_call`** | plan mode 激活时拦截 `bash` 命令，非白名单 → `{block:true, reason}` |
| **`before_agent_start`** | 若 goal 激活 → 注入 `customType:"xai-goal"` 消息；若 plan mode → 注入 `customType:"xai-plan-mode"` 消息（均 display:false） |
| **`agent_end`** | prompt suggest：转录→预测→幽灵文本框 |
| **`input`** | prompt suggest：提交时剥离 ANSI / 回填幽灵文本（`{action:"transform"}`） |
| **`session_start`** | goal 清理（reason!=="startup"）；plan mode 重置；suggest 重置；usage status 刷新 |
| **`model_select`** | usage status 刷新 |
| **`session_shutdown`** | usage status 清除 + 缓存清空 |

---

## 3. 凭据体系

### 3.1 优先级链（`getEffectiveXaiApiKey`，自上而下首个命中即返回 `{apiKey, source}`）

1. **Pi auth `grok-build`** 条目（`~/.pi/agent/auth.json`）
   - `type:"api_key"` 且有 `key` → 直接返回（source `pi-auth:...:grok-build`）
   - `type:"oauth"` 且有 `access`：若过期（存储的 `expires` 或 JWT `exp` 提前 1h）且有 `refresh` → 加锁刷新 + 回写 auth.json；无 refresh 但过期 → 尝试用 `~/.grok/auth.json` 的 refresh_token 借壳刷新（`tryRefreshUsingGrokCliRefresh`）；不过期 → 直接用 access
2. **Grok CLI 直读**（`~/.grok/auth.json`，`grok-cli:` / legacy source）——JWT 即将过期且有 refresh → 刷新（并机会性回填 pi-auth grok-build 的 refresh）；未过期 → 直接用
3. **Pi auth `xai`** 条目（`/login xai` 或旧配置）——同 grok-build 的 oauth/api_key 双分支处理
4. **env `XAI_API_KEY`**（仅当无 Grok Build 登录时兜底，source `env:XAI_API_KEY`）
5. **settings.json `xai.apiKey`**（`settings:xai.apiKey`，经 options 传入）

> 关键设计：**Grok Build OAuth 优先**，普通 API key 只是最后手段（原文：“往往只对 voice 有效”）。

### 3.2 xAI OAuth 流程（`loginXai`）

`loginXai(callbacks)` 返回 `OAuthCredentials{access, refresh, expires, source}`。步骤：

1. 若存在 `~/.grok/auth.json` 且有 `onSelect` → 让用户选 `import`（导入 CLI 登录）或 `native`（全新登录）；无 onSelect 环境 → 自动导入。
2. 无 CLI 且可选时 → 让用户选 `web`（建议）或 `device`；无 onSelect → 默认 web。
3. **Web PKCE（`performXaiPkceLogin`）**：
   - GET `XAI_OAUTH_DISCOVERY_URL` → 校验 `authorization_endpoint`/`token_endpoint`（必须 https 且 *.x.ai）
   - PKCE：`randomBytes(32)` → verifier；SHA256 → challenge；state/nonce = UUID
   - 本地开 `http://127.0.0.1:56121/callback`（端口占用则 0 自动分配），`startCallbackServer`（CORS 仅允许 accounts.x.ai/auth.x.ai，180s 超时）
   - 构造 authorize URL（`response_type=code`、client_id、redirect_uri、scope、code_challenge=S256、state、nonce）→ `callbacks.onAuth({url, instructions})`；同时挂 stdin 粘贴回调 + `callbacks.onManualCodeInput?.()`
   - `waitForCallback` 收 code → 校验 state → POST token（grant_type=authorization_code + code_verifier + echo code_challenge）到手 access/refresh/expires_in
   - 过期加 skew 1h：`expires = Date.now() + expires_in*1000 - 3600_000`
   - source = `native-pkce-web`
4. **Device Code（`performNativeDeviceCodeLogin`）**：
   - POST `/oauth2/device/code`（client_id + scope + referrer:"grok-build" + x-grok 头）→ 得 device_code/user_code/verification_uri
   - `callbacks.onAuth` 显示 url+code；轮询 `pollDeviceToken`（interval 默认 5s，expires 默认 300s），处理 `authorization_pending`/`slow_down`/`expired_token`/`access_denied`
   - 成功 → source=`native-device-code`
5. 导入分支（`importFromGrokCli`）：读 auth.json access/refresh/expiry → source=`grok-cli-import`。

### 3.3 Grok CLI 自动导入（`autoImportGrokCliIfNeeded`）

- 启动时（index.ts `await autoImportGrokCliIfNeeded()`）调用。
- 若 `~/.grok/auth.json` 有 accessToken 且 pi-auth 尚无 `grok-build` 条目 → 写入 `{type:"oauth", access, refresh?, expires, source:"grok-cli", email?, imported_at}` 到 `~/.pi/agent/auth.json` 的 `grok-build`，chmod 0600。
- **刻意不写 `xai`**（保持 xai 仅作 API key 语义）。不覆盖已有 grok-build。文件不可写 → 静默失败返回 false（工具仍可经 grok-cli 直读路径工作）。

### 3.4 刷新令牌逻辑（`refreshXaiToken`）

- 无 refresh → 抛错提示“CLI 导入的无刷新令牌，需 /login grok-build 获得受管会话”。
- 有 refresh → POST `XAI_OAUTH_TOKEN_URL`（grant_type=refresh_token + client_id）；403 + entitlement → `xai_entitlement`；400/401/403 → reloginRequired。成功回传 access/refresh(可轮换)/expires。
- **并发保护**：`withRefreshLock(key, fn)` 内存 Map 串行化同一 provider 的刷新（xAI refresh 令牌单次使用，多 agent 并发会致第二次 400/401）。

### 3.5 错误分类

- `XaiAuthError` 带 `reloginRequired` + `code`。
- 401 或（403 + stale 且非 entitlement）→ 调用端标记 `reloginRequired`（如 `callXaiResponses` 给 err 挂 `reloginRequired`）。
- `isXaiEntitlementError`：`do not have an active grok subscription` / `out of available resources`+grok / `does not have permission`+grok。entitlement 错误不视为需重新登录。

### 3.6 Billing / Usage 查询（`fetchBillingUsage`）

- **Monthly**：`GET https://cli-chat-proxy.grok.com/v1/billing`，头 `billingHeaders`（authorization Bearer、`x-xai-token-auth: xai-grok-cli`、`x-grok-client-version`、`x-grok-client-mode: interactive`、accept）。解析 `config.monthlyLimit/used/billingPeriodEnd`。
- **Weekly**：`GET .../v1/billing?format=credits`，解析 `config.currentPeriod.type==="USAGE_PERIOD_TYPE_WEEKLY"` 的 `creditUsagePercent`（失败静默 undefined）。
- 401/403 → `xai_billing_auth`（提示需订阅 OAuth）。
- 格式化在 `formatQuota`/`formatUsageStatusText`（§1.3）。

---

## 4. 纯协议可复用 vs Pi 绑定

### 4.1 纯 HTTP/协议/格式化逻辑（可原样搬进 DSH 插件，仅依赖 node + fetch）

| 函数 | 来源 | 备注 |
|---|---|---|
| `callXaiResponses(apiKey, baseUrl, body, timeout?, sessionId?, cwd?)` | index.ts | 直接 POST `/responses`（归一化内建于其调用方，见下） |
| `normalizeForXai(input)` | index.ts | 修空 role 内容（xAI 400） |
| `normalizeImageInput` / `normalizeImageParts` / `rewriteFunctionCallOutputImages` | xai-images.ts | workspace 限定本地图→data URI |
| `rewriteXaiProviderInput(payload, {cwd, modelId})` | index.ts | role 折叠——注意 DSH 若已有 instruction 机制可选择性复用 |
| `stripSlashEnums(tools)` | index.ts | xAI 422 规避 |
| `mergeXaiTools(existing, builtins)` | index.ts | 服务器内置工具去重合并 |
| `ensureXaiEncryptedReasoningInclude` | index.ts | reasoning.encrypted_content |
| `ensureXaiPromptCacheKey` / `clampXaiPromptCacheKey` / `XAI_PROMPT_CACHE_KEY_MAX_LENGTH=64` | index.ts | 会话亲和缓存键 |
| `formatResponseSummary(result, title)` | index.ts | 响应摘要（含 server-side tool usage、citations） |
| `glueCitationSpacing` / `citationsSummary` | index.ts | 引用格式化 |
| `xaiRequestHeaders` / `grokCliModelHeaders` / `grokCliUserAgent` / `isGrokCliProxyBaseUrl` | xai-stream.ts | CLI 代理身份头 |
| `grokModelId` / `grokSupportsReasoningEffort` / `grokWantsEncryptedReasoningInclude` | xai-config.ts | 模型门控 |
| `GROK_BUILD_MODELS` / 模型目录 / `GrokBuildModelSpec` | xai-provider.ts | 目录数据是静态的 |
| 全部 OAuth 底层（PKCE/DeviceCode/Exchange/JWT/grok-cli 导入/refresh/解析） | xai-oauth.ts | `loginXai` 本体虽绑 OAuthLoginCallbacks，但回调接口可照搬；底层 HTTP 全独立 |
| billing 解析 + 格式化（`fetchBillingUsage`、`parseMonthlyUsage`、`parseWeeklyUsage`、`usageProgressBar`、`formatQuota`、`formatUsageStatusText`、`pickTighterUsageLimit`、`formatDuration*`） | xai-oauth.ts | 纯逻辑 |
| `generateImage` / `editImage` / `resolveImagineImageRef` | xai-image-gen.ts | Imagine 协议 + 临时存盘 |
| `imageToVideo` / `clampVideoDuration` / `pollVideo` | xai-video-gen.ts | 视频协议 + 下载 |
| 视觉：`describeImage`（重试/超时/缓存）+ 配置/缓存全套（`loadConfig`/`updateCache`/`makeCacheKey` 等） | xai-vision.ts | 依赖 `getEffectiveXaiApiKey` 需换凭据提供 |
| `webFetch` / `ssrfBlockReason` / `isPrivateIp` / `htmlToRoughMarkdown` / `truncateText` / `upgradeToHttps` | xai-web-fetch.ts | 全独立 |
| `isSafePlanBash` / `planFilePath` / `readPlanFile` / `seedPlanFile` | xai-plan-mode.ts | 文件与命令白名单逻辑独立 |
| goal 状态机（`setGoal`/`applyUpdateGoal`/`pauseGoal`/`resumeGoal` 等）| xai-goal.ts | 纯内存逻辑可搬，但 DSH 已有原生 goal（见 §5） |
| prompt suggest 纯函数（`filterSuggestion`/`buildTranscript`/`stripAnsi`/`asGhostText`/`fetchSuggestion`） | xai-prompt-suggest.ts | fetchSuggestion 依赖凭据提供 |

### 4.2 强绑定 Pi 抽象（移植需改写，仅借思路）

| 绑定 | 说明 |
|---|---|
| `api.registerProvider` 的 `oauth.{login,refreshToken,getApiKey}` 结构 | Pi 专属 provider OAuth 契约；DSH 用自身的 credentials/llm-provider route |
| `defineTool({name,label,description,parameters:Type.Object,execute(→{content,details})})` | Pi 工具返回结构 `{content:[{type:"text",text}], details}`；DSH 工具契约不同 |
| `ctx.ui.notify` / `ctx.ui.setStatus` / `ctx.ui.theme.fg` / `ctx.ui.setWidget` / `ctx.ui.getEditorText`/`setEditorText` | DSH 是 Web GUI，需映射到 DSH UI/Toast/status 机制 |
| `ctx.sessionManager.getSessionId()` | DSH 会话 id 提供方式不同 |
| `ctx.model.{id,provider,input,baseUrl}` | DSH 模型上下文对象不同 |
| `ctx.cwd` / `ctx.signal` / `ctx.hasUI` | DSH 对应字段 |
| `api.registerCommand` + `ctx.sendUserMessage?.()` | Pi 命令注入消息机制；DSH 命令处理不同 |
| `api.on("before_provider_request"|...` / `api.on("tool_result"|...)` | Pi hook 事件契约；DSH 有 Cordis 事件体系，需对照同名事件 |
| `api.getActiveTools()/setActiveTools()`（plan mode 收缩） | Pi 活动工具 API；DSH 工具开关方式不同 |
| `OAuthLoginCallbacks` / `OAuthCredentials` | 类型来自 pi-ai；DSH 用自己的凭据类型 |
| `readGrokCliAuth` 读取 `~/.grok/auth.json` 格式 / grok 订阅代理 baseUrl | 逻辑可搬，但凭据存储与 DSH credentials 服务适配 |

---

## 5. 移植映射建议（能力 → DSH 挂载点）

> 前置判断：DSH 是 Cordis 插件式框架，原生已有 **goal 工具（create_goal/get_goal/update_goal）与 plan-mode（exit_plan_mode）**。下列标注【原生去重】或【需移植逻辑】。

### 5.1 模型目录 + Provider → DSH LLM provider route
- **移植** `GROK_BUILD_MODELS`（§2.1 表格）作为 DSH Grok Build 模型目录；成本/contextWindow/maxTokens/thinkingLevelMap 直接抄。
- **挂载**：DSH 的 LLM provider 路由 / 模型注册；`baseUrl` 走 CLI 代理则包 `grokCliModelHeaders` 进请求头，公开 API 则仅 Bearer。
- **注意**：`registerProvider` 的 oauth 结构不适用；DSH 侧凭据接入见 §5.6。

### 5.2 文本/搜索/多智能体工具 → DSH 工具注册
- **原样移植协议层**：`callXaiResponses`、`ensureXaiPromptCacheKey`、`stripSlashEnums`、`mergeXaiTools`、`formatResponseSummary`、图片归一化。
- 工具 `xai_generate_text`、`xai_multi_agent`、`xai_x_search` → DSH 工具注册（改用 DSH 工具返回契约与凭据注入）；参数 schema 要点不因框架改变。
- **before_provider_request 归一化逻辑** → DSH 若存在 provider 请求前 hook（Cordis 事件），将同段 sanitize 逻辑搬移；否则封装成一个可被工具/route 调用的 `sanitizeXaiPayload(payload, ctx)` helper。

### 5.3 Imagine / 视频 / Web 抓取 → DSH 工具
- `image_gen`(→`generateImage`)、`image_edit`(→`editImage`)、`image_to_video`(→`imageToVideo`)、`web_fetch`(→`webFetch`) → DSH 工具，直接复用 §4.1 纯逻辑；结果存临时目录并返回路径。

### 5.4 命令 → DSH 命令/UI
- `/xai-usage` → DSH 命令（调用 billing 查询并展示）。`statusbar` 子命令映射到 DSH UI 常驻状态区。
- `/imagine`、`/imagine-video` → DSH 命令，但 DSH 的“委托模型执行”方式不同（Pi 用 `sendUserMessage` 注入指令）；DSH 可直接由命令调用工具本身而非注入指令。
- `/xai-vision:*`、`/xai-suggest`、`/plan`、`/goal` → 视 DSH 是否已有等价（§5.5）。

### 5.5 goal / plan → 对照 DSH 原生能力（重点去重判断）

- **goal**：pi-xai 的 `registerXaiGoal` 实现的是**内存单例状态机**（`/goal` 命令 + `update_goal` 工具 + `before_agent_start` 注入 + `session_start` 清理）。DSH **原生已有** `create_goal/get_goal/update_goal` 工具（持久化、跨回合、autonomous continuation rounds、blocked/complete/resume 语义），且同样有 `before_agent_start` 注入机制。→ **结论：不需要移植 `update_goal` 工具与 goal 状态机，属于重复能力**；差异点在 pi-xai 是 *Grok Build 风格轻量内存版*、DSH 更强（持久化+rounds/blocked 语义）。若需保留 `/goal` 命令体验，可做一个薄封装把 DSH 原生 goal 工具暴露为 `/goal` 命令，或直接沿用 DSH 原生 goal 生命流程。
- **plan mode**：pi-xai 的 `registerXaiPlanMode` 实现 `enter_plan_mode`/`exit_plan_mode` 工具 + `/plan` 命令 + **bash 白名单拦截**（`tool_call` hook）+ 工具集收缩。DSH **原生已有 plan-mode（`exit_plan_mode` 工具与会话 plan 流程）**，但不一定有 pi-xai 的（a）`.pi/plan.md` 文件、（b）bash 白名单 `isSafePlanBash`、（c）`enter_plan_mode` 反向入口。→ **结论：DSH 有 plan-mode 主体，重复度中**；值得移植的部分是 **`isSafePlanBash`/`SAFE_BASH`/`DESTRUCTIVE` 白名单逻辑**（可用于 DSH 的 bash 工具安全门）与 plan 文件读写 helper。

### 5.6 凭据 → DSH credentials 服务
- 移植 `getEffectiveXaiApiKey` 的**优先级链语义**（grok-build OAuth > grok-cli 直读 > xai OAuth > env XAI_API_KEY > settings）：DSH 若有 credentials 服务，把各来源注册进去，解析逻辑搬到 DSH。
- `loginXai`（PKCE web + device code）与 `refreshXaiToken` → 接入 DSH 的凭据/登录流程（使用 node http 回调服务器 + OAuth endpoints + `withRefreshLock` 并发保护 + JWT 过期判断 `isXaiAccessTokenExpiring`）。
- `autoImportGrokCliIfNeeded` → DSH 启动时可选执行，把 `~/.grok/auth.json` 导入 DSH 凭据存储。
- 读取/写入文件路径（`~/.grok/auth.json`、billing URL）不变。

### 5.7 usage 状态栏 → DSH UI
- `refreshUsageStatus`/`paintUsageStatus`/`formatUsageStatusText`/`pickTighterUsageLimit` + billing 查询 → DSH UI 常驻状态区；DSH 用自身 status 机制替换 `ctx.ui.setStatus`+`theme.fg("dim")`。

### 5.8 视觉路由 → DSH 工具链 hook
- `handleReadResult` 依赖 Pi 的 `tool_result` 事件与 `ImageContent/TextContent` 类型。DSH 若暴露工具结果事件，将“图片→视觉模型描述→替换为文本”逻辑接入等价事件；`describeImage`+缓存（`updateCache` 串行写盘）纯逻辑可直接搬。

### 5.9 prompt suggest（幽灵）→ DSH UI
- 纯函数（`filterSuggestion`/`buildTranscript`/`fetchSuggestion`）可搬；落地依赖 DSH GUI 输入框机制（DSH 是 Web GUI，映射到输入区占位/ghost 效果，而非文本终端 ANSI）。

---

## 附：移植优先级建议

1. **高价值 + 纯协议可复用**：模型目录 + `callXaiResponses` 传输层 + `xai_generate_text`/`xai_x_search`/`xai_multi_agent` 工具 + OAuth/loginXai + billing 查询。
2. **中价值**：Imagine 图片/视频工具、web_fetch、视觉路由（describeImage）。
3. **低 / 与 DSH 重复**：goal 工具（DSH 原生）、plan mode 主体（DSH 原生），只需移植其差异化辅助逻辑（bash 白名单、plan 文件 helper）。
4. **低优先**：prompt suggest 幽灵（绑定 GUI 形态，移植成本/收益比低）。

> 所有“Pi 绑定”点都集中在：`registerProvider` OAuth 结构、`defineTool` 返回结构、`ctx.ui.*`、`ctx.sessionManager`、`api.registerCommand`+`sendUserMessage`、`api.on` 事件契约、provider 请求前 hook 契约。这些是移植时改写的边界。
