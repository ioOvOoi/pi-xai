# DSH 第三方插件编写规范调研报告

> 目标：为把 pi-xai（Pi CLI 扩展）改造成 DSH 插件提供精确到「服务名 / 方法名 / 代码片段 / 文件路径」的调研结论。
> 调研方式：只读检查已安装的官方包源码与真实第三方插件，未修改任何代码。
> 报告日期：以本文件落盘时间为准。调研对象为 npm 安装版 `@deepseek-ai/dsh`（内部 `node_modules/@deepseek-ai/*`）。

---

## 0. 调研材料路径一览

所有路径在本报告后文反复引用，先在此登记：

| 材料 | 路径 |
|---|---|
| DSH 安装包根 | `C:\Users\Zhannan\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` |
| 官方包（dsh-llm 等） | `C:\Users\Zhannan\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\*` |
| 官方 agent preset（standard/cordis） | `C:\Users\Zhannan\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\config\agent-presets\{standard,cordis}\agent.cordis.yml` |
| 官方 host bundle patch（dsh-base） | `...\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml` |
| 第三方插件（已装到 web profile） | `C:\Users\Zhannan\.dsh\profiles\web\node_modules\{dsh-context,dsh-sessiongraph,dsh-liquid-glass,dsh-find-plugin,dsh-mcp-panel}` |

`~/.dsh` 即 `C:\Users\Zhannan\.dsh`；web profile 的装配目录是 `C:\Users\Zhannan\.dsh\profiles\web`。

---

## A. package.json 中 `"dsh"` 字段的完整约定

三方插件（dsh-context、dsh-sessiongraph、dsh-liquid-glass）都在 package.json 里声明 `dsh` 字段，用于向 DSH 的插件装配器（reconcilePlugins）声明「本包是一个 bundle 插件，装进 profile 后要如何作为 patch layer 叠加 + 浏览器端如何注入」。

### A.1 结构总结

```jsonc
{
  "name": "my-plugin",                    // 必填；patch 里 name 通常用它
  "type": "module",                       // 官方与三方插件均为 ESM
  "main": "lib/index.js",                 // Host 半体入口
  "exports": {
    ".": "./lib/index.js",                // Host 半体
    "./client": "./lib/client.js",        // Client 半体（有 UI 时）
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // 关键：标记为 bundle 层
    "client": {                                     // 有浏览器 UI 时
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-connection", "..."]
    }
  }
}
```

### A.2 三个真实样例的字段摘录

**dsh-context** — `C:\Users\Zhannan\.dsh\profiles\web\node_modules\dsh-context\package.json`（第 35–48 行）：

```json
"dsh": {
  "bundle": {
    "patch": "./cordis.patch.yml"
  },
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-connection",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-runtime",
      "@deepseek-ai/dsh-client-ui-conversation"
    ],
    "platform": "web"
  }
}
```
同时 `main: "lib/index.js"`、`exports` 含 `"./client": "./lib/client.js"`。

**dsh-sessiongraph** — `...\dsh-sessiongraph\package.json`（第 15–27 行）：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-runtime",
      "@deepseek-ai/dsh-client-ui-slots",
      "@deepseek-ai/dsh-client-ui-layout"
    ],
    "platform": "web"
  }
}
```
（peerDependencies 声明了 `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-invariants`、`@deepseek-ai/cordis`、`react`。）

**dsh-liquid-glass**（纯 client 皮肤，没有 host 逻辑）— `...\dsh-liquid-glass\package.json`（第 24–27 行）：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web" }
}
```
（无 `client.inject`，`main` 指向 `./host.js`，host.js 甚至没有 apply 逻辑。）

### A.3 字段语义（综合官方 patch 注释归纳）

- **`dsh.bundle.patch`**：指向本包内的 cordis.patch.yml。被 `dsh plugin --profile <name> add <pkg>` 装进 profile 时，装配器把该包加入 `dsh.profile.bundles` 并**以这个 patch 文件作为该 bundle 的 layer** 叠加到现有组合上。这是「第三方程 host 插件」的唯一装配入口。
- **`dsh.client.platform`**：`"web"`。声明本包同时提供浏览器半体；web 应用会加载 `exports["./client"]` 指向的文件作为 client bundle。
- **`dsh.client.inject`**：浏览器半体依赖的 client 插件 id 列表（如 `dsh-client-connection` 提供 `ctx.connection`、`dsh-client-ui-conversation` 提供 `conversation.view` 槽、`dsh-client-ui-layout` 提供布局、`dsh-client-ui-slots` 提供 `ctx.slots`、`dsh-client-locale` 提供 `ctx.locale`）。注入顺序即加载顺序。
- 纯 host 插件（如将来的 pi-xai host 半体）**可以省略整个 `client` 块**，只留 `bundle.patch`。

**实践要点**：官方 LLM 适配器（dsh-llm-deepseek / dsh-llm-pi-ai）自己的 package.json 里**没有** `dsh` 字段——它们是「组合行（cordis.yml 的 row）加载的普通 Cordis 插件」，由 dsh-base 的 patch 以 `name: '@deepseek-ai/dsh-llm-deepseek'` 装配。也就是说第三方交付到用户手里的「bundle 插件」用 `dsh` 字段；如果要跟官方一样直接进组合，则不需要该字段、由组合作者写 row。对 pi-xai 来说，作为独立三方包交付首选 `dsh.bundle.patch` 路线。

---

## B. cordis.patch.yml 语法

DSH 的整套组合是「根组合 + 多层 patch 叠加（bundle layer）」。patch 文件与「普通组合行」的语法高度一致，区别在**操作符**（insert / 按 id 覆盖 / disabled 等）。

### B.1 官方 agent.cordis.yml 的普通行写法

组合行是 YAML 顶层数组的 entry，字段：`id`（唯一）、`name`（包名或 `name/subpath`）、`config`、`inject`、`disabled`、`group`/`isolate`。取自 `config\agent-presets\standard\agent.cordis.yml`：

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'    # !!js 内联 JS 表达式求值

- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
    backgroundMode: continuable

# 组 + 隔离域：一组行共享一个 isolate realm
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: tool-workflow
      name: '@deepseek-ai/dsh-tool-workflow'

# 子路径 name（同包内另一个插件入口）
- id: tool-subagent-list-agents
  name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
