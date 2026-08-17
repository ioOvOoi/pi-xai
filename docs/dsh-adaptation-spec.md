# pi-xai → DSH 适配规格（dsh 分支）

> 目标：把 pi-xai（Pi CLI 的 xAI/Grok 扩展，v0.18.0）改造为 DeepSeek Harness（DSH，Cordis 插件式 agent 框架）原生插件，即「适配 dsh 的版本」。
> 依据：《docs/pi-xai-inventory.md》（功能盘点）与《docs/dsh-plugin-research.md》（DSH 插件编写规范调研）。
> 状态：定稿（调研完成；实现中以实际编译/注入验证为准）。

## 0. 调研确认的 DSH 关键 API（实现依据）

- 交付形态：独立三方 bundle 插件。`package.json` 声明 `dsh.bundle.patch: "./cordis.patch.yml"`，`main: "lib/index.js"`，`type: module`；可选 `exports["./client"]` + `dsh.client.platform`（二期 UI）。
- cordis.patch.yml：`- insert: [{id, name}]` 追加行；`llm` 核心行由官方 dsh-base 提供。
- LLM provider：服务 `ctx.llm`；`registerAdapter(providers: string[], adapter: LlmAdapter)`（返回 disposer，`replace()` 可换路由）；`registerConfigurableProviders([{provider, displayName, settingsNs, settingsPath}])`；`LlmAdapter` 需实现 `providerInfo/listModels/resolveModel/stream(GenerateOptions)`；`stream()` 必须 yield `usage` + `finish` chunk、尊重 signal、每请求带 `attributionHeaders()`、错误用 `LlmError(code)` 分类。
- 工具：`ctx.tools.register(defineTool({name, description, parameters, output: {schema, render}, execute}))`；参数/输出 schema 用 `ValueSchemaSpec` DSL（object 必带 `additionalProperties`，必填 `required: true`）或裸 JSON Schema；execute 返回 lossless JSON。
- 命令：`ctx.commands.register({name, description, handler})`（name 正则 `/^[a-z][a-z0-9_-]*$/`；handler 返回 `{kind:'success'|'error', text}`）；命令前缀不含 `/`。
- 凭据：`ctx.get('credentials')?.resolve(ref)`（ref=环境变量名，`credentialRef()` 品牌化），兜底 `launchEnvironmentOf(ctx).get(ref)?.value`；config 凭据字段用 `z.string().role('credential-ref')`。**DSH 无现成 OAuth 挂钩**，grok-build OAuth（PKCE/device/CLI 导入 + JWT 刷新）需在 adapter 内自建，token 作为 Bearer + CLI 代理头携带。
- 设置：`settingsNamespace('pi-xai')` + `installSettingsSection(ctx, NS, Config, config, {setSource, onChange})`；schema 用 `@deepseek-ai/schemastery` 的 `z`。
- 运行时版本：@deepseek-ai/cordis 4.0.1；dsh-llm/dsh-tools/dsh-credentials/dsh-settings/dsh-commands 均 0.1.0-rc.6；pi-ai 0.82.1（含内置 xai provider，仅公开 API 3 模型）。
- 最小模板：dsh-llm-deepseek（直连 adapter）、dsh-sessiongraph（工具注册）、dsh-command-compact（命令注册）、dsh-context（client UI + RPC）。

---

## 1. 背景与动机

- pi-xai 为 Pi（earendil-works/pi）提供 **Grok Build 订阅路径**：模型目录（grok-4.6/4.3/4.5/4.20-*/multi-agent/composer）、OAuth（PKCE + Device Code + grok-cli 导入）、CLI 代理身份头（cli-chat-proxy.grok.com）、agentic 工具、Imagine/视频/web_fetch、用量查询。
- DSH 官方自带 pi-ai 桥（`@deepseek-ai/dsh-llm-pi-ai`）与内置 xai provider（仅公开 API 3 模型：grok-4.3 / grok-4.5 / grok-build-0.1），**没有订阅代理路径**。
- 因此 dsh 分支的独特价值 = 把 pi-xai 的订阅能力搬进 DSH；与 DSH 原生能力（goal、plan-mode）重叠的部分做去重。

## 2. 策略决策