```

行语法要点（B.1）：
- `id` 是行的身份，patch 靠 id 定位；`name` 是实际插件包（或 `package/entry`）。
- `config` 是插件配置；**patch 覆盖的是整行 `config`（整块替换，不做字段级 merge）**——dsh-base patch 顶部注释明确写了这一点。
- `inject: [serviceName]` 声明该行依赖某服务（让 Loader 等它出现后再激活）。
- `disabled: true` 或 `disabled: !!js <表达式>` 进程内停用某行。
- `!!js <expr>` 是 DSH 组合的 JS 表达式语法（可访问 `process`、`ctx`、`baseUrl`、`dshHomePath()` 等），例如 `root: !!js dshHomePath('sessions')`、`port: !!js ctx.webStartup.port ?? 3080`。
- `{{model}}` / `{{cwd}}` 是 persona/提示词文本里的占位符（运行时按 agent 路由解析）。

### B.2 bundle patch 文件的两种操作

**1) `insert:` 追加新行**（三个三方插件全部如此）：

`...\dsh-context\cordis.patch.yml`（全文 10 行）：

```yaml
# dsh-context — bundle patch layer.
- insert:
    - id: dsh-context
      name: dsh-context
```

`...\dsh-sessiongraph\cordis.patch.yml`：

```yaml
- insert:
    - id: sessiongraph
      name: 'dsh-sessiongraph'
```

`...\dsh-liquid-glass\cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-liquid-glass
      name: dsh-liquid-glass
```

**2) 按 id 覆盖已有行（不写 insert）**：patch 顶层 entry 只写 `id` + 要覆盖的字段，命中已存在行时整行替换。官方范例——dsh-web-app patch（`...\dsh-web-app\cordis.patch.yml`）：

```yaml
- id: system-prompt          # 覆盖 base 的 system-prompt 行：只改 config
  config:
    persona: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

- id: hmr                    # 覆盖 base 的 hmr 行：停用
  disabled: true

- id: llm-deepseek           # dsh-headless patch：改 config
  config:
    thinking: ...            # （示意）
```

以及 dsh-headless patch（`...\dsh-headless\cordis.patch.yml`）混合示范：

```yaml
- id: system-prompt
  config:
    persona: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

- id: hmr
  disabled: true

- insert:
    - id: code-runtime
      name: '@deepseek-ai/dsh-code-runtime-worker-thread'
    - id: headless-runner
      name: '@deepseek-ai/dsh-headless'
      inject: [headlessStartup]
      config:
        task: !!js ctx.headlessStartup.task
```

### B.3 patch 语法规则汇总（可查依据：dsh-base / dsh-web-app / dsh-headless patch 头注释）

1. `- insert:` 下挂新行（`id` + `name` + 可选 `config`/`inject`/`disabled`）；无 `insert` 的顶层 entry 按 `id` 覆盖/停用已有行。
2. **覆盖是整行 `config` 整体替换**，不做 deep merge——所以「每行只在一个 bundle layer 之外再加用户层」是官方设计约束（dsh-base 注释）：「A patch replaces the targeted row's whole `config`」。
3. 多层 patch 按 bundle 叠加顺序应用，**同 id 后写胜出**；用户自己的 profile `cordis.patch.yml` 与 `--patch` 覆盖层最后应用。
4. 注释用 `#`；**行首不能是 `>`**（会被 YAML 解析成折叠标量——dsh-sessiongraph 0.1.2 踩过的坑，其 patch 注释明确记载）。
5. `disabled: true` 停用即「配置不能停用行」：dsh-base 注释说「config cannot disable a row」，停用只能靠 `disabled` 字段（或 patch 层）。
6. `name` 可以是 scoped 包名或 `包名/子入口`（如 `'@deepseek-ai/dsh-web-app/startup'`）。

### B.4 完整的 patch 示例（给 pi-xai 参考）

`cordis.patch.yml`：

```yaml
# pi-xai bundle patch: mount the pi-xai host half (provider + tools).
- insert:
    - id: pi-xai
      name: 'pi-xai'
      config:
        baseURL: https://api.x.ai/v1
```

如果要同时覆盖官方某行（例如把默认模型指向自己的 provider）：

```yaml
- insert:
    - id: pi-xai
      name: 'pi-xai'

- id: agent-default-model
  config:
    provider: pi-xai
    model: grok-4
```

---

## C. 自定义 LLM provider/model 的注册方式

### C.1 node_modules\@deepseek-ai 下所有 dsh-llm-* 包名

枚举结果：

- `dsh-llm`（核心：定义 `LlmRuntime` 服务与 `LlmAdapter` 抽象基类、StreamChunk 协议）
- `dsh-llm-deepseek`（DeepSeek 官方 chat-completions 直连适配器）
- `dsh-llm-pi-ai`（pi-ai 库包装的多 provider 适配器）
- `dsh-llm-retry`（可选的重试执行器，消费 adapter 暴露的 retryPolicy）

### C.2 核心服务与接口：dsh-llm

文件：`...\@deepseek-ai\dsh-llm\lib\index.js`（及 `lib\types\*.d.ts`）。

**服务名：`llm`**（`LlmRuntime extends Service`，`super(ctx, "llm")`，第 919–925 行）。

**provider 注册 API（全部在 `ctx.llm` 上）**：

| 方法 | 签名 / 行为 |
|---|---|
| `registerAdapter(providers, adapter)` | `(string[], LlmAdapter) => handle`。一次性注册多个 provider 路由，同名路由抛 `LlmError('DUPLICATE_ADAPTER')`；返回的 handle 是 disposer，另有 `handle.replace(nextProviders)` 可原地换路由。第 956 行。 |
| `registerConfigurableProviders(entries)` | `({provider, displayName, settingsNs, settingsPath}[]) => handle`。把「用户可在设置里配置的 provider」登记进目录（Models 页面才会显示/可编辑）。第 1033 行。 |
| `registerModelDiscovery(settingsNs, discover)` | `(string, (request) => Promise<models[]>) => disposer`。为某个 settings 命名空间注册「探测端点模型列表」的回调。第 1097 行。 |
| `discoverModels(settingsNs, request)` | 调用上面注册的 discovery。第 1117 行。 |
| `listProviders()` | 返回已注册 provider 的 `{id, name}[]`。第 1022 行。 |
| `listConfigurableProviders()` | 返回目录条目（含 `settingsPath` 拷贝）。第 1081 行。 |
| `listModels(provider)` | 异步返回该 provider 的 `{provider,id,name,description?,inputModalities?}[]`（advisory 目录，不参与路由校验）。第 1154 行。 |
| `resolveModelInfo(provider, model, signal)` | 精确解析单模型的 `{provider,id,name,description?,inputModalities?,context?:{contextWindow},defaultMaxTokens?,reasoning?:{efforts,defaultEffort?}}`。第 1179 行。 |
| `providerRetryPolicy(provider)` | 取该 provider 注册时捕获的重试策略。第 1141 行。 |
| `resolveCallConfig(config, signal)` | 校验 call config 并落默认值（独立查询，不绑定 dispatch）。第 1232 行。 |
| `prepareCall(config, signal)` | 返回 `{config, retryPolicy, adapterDefaults, context?, stream(options)}` 的一次性句柄（HMR 安全：能力解析与流分发绑定同一注册）。第 1269 行。 |
| `stream(options)` | 流式调用入口，经 `llm/stream` waterfall 包裹。第 1385 行。 |
| `forAdapter(options, adapter)` | 去掉不属于该 adapter 的历史 replayState。第 1301 行。 |

**`LlmAdapter` 抽象基类**（第 870–914 行）——第三方 provider 要继承并实现：

```js
var LlmAdapter = class {
  providerInfo(provider) {
    return { id: provider, name: provider };       // id 必须 === provider
  }
  providerRetryPolicy(_provider) {}                 // 返回 RetryPolicy 或 undefined
  listModels(_provider) {                           // 可选；advisory 目录
    return Promise.resolve([]);
  }
  resolveModel(provider, model, _signal) {          // 精确模型元数据
    return Promise.resolve({ provider, id: model, name: model });
  }
  async *stream(options) { /* 必须实现 */ }         // GenerateOptions → AsyncGenerator<StreamChunk>
};
```

**请求类型 `GenerateOptions`**（`lib\types\types.d.ts` 第 312–348 行）——`stream()` 收到的 options 字段：

```ts
interface GenerateOptions {
  provider: string;                 // 注册的路由名
  model: string;
  reasoningEffort?: ReasoningEffortId;   // 品牌化字符串（'off'|'high'|...）
  messages: Message[];              // 会话历史（source 携带 provider/model/replayState）
  system?: string;                  // 系统提示
  tools?: ToolSchema[];             // {name, description, parameters: Record<string, unknown>}
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  signal?: AbortSignal;
  sessionId?: Branded<'SessionId'>;
  purpose?: 'compaction' | 'session-title';   // 次要调用分类
}
```

**StreamChunk 协议**（adapter 的 `stream()` 需要 yield 的 chunk 形状，`types.d.ts` 第 245–297 行附近）：

```ts
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }               // {inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens?}
  | { type: 'finish'; reason: FinishReason; replayState?: unknown }
// FinishReason: {kind:'stop'} | {kind:'max-tokens'} | {kind:'tool-calls'} | {kind:'error',failure} | {kind:'aborted',failure}
```

**错误约定**：抛 `LlmError(message, code, {status?, providerRetryAfterMs?, requestId?, cause?})`。标准 code 有 `AUTH`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`CONTEXT_WINDOW_EXCEEDED`、`QUOTA`、`EMPTY_RESPONSE` 等（`lib/index.js` 第 816–840 行、245–267 行）。**每个请求必须带 `attributionHeaders()`（user-agent）**（第 656–667 行注释强调）。

**RetryPolicySchema**（`z.object`）：`{mode:'normal'|'always', maxRetries?, retryableCodes?, backoff:{initialDelayMs?,maxDelayMs?,jitterRatio?}}`，从 `@deepseek-ai/dsh-llm` 导出（第 383 行）；用 `resolveRetryPolicy(config, path)` 归一化。

**辅助函数导出**：`assertUsableApiKey(raw, pkg, ref)`、`contentHasImage`、`isContextWindowExceededError`、`isQuotaExceededError`、`BlockAssembler`（增量组装 chunk→message 的通用实现，可直接复用）、`createMessage/createUserMessage/createAssistantMessage/createToolResultMessage`、品牌函数 `CallId/MessageId/ReasoningEffortId`。

### C.3 直连型 provider 的真实范例：dsh-llm-deepseek

文件：`...\@deepseek-ai\dsh-llm-deepseek\lib\index.js`。这是**最小的完整第三方 provider 参考模板**（fetch + SSE，无第三方 SDK）。

**插件入口导出**（第 627–628、719–781 行）：

```js
const name = "llm-deepseek";
const inject = ["llm"];
const NS = settingsNamespace("llm-deepseek");        // settings 命名空间
const PROVIDER = "deepseek-official";                // 本插件唯一 provider 路由
const DEFAULT_MODELS = [
  { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", contextWindow: 1_000_000 },
  { id: "deepseek-v4-pro",   name: "DeepSeek-V4-Pro",   contextWindow: 1_000_000 },
];

const Config = z.object({                            // Schemastery schema（= 插件 config + settings 段 schema）
  apiKeyEnv: z.string().role("credential-ref").default("DEEPSEEK_API_KEY"),
  baseURL: z.string(),
  thinking: z.union(["enabled", "disabled"]),
  reasoningEffort: z.union(["off", "high", "max"]),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(256000),
  defaultContextWindow: z.number().step(1).min(1).default(1_000_000),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(300000),
  retryPolicy: RetryPolicySchema,
});

function apply(ctx, config) {
  // config 解析成 connection facts（options thunk），随 launch-env/settings 热更新
  // 凭据：每次请求经 ctx.credentials.resolve(ref)（可选）或 launchEnvironmentOf(ctx).get(ref)
  const resolveApiKey = async (connection) => {
    const ref = connection.apiKeyEnv;
    const credentials = ctx.get("credentials");
    if (credentials !== void 0) {
      const hit = await credentials.resolve(ref);
      if (hit !== void 0) return assertUsableApiKey(hit.value, "llm-deepseek", ref);
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref);
      if (ambient !== void 0 && ambient.value.length > 0) return assertUsableApiKey(ambient.value, "llm-deepseek", ref);
    }
    throw new LlmError(`no API key for provider route "${PROVIDER}"...`, "MISSING_CREDENTIAL");
  };

  const adapter = new DeepSeekAdapter({ options, resolveApiKey, resolveUserId });

  // 1) 声明可配置 provider（Models 页面能显示/编辑本路由）
  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER, displayName: "DeepSeek", settingsNs: NS, settingsPath: [],
  }]);

  // 2) 注册适配器路由（返回 disposer；retryPolicy 变了就 registration.replace([PROVIDER]) 原地重注册）
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);

  // 3) 挂 settings 段：llm-deepseek: 段覆盖 config，热更新（config 变了 options() 自动换）
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => { current = source; },
    onChange: ensureRegistrationFacts,
  });
}
```

**`DeepSeekAdapter.stream(options)` 的完整骨架**（第 527–569 行 + request 第 570–611 行）——这是自定义 provider 必须实现的核心：