1. **原地转换**：dsh 分支把仓库本体改造成 DSH 插件（`dsh.bundle.patch` + `cordis.patch.yml` + `lib/` 产物），Pi 扩展入口不再保留（历史在 main 分支）。
2. **协议层原样复用**：xai-oauth / xai-stream / xai-images / xai-web-fetch / xai-image-gen / xai-video-gen 的纯函数直接搬入 `src/protocol/`（改动最小化）。
3. **凭据走 DSH credentials 服务**：grok-build OAuth（PKCE/device）作为 DSH 凭据类型接入；`getEffectiveXaiApiKey` 优先级链语义保留（grok-build OAuth > grok-cli 直读 > xai > env XAI_API_KEY > settings）。
4. **模型走原生 `LlmAdapter`（已定，调研确认）**：仿 dsh-llm-deepseek 直连模式——实现 `XaiLlmAdapter extends LlmAdapter`，`stream()` 用 pi-xai 的 Responses 协议（fetch + SSE → StreamChunk），`ctx.llm.registerAdapter(['pi-xai'], adapter)` 注册。不走 pi-ai 桥（其内置 xai provider 无订阅路径，且绕一层 pi-ai 增加耦合）。
5. **工具去重**：`update_goal`、`enter/exit_plan_mode` 用 DSH 原生能力；`isSafePlanBash`/plan 文件 helper 作为差异化逻辑保留。
6. **命令与 UI**：`/xai-usage` 等映射 DSH 命令；usage 状态栏映射 DSH UI（client 侧，二期）。

## 3. 目标仓库布局（dsh 分支终态）

```
package.json          # DSH 插件声明：main=lib/index.js、dsh.bundle.patch、exports ./client
cordis.patch.yml      # patch 注册本插件行（host；client 视形态）
scripts/build.sh      # DSH_CHECKOUT 探测 + tsc 编译 host
tsconfig.json         # 更新（module/cjs 或 esm 按 DSH 约定）
src/
  index.ts            # Cordis 插件入口：apply(ctx)，装配 credential/provider/tools/commands
  credentials.ts      # grok-build 凭据：OAuth login/refresh/import + 优先级解析
  provider.ts         # Grok Build 模型目录 + LLM 注册/请求归一化
  tools.ts            # xai_generate_text / xai_multi_agent / xai_x_search / image_gen / image_edit / image_to_video / web_fetch
  commands.ts         # /xai-usage 等
  protocol/           # 从根目录搬入的纯协议模块（oauth/stream/images/web-fetch/image-gen/video-gen/config）
  client.tsx          #（二期）usage 状态栏
docs/                 # inventory / research / spec / changelog
tests/                # 保留协议层测试（vitest），按需适配
```

## 4. 模块拆分（GitHub issue 一一对应）

| # | 议题 | 内容 | 验收 |
|---|---|---|---|
| 1 | 插件骨架 | package.json dsh 字段 + cordis.patch.yml + build.sh + tsconfig + 最小 host 入口 | `npm run build` 出 lib/；`dev_install_package` 注入成功、卸载干净 |
| 2 | 凭据层 | grok-build OAuth（PKCE/device/import/refresh）+ 优先级链，接入 DSH credentials | 单元测试通过；`XAI_API_KEY` 路径可用 |
| 3 | 模型注册 | Grok Build 目录 → DSH LLM；CLI 代理头 + 请求归一化（sanitize/prompt_cache_key/encrypted reasoning） | 模型出现在 DSH 模型列表；能发起一次真实/记录请求 |
| 4 | 文本工具 | xai_generate_text / xai_multi_agent / xai_x_search | 工具注册成功、schema 校验、真实调用（mock 或线上） |
| 5 | 媒体与抓取 | image_gen / image_edit / image_to_video / web_fetch | mock 测试通过、产物落盘 |
| 6 | 命令与用量 | /xai-usage（+statusbar 开关）、billing 查询 | 命令可用、格式化正确 |
| 7 | README 与发布 | README 重写（DSH 安装方式）、CHANGELOG、CI 适配 | 文档可指引安装 |

## 5. 里程碑

- M1：骨架 + 凭据 + 模型注册（host 侧可注入、模型可选）——最高价值先行
- M2：文本/媒体/抓取工具全量
- M3：命令 + usage UI + 文档发布

## 6. 验收标准（全目标）

- `dsh plugin add`（或 dev 注入）后：grok-* 模型可选、agentic 工具可调用、/xai-usage 可用。
- 协议层测试全部通过；凭据层级按预期解析。
- 与 DSH 原生 goal/plan 不重复注册。

## 7. 风险

- pi-ai 版本漂移（DSH 自带 0.82.1，repo peer 声明 >=0.80）；provider/oauth 契约随 DSH 升级变化。
- grok CLI 代理为闭源协议，头字段（GROK_CLI_VERSION 0.2.101 等）需随官方 CLI 联动。
- OAuth 回调服务器在 DSH 进程内运行，需注意端口/进程生命周期。