```js
async *stream(options) {
  const connection = this.config.options();        // 当前连接事实（每次请求现取）
  const apiKey = await this.config.resolveApiKey(connection);
  const watchdog = idleWatchdog(...);              // 流空闲看门狗（dsh-timeout）
  const iterator = this.request(options, watchdog.signal, connection, apiKey, userId, ...)[Symbol.asyncIterator]();
  while (true) {
    const result = await watchdog.next(iterator);
    if (result.done) return;
    yield result.value;                            // 透传 translate() 产的 StreamChunk
  }
}

async *request(options, signal, connection, apiKey, userId, onComment) {
  const body = serializeRequest(options, connection.defaults);   // 消息/工具转 wire JSON
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "accept": "text/event-stream",
    ...attributionHeaders(),                      // 强制 attribution
    ...
  };
  const response = await fetch(`${connection.baseURL}/chat/completions`, { method: "POST", headers, body, signal });
  if (!response.ok) throw new LlmError(message, httpErrorCode(response.status, providerError), {...});
  yield* translate(parseSse(response.body, onComment));   // SSE → StreamChunk
}
```

**模型无特殊 SDK/协议时**：照抄 `serializeRequest`（OpenAI-compatible：`{model, messages, stream:true, tools:[{type:'function',function:{name,description,parameters}}], temperature, max_tokens, stop}`）+ `translate`（SSE delta → block-start/text-delta/tool-call-delta/block-end/usage/finish）即可。

### C.4 库包装型 provider 的真实范例：dsh-llm-pi-ai

文件：`...\@deepseek-ai\dsh-llm-pi-ai\lib\index.js`。同一接口上更丰富的形态（一插件多路由、路由目录动态增删、模型发现）：

```js
const name = "llm-pi-ai";
const inject = ["llm"];
const NS = settingsNamespace("llm-pi-ai");

function apply(ctx, config) {
  const profiles = () => { /* 解析 config.providers → Map<provider, profile> */ };
  const resolveApiKey = async (provider, profile) => {
    const ref = profile.apiKeyEnv;
    if (ref === void 0) return void 0;                       // 无引用 → 交给 pi-ai 自身环境发现
    const credentials = ctx.get("credentials");
    const hit = credentials !== void 0 ? (await credentials.resolve(ref))?.value
                                      : launchEnvironmentOf(ctx).get(ref)?.value;
    if (hit !== void 0 && hit.length > 0) return assertUsableApiKey(hit, "llm-pi-ai", ref);
    throw new LlmError(`...MISSING_CREDENTIAL`);
  };
  const adapter = new PiAiAdapter({ profiles, resolveApiKey, resolveAttachments: () => ctx.get("attachments") });

  // 目录：每 provider 一个设置路径 { provider, displayName, settingsNs: NS, settingsPath: ['providers', provider] }
  let directory;
  const ensureDirectory = () => {
    const entries = directoryEntries(profiles());
    if (directory === void 0) directory = ctx.llm.registerConfigurableProviders(entries);
    else directory.replace(entries);
  };
  ensureDirectory();

  ctx.llm.registerModelDiscovery(NS, (request) => discoverModels(request, ...));

  // 路由集变化时整组 re-register（同一 adapter 实例）
  let registration;
  const ensureRegistrationFacts = () => {
    const routes = [...profiles().keys()];
    if (registration === void 0) registration = ctx.llm.registerAdapter(routes, adapter);
    else registration.replace(routes);
  };
  ensureRegistrationFacts();

  installSettingsSection(ctx, NS, Config, config, {
    validate: assertServiceable,
    setSource: (source) => { current = source; },
    onChange: () => { ensureRegistrationFacts(); ensureDirectory(); },
  });
}
```

**该实现用 pi-ai 的 `createModels()` / `models.setProvider(provider)` / `models.streamSimple(model, context, opts)`；若 pi-xai 走自有 SDK，则直接用 fetch/SSE 与 C.3 同构。**

### C.5 官方组合里的 LLM 行（如何把 provider 装进 profile）

dsh-base patch（`...\dsh-base\cordis.patch.yml`）第 24–26、88–96、450–451 行：

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm'          # 必须先有这个核心服务行

- id: llm-pi-ai                         # pi-ai 多 provider 适配器（dormant，零路由）
  name: '@deepseek-ai/dsh-llm-pi-ai'

- id: llm-deepseek                      # 直连 DeepSeek 适配器
  name: '@deepseek-ai/dsh-llm-deepseek'
```

设置覆盖（Models 页面写入 `$DSH_HOME/settings.yaml`）：

```yaml
llm-deepseek:
  apiKeyEnv: DEEPSEEK_API_KEY
  baseURL: https://api.deepseek.com
llm-pi-ai:
  providers:
    openai:
      apiKeyEnv: OPENAI_API_KEY
```

对 pi-xai：要么让组合作者加一行 `- id: llm-pi-xai / name: 'pi-xai'`，要么（三方交付）patch 里 `insert` 该行。设置段用 `pi-xai:` 命名空间（= settingsNamespace 返回值）。

---

## D. 自定义 agent 工具注册

### D.1 服务与注册 API：dsh-tools

文件：`...\@deepseek-ai\dsh-tools\lib\index.js`（运行时）+ `lib\types\index.d.ts` / `schema.d.ts`（类型）。

**服务名：`tools`**（`ToolRuntime extends Service`，`super(ctx, "tools")`，第 2585 行）。

**注册方法（第 2755 行附近，.d.ts 第 603 行）**：

```ts
register(definition: ToolDefinition): () => void
// 全局注册（或经 agent.ctx 的 scoped 注册，同 scope 同名抛错，保留 run_code 名）
```

**`ToolDefinition` 形状**（`index.d.ts` 第 106–172 行；`extends ToolSchema` = `{name, description, parameters}`）：

```ts
interface ToolDefinition extends ToolSchema {
  output: ToolOutputDefinition;        // { schema: JsonSchemaNode, render(args, value): ContentBlock[], presentationMeta? }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
  finalizeContent?(exec, result): ContentBlock[] | undefined;
  timeoutMs?: number;
  isConcurrencySafe?(args): boolean;
  presentCall?(args): ToolCallView | undefined;
  presentResult?(args, result): ToolResultView | undefined;
}
```

**首选工厂 `defineTool(options)`**（`schema.d.ts` 第 239 行）——提供类型推断 + 参数校验 + 输出 schema 校验：

```ts
defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>({
  name: string;                      // 唯一
  description: string;               // 发给模型的描述
  parameters: S;                     // 属性 → JSON Schema 的隐式 open object root
  output: {
    schema: O;                       // 输出 schema
    render(args, value): ContentBlock[];
    presentationMeta?(args, value): JsonValue;
  };
  timeoutMs?: number;
  isConcurrencySafe?(args): boolean;
  execute(args, exec): Promise<value>;      // exec: ToolRunContext {callId, name, arguments, agent?, signal, deferContext(ctx), concludeTurn()}
  finalizeContent?; presentCall?; presentResult?;
});
```

**Schema DSL：既不是 zod 也不是裸 JSON Schema，而是自建 `ValueSchemaSpec` + Schemastery 编译**。节点类型见 `schema.d.ts` 第 20–72 行：

```ts
type ValueSchemaSpec =
  | { type: 'string'   ; enum?: readonly string[];  const?: string }
  | { type: 'number'   ; enum?: readonly number[];  const?: number }
  | { type: 'integer'  ; enum?: readonly number[];  const?: number }
  | { type: 'boolean'  ; enum?: readonly boolean[]; const?: boolean }
  | { type: 'null'     ; enum?: readonly null[];    const?: null }
  | { type: 'array'    ; items?: ValueSchemaSpec }
  | { type: 'object'   ; properties?: ParameterSchemaSpec; additionalProperties: boolean }
  | { type: 'json'     }                                    // 任意 lossless JSON
  | { oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...] }
// 每个节点可带 description/title/default/examples 注解
// ParameterSchemaSpec = { [key]: (ValueSchemaSpec & { required?: true }) }
```

对象的 `additionalProperties` 是**必填**；参数对象根是隐式 open。官方还导出 `validateArgs` / `valueSchemaSpecToJsonSchema` / `ToolArgsError`。**底层接受裸 JSON Schema**（`output.schema` 类型就是 `JsonSchemaNode`；`assertSupportedJsonSchema` / `assertObjectJsonSchema` / `validateJsonSchemaValue` 可用于原始注册）。

**执行上下文 `exec`（ToolRunContext）关键字段**：`exec.agent`（Agent）、`exec.signal`、`exec.callId`、`exec.arguments`、`exec.deferContext(userMessage)`、`exec.concludeTurn()`。

### D.2 真实第三方范例：dsh-sessiongraph 注册 `sessiongraph_debug` 工具

文件：`C:\Users\Zhannan\.dsh\profiles\web\node_modules\dsh-sessiongraph\lib\index.js`（第 255–321 行）：

```js
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'dsh-sessiongraph';
export const inject = ['sessionProjections', 'tools', 'agents'];

export function apply(ctx) {
  // ……会话投影逻辑……

  const tool = defineTool({
    name: 'sessiongraph_debug',
    description: 'SessionGraph 验证工具:读取当前会话的图投影快照(分类节点流/游标)与切换记录。',
    parameters: {},                              // 无参数：空对象
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const agent = exec.agent;
      if (!agent) return { error: 'exec.agent 缺失' };
      // ……读投影、拼 JSON……
      return { sessionId: agent.id, nodeCount: ..., ... };   // 返回 lossless JSON 值
    },
  });
  ctx.tools.register(tool);                      // 全局注册，随 fiber dispose 自动注销
}
```

注意该例中 `output.schema` 直接用了裸 JSON Schema 对象 `{ type: 'object', additionalProperties: true }`——证明 **DSL 与裸 JSON Schema 可以混用**（DSL 节点本身就是 JSON Schema 的超集投影）。

### D.3 工具注册结论

- 注册入口：`ctx.tools.register(defineTool({...}))`；`inject: ["tools"]` 直接依赖，或 `ctx.get('tools')` 惰性拿（dsh-sessiongraph 用 `ctx.on('ready')` 兜底）。
- schema：**首选 dsh-tools 的 `ValueSchemaSpec` DSL**（`type:'object'` 必须带 `additionalProperties`，必填属性用 `required: true`）；也接受裸 JSON Schema。不是 zod（zod 只在 config/llm 侧用，工具 schema 不用）。
- execute 必须返回 **lossless JSON 值**（registry 会校验 `output.schema` 并冻结）；render 把值投影成 `ContentBlock[]` 给模型看。
- `inject` 里声明 `tools` 即可在 host 侧注册；工具自动进入 agent 工具目录（配合 `tools/schemas()` 白名单：只有 name/description/parameters 发往模型）。

---

## E. 命令注册（/slash 命令）

### E.1 服务与 API：dsh-commands

文件：`...\@deepseek-ai\dsh-commands\lib\index.js`（运行时）+ `lib\types\index.d.ts`。

**服务名：`commands`**（`CommandRuntime extends TypertRemoteService`，`super(ctx, "commands")`，第 235 行）。

**注册方法（第 242 行）**：

```ts
register(definition: CommandDefinition): () => void
// definition: {
//   name: string;          // /^[a-z][a-z0-9_-]*$/（无斜杠）
//   description: string;   // 非空
//   input?: { hint: string };
//   recordInput?: boolean; // 默认 true
//   handler(invocation): CommandResult | Promise<CommandResult>;
// }
// CommandResult = { kind:'success', text?, sourceEventSeq? } | { kind:'error', text }
// invocation = { commandId, agent, rawInput, signal }
```

命令名正则：`/^[a-z][a-z0-9_-]*$/u`（第 68 行）。全局/作用域分层：普通 ctx 注册全局；经 agent 作用域注册可 shadow 全局。

### E.2 真实范例：dsh-command-compact 注册 `/compact`

文件：`...\@deepseek-ai\dsh-command-compact\lib\index.js`（第 77–98 行）：

```js
const name = "command-compact";
const inject = ["commands", "compaction"];

function apply(ctx) {
  const active = new Set();
  const handler = (invocation) => {
    const operation = executeCompact(ctx, invocation);   // 返回 Promise<CommandResult>
    active.add(operation);
    operation.then((r) => active.delete(operation), () => active.delete(operation));
    return operation;
  };
  ctx.effect(function* () {                              // Cordis effect 生命周期：dispose 时注销
    yield async () => { await Promise.allSettled(active); };
    yield ctx.commands.register({
      name: "compact",
      description: "Compact older conversation history",
      handler
    });
  }, "command-compact lifecycle");
}
```

handler 返回简例（同文件 executeCompact 内）：

```js
return { kind: "success", text: `Compacted ${n} history items`, sourceEventSeq: result.summarySeq };
// 或 { kind: "error", text: "Compaction is unavailable..." }
```

**客户端的命令 UI 由 `@deepseek-ai/dsh-client-ui-commands` 负责**（`/` 输入触发 → 命令面），host 只负责 `commands.register`。

---

## F. 客户端 UI 挂载方式

### F.1 机制总览

- 插件包带 `exports["./client"]` 指向的 client bundle（`lib/client.js`），配合 package.json 的 `dsh.client.platform: "web"` 与 `dsh.client.inject`（见 A 节）进入浏览器。
- client bundle 结构（dsh-context 的 client.js 第 1–6 行）：包一层 `window.__ModuleLoader__.load({ id, factory })`，factory 内 `module.exports = { name, inject: [...], apply(ctx) }`。
- UI 挂载核心：**`ctx.slots`**（来自 `@deepseek-ai/dsh-client-ui-slots`）→ `ctx.slots.inject(slotName, () => ctx.slots.register({ name, id, order, label }, Component))`。
- 与 host 通信用 **`ctx.connection.rpc`**（来自 `@deepseek-ai/dsh-client-connection`）：client `ctx.connection.rpc.call("/channel", "endpoint", payload)`；host 侧 `ctx.connection.rpc.handle("/channel", async (endpoint, payload) => {...}, { authority: "trusted-host" })`。
- 文案用 `ctx.locale.register("ns", {zh, en})` + `ctx.locale.bind("ns")`；样式用 `document.head.appendChild(style)`（effect 内清理）。

### F.2 真实范例：dsh-context client（面板挂到 conversation.view 槽）

文件：`C:\Users\Zhannan\.dsh\profiles\web\node_modules\dsh-context\lib\client.js`（第 1019–1047 行）：

```js
function apply(ctx) {
  ctx.effect(() => {
    return ctx.locale.register("dsh-context", { zh: DICT_ZH, en: DICT_EN });   // 双语词典
  }, "dsh-context: dictionaries");
  const t = ctx.locale.bind("dsh-context");
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.setAttribute("data-plugin", "dsh-context");
    tag.textContent = STYLES;                                   // 注入 CSS
    document.head.appendChild(tag);
    return () => { if (tag.parentNode) tag.parentNode.removeChild(tag); };
  }, "dsh-context: styles");
  const ContextView = makeContextView(ctx, makeViewKit(t));      // React 组件（createElement，非 JSX）
  ctx.slots.inject("conversation.view", () => {                  // 指定槽位
    return ctx.slots.register(
      { name: "conversation.view", id: "context", order: 20, label: () => t("tab") },
      (props) => h(ContextView, props)                           // 槽位渲染函数
    );
  });
}
module.exports = { name: "dsh-context", inject: ["connection", "slots", "locale"], apply };
```

Host 侧对应的 RPC 通道（`dsh-context\lib\index.js` 第 358–388 行）：

```js
const name = "dsh-context";
const inject = ["connection"];
function apply(ctx) {
  ctx.effect(() => {
    return ctx.connection.rpc.handle(
      "/dsh-context",                                            // 通道名
      async (endpoint, payload) => {                             // endpoint: "snapshot"
        if (endpoint !== "snapshot") return { ok: false, error: { code: "internal", message: `unknown endpoint: ${endpoint}`, details: {} } };
        const sessionId = payload?.sessionId;
        const value = await computeSnapshot(ctx, states, sessionId);
        return { ok: true, value };
      },
      { authority: "trusted-host" }
    );
  }, "dsh-context: rpc channel");
}
```

Client 端调用（同文件 client.js 第 816 行）：`ctx.connection.rpc.call("/dsh-context", "snapshot", { sessionId }).then((res) => {...})`。

### F.3 纯 client 插件（无 host 逻辑时）

dsh-liquid-glass（皮肤）只提供 client.js + `dsh.client.platform`，host.js 无 apply。如果你只想给 pi-xai 加个设置面板，可以做成「host 半体注册 provider/工具 + client 半体挂 `conversation.view`（chat 旁的 tab）或设置槽」的 hybrid。

---

## G. 凭据（credentials）与设置（settings）服务

### G.1 credentials 服务

文件：`...\@deepseek-ai\dsh-credentials\lib\index.js`（抽象基类 + `credentialRef` 品牌函数）+ `...\dsh-credentials-local\lib\index.js`（具体实现：先 `$DSH_HOME/.credentials.yaml` → 继承环境 → 项目/用户 .env）。

**服务名：`credentials`**。抽象基类定义四个操作（由 dsh-credentials-local 实现；面向消费者的签名）：

```ts
// 凭据引用：一个 POSIX 风格环境变量名（如 "XAI_API_KEY"）
credentialRef(value: string): string;          // 校验 /^[A-Za-z_][A-Za-z0-9_]*$/ 并品牌化

// 消费者只调用：
const hit = await ctx.credentials.resolve(ref);   // => { value: string } | undefined（空值=未配置）
```

- 用法范式（dsh-llm-deepseek `resolveApiKey`，第 740–751 行）：`ctx.get("credentials")` 可选拿服务 → `await credentials.resolve(ref)` → 命中则 `assertUsableApiKey(hit.value, pkg, ref)`。
- 未装 credentials 服务时的兜底：`launchEnvironmentOf(ctx).get(ref)?.value`（读环境变量，见同一函数）。
- 事件：`credentials/updated`（emit，ref 为载荷）。空存储值在任何地方都视为未配置（一处全局规则）。
- config schema 里声明凭据字段用 `z.string().role("credential-ref")`，让 Models 页面按凭据引用渲染。

### G.2 settings 服务

文件：`...\@deepseek-ai\dsh-settings\lib\index.js`（+ `dsh-settings-file` 提供 `$DSH_HOME/settings.yaml` 持久化）。

**服务名：`settings`**。主打函数：

```ts
settingsNamespace(value: string): string;      // 品牌化命名空间名（如 "llm-pi-ai"、"pi-xai"）

// 常用组合 API —— 官方推荐的「可选 settings 消费者」接线（dsh-llm-deepseek 等都在用）：
installSettingsSection(ctx, ns, schema, entryConfig, hooks: {
  validate?(resolved): void;                    // 可选：对解析后的值做整体校验，失败拒写
  setSource(sourceThunk): void;                 // hooks 里把 current 指针换成 scope.get()
  onChange(): void;                             // 设置变化时触发（re-register adapter 等）
});
// 内部实现：ctx.inject(['settings'], sctx => {
//   const scope = sctx.settings.register(ns, schema, { base: entry, ...validate });
//   hooks.setSource(() => scope.get());
//   scope.watch(() => hooks.onChange()); ...
// })

// settings 服务本身的注册方法：
settings.register(ns, schema, { base?, applies?, validate? })
//   => { get(): resolved, watch(cb): disposer, update(patch), replace(section) }
```

- 语义：`register` 把命名空间 `ns` 用 `schema`（Schemastery）解析「组合 base 层 + 用户层」，返回 owner scope；`get()` 拿当前解析值，`watch` 订阅变化，`update/replace` 写用户层。
- `settingsNamespace` 名字段就是设置文档里的顶层键（如 `llm-deepseek:`、`llm-pi-ai:`、`pi-xai:`），也是 `registerConfigurableProviders` 的 `settingsNs`。
- config schema 同时在「插件 config」与「settings 段」复用——`apply(ctx, config)` 的 `config` 就是组合行 config；`installSettingsSection` 把它作为 base 层，用户 settings.yaml 覆盖之。

### G.3 pi-xai 的最小接线组合

```js
const NS = settingsNamespace('pi-xai');
const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('XAI_API_KEY'),
  baseURL: z.string().default('https://api.x.ai/v1'),
  model: z.string(),           // 或 models 数组 + defaultContextWindow/maxTokens
  retryPolicy: RetryPolicySchema,
});
```

---

## 可直接参考的真实代码片段（精选 3 段）

### 片段 1：完整 provider 插件入口（host 注册 adapter + configurable provider + settings 接线）

来源：`@deepseek-ai/dsh-llm-deepseek`，`lib/index.js` 第 719–779 行（省略内部细节后的实录骨架）：

```js
function apply(ctx, config) {
  let current = () => config;
  const options = () => resolveAdapterOptions(current(), launchEnvironmentOf(ctx));  // 连接事实（每次现取）
  const resolveApiKey = async (connection) => {
    const ref = connection.apiKeyEnv;
    const credentials = ctx.get("credentials");
    if (credentials !== void 0) {
      const hit = await credentials.resolve(ref);
      if (hit !== void 0) return assertUsableApiKey(hit.value, "llm-deepseek", ref);
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref);
      if (ambient !== void 0 && ambient.value.length > 0) return assertUsableApiKey(ambient.value, "llm-deepseek", ref);
    }
    throw new LlmError(`llm-deepseek: no API key for provider route "${PROVIDER}"; ...`, "MISSING_CREDENTIAL");
  };
  const adapter = new DeepSeekAdapter({ options, resolveApiKey, resolveUserId });
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: "DeepSeek", settingsNs: NS, settingsPath: [] }]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => { current = source; },
    onChange: ensureRegistrationFacts,          // retryPolicy 变化时 registration.replace([PROVIDER])
  });
}
```

### 片段 2：adapter 的 stream() 最小实现（fetch + SSE → StreamChunk）

来源：`@deepseek-ai/dsh-llm-deepseek`，`lib/index.js` 第 527–611 行（浓缩）：

```js
async *stream(options) {
  const connection = this.config.options();
  const apiKey = await this.config.resolveApiKey(connection);
  const watchdog = idleWatchdog(AbortSignal.any([options.signal, new AbortController().signal]),
                                connection.streamIdleTimeoutMs, "LLM_STREAM_IDLE_TIMEOUT");
  const iterator = this.request(options, watchdog.signal, connection, apiKey, ...)[Symbol.asyncIterator]();
  while (true) {
    const result = await watchdog.next(iterator);
    if (result.done) return;
    yield result.value;
  }
}
// wire 请求（OpenAI-compatible chat/completions，SSE）
async *request(options, signal, connection, apiKey, userId, onComment) {
  const body = serializeRequest(options, connection.defaults);      // {model, messages, stream:true, tools, temperature, max_tokens, stop}
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json",
                    "accept": "text/event-stream", ...attributionHeaders() };
  const response = await fetch(`${connection.baseURL}/chat/completions`, { method: "POST", headers, body, signal });
  if (!response.ok) throw new LlmError(message, httpErrorCode(response.status, providerError), {...});
  yield* translate(parseSse(response.body, onComment));             // SSE payload → StreamChunk 流
}
```

### 片段 3：defineTool 注册一个模型可见工具（第三方真实用法）

来源：`dsh-sessiongraph`，`C:\Users\Zhannan\.dsh\profiles\web\node_modules\dsh-sessiongraph\lib\index.js` 第 255–321 行（摘录）：

```js
import { defineTool } from '@deepseek-ai/dsh-tools';

const tool = defineTool({
  name: 'sessiongraph_debug',
  description: 'SessionGraph 验证工具:读取当前会话的图投影快照(分类节点流/游标)与切换记录。',
  parameters: {},
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  async execute(args, exec) {
    const agent = exec.agent;
    if (!agent) return { error: 'exec.agent 缺失' };
    const snap = ctx.get('sessionProjections').snapshot(agent.session);
    // ……计算……
    return { sessionId: agent.id, nodeCount: ..., nodes: [...] };    // lossless JSON
  },
});
ctx.tools.register(tool);
```

---

## 最小 DSH 插件清单（host 注册 1 个自定义 LLM provider + 1 个工具）

以「pi-xai 作为独立三方 bundle 插件」交付时的最小文件集与内容：

```
pi-xai/
├── package.json          # 见下
├── cordis.patch.yml      # insert 一行挂载 pi-xai
├── lib/
│   └── index.js          # Host 半体：export { name, inject, apply }
└── (可选)
    ├── lib/client.js     # 浏览器半体（设置面板/状态 UI 时需要）
    └── index.ts → tsc/build 产出 lib/（官方与三方都从 src 构建到 lib）
```

### package.json

```json
{
  "name": "pi-xai",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./package.json": "./package.json" },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-llm": "^0.1.0-rc.6",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.6",
    "@deepseek-ai/dsh-credentials": "^0.1.0-rc.6",
    "@deepseek-ai/dsh-settings": "^0.1.0-rc.6",
    "@deepseek-ai/dsh-launch-environment": "^0.1.0-rc.6",
    "@deepseek-ai/dsh-timeout": "^0.1.0-rc.6"
  },
  "dependencies": { "@deepseek-ai/schemastery": "^3.18.1" }
}
```

### cordis.patch.yml

```yaml
- insert:
    - id: pi-xai
      name: 'pi-xai'
```

### lib/index.js 内容清单

```js
import { LlmAdapter, LlmError, attributionHeaders, RetryPolicySchema, resolveRetryPolicy, assertUsableApiKey } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { settingsNamespace, installSettingsSection } from '@deepseek-ai/dsh-settings';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import z from '@deepseek-ai/schemastery';

export const name = 'pi-xai';
export const inject = ['llm'];                       // 硬依赖 llm 服务

const NS = settingsNamespace('pi-xai');
const PROVIDER = 'pi-xai';
const Config = z.object({                            // = 插件 config + settings 段共用 schema
  apiKeyEnv: z.string().role('credential-ref').default('XAI_API_KEY'),
  baseURL: z.string().default('https://api.x.ai/v1'),
  defaultContextWindow: z.number().step(1).min(1).default(131072),
  maxTokens: z.number().step(1).min(1).default(8192),
  models: z.array(z.object({ id: z.string().required(), name: z.string(), contextWindow: z.number().step(1).min(1), maxTokens: z.number().step(1).min(1) })).default([{ id: 'grok-...', name: '...' }]),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(2147483647).default(300000),
  retryPolicy: RetryPolicySchema,
});

class PiXaiAdapter extends LlmAdapter {
  constructor(config) { super(); this.config = config; }
  providerInfo(provider) { return { id: provider, name: 'Pi xAI' }; }
  providerRetryPolicy(provider) { return this.config.options().retryPolicy; }
  listModels(provider) { return Promise.resolve(this.config.options().models.map((m) => ({
    provider, id: m.id, name: m.name ?? m.id, inputModalities: ['text'] }))); }
  resolveModel(provider, model) { const c = this.config.options(); const m = c.models.find((x) => x.id === model);
    return Promise.resolve({ provider, id: model, name: m?.name ?? model, inputModalities: ['text'],
      context: { contextWindow: m?.contextWindow ?? c.defaultContextWindow },
      defaultMaxTokens: m?.maxTokens ?? c.maxTokens }); }
  async *stream(options) {
    // 1) 解析连接事实 + 凭据（ctx 注入的 resolveApiKey 闭包）
    // 2) 消息/tools → wire JSON（OpenAI-compatible 照抄 dsh-llm-deepseek serializeRequest）
    // 3) fetch(`${baseURL}/chat/completions`, {...headers, body, signal})（必须带 attributionHeaders()）
    // 4) SSE → StreamChunk（text-delta / tool-call-delta / usage / finish）
    // 5) 结束或错误：yield {type:'usage'} + {type:'finish', reason}; 抛 LlmError(code) 分类
  }
}

export function apply(ctx, config) {
  let current = () => config;
  const options = () => resolveAdapterOptions(current(), launchEnvironmentOf(ctx));  // 校验+默认
  const resolveApiKey = async () => {
    const ref = options().apiKeyEnv;
    const credentials = ctx.get('credentials');
    const hit = credentials !== void 0 ? (await credentials.resolve(ref))?.value
                                       : launchEnvironmentOf(ctx).get(ref)?.value;
    if (hit !== void 0 && hit.length > 0) return assertUsableApiKey(hit, 'pi-xai', ref);
    throw new LlmError(`no API key for provider route "${PROVIDER}"; store ${ref} ...`, 'MISSING_CREDENTIAL');
  };
  const adapter = new PiXaiAdapter({ options, resolveApiKey });
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: 'Pi xAI', settingsNs: NS, settingsPath: [] }]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  installSettingsSection(ctx, NS, Config, config, { setSource: (s) => { current = s; }, onChange: () => {} });

  // —— 第二个输出：一个工具 ——
  ctx.tools.register(defineTool({
    name: 'pi_xai_status',
    description: '查询 pi-xai 当前用量/配额状态。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true },
              render: (a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    async execute(args, exec) { /* 复用 pi-xai 的 usage/status 逻辑 */ return {...}; },
  }));
}
```

### 装配方式（二选一）

1. **三方 bundle 方式**（推荐独立交付）：`dsh plugin --profile web add <路径或 git 仓库>` → 自动读 `dsh.bundle.patch` 叠加。
2. **直接组合行**（想进官方组合时）：在 profile 的 `cordis.patch.yml` 或 host 组合里加：

```yaml
- insert:
    - id: pi-xai
      name: 'pi-xai'
```

前提：`llm` 核心行已在组合中（官方 dsh-base 已有 `- id: llm / name: '@deepseek-ai/dsh-llm'`）。

### 校验清单

- [ ] `inject: ['llm']`；provider 路由名唯一（与 dsh-llm-deepseek/pi-ai 不冲突）。
- [ ] `registerAdapter` 用 `ctx.effect` 包裹（官方实现如此），随 fiber dispose 自动注销。
- [ ] `stream()` 尊重 `options.signal`；每个 HTTP 请求带 `attributionHeaders()`。
- [ ] `stream()` 必须 emit `{type:'usage'}` + `{type:'finish'}` 收尾；错误用规范 LlmError code。
- [ ] schema DSL 对象节点带 `additionalProperties`；工具返回 lossless JSON。
- [ ] 凭据字段用 `z.string().role('credential-ref')`；读取走 `credentials.resolve` → `launchEnvironmentOf` 兜底。

---

## 附：与 pi-xai 改造直接相关的关键结论

1. **LLM 层**：把 pi-xai 的流式调用包装成 `LlmAdapter` 子类的 `stream(GenerateOptions)`（返回 StreamChunk 异步迭代器），用 `ctx.llm.registerAdapter(['pi-xai'], adapter)` 注册。改动量最小路径是仿照 `dsh-llm-deepseek`（Fetch+SSE 直连，无第三方 SDK 依赖）——pi-xai 已有的 `xai-stream.ts` 逻辑可直接搬运到 serialize/translate 两层。
2. **工具层**：pi-xai 的 `xai-image-gen.ts` / `xai-vision.ts` / `xai-web-fetch.ts` / `xai-usage-status.ts` 各自包装成 `defineTool({...})` 经 `ctx.tools.register` 暴露。
3. **设置/凭据**：`settingsNamespace('pi-xai')` + `installSettingsSection` 让 `pi-xai:` 配置段热更新；`XAI_API_KEY` 走 credentials seam，用户可在 Web Models 页填写。
4. **UI（可选）**：加 `lib/client.js` + `dsh.client.platform: 'web'`，host 用 `connection.rpc.handle('/pi-xai', ...)`、client 用 `slots.inject('conversation.view')` 挂状态面板（照抄 dsh-context 的双半体模式）。
5. **交互式 OAuth（pi-xai 的 `xai-oauth.ts`）**：DSH 的 credentials 服务是「引用 = 环境变量名」模型，官方 pi-ai 适配器注释明确「OAuth 凭据只能从存储的 OAuth credential 单独解析，adapter 自己不跑登录流」；自定义 provider 需在 adapter 内自行处理 OAuth 取 token 逻辑（如从 `xai-oauth.ts` 复用），把 token 作为 `apiKey` 传入或在请求头携带——DSH 侧没有现成的 OAuth 挂钩，这是需要自建的部分。