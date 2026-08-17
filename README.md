# pi-xai — xAI / Grok Build extras for DeepSeek Harness

<p align="center">
  <strong>Grok Build subscription path for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness (DSH)</a></strong><br>
  LLM provider · agentic tools · imagine / video · web_fetch · usage
</p>

> **分支说明**：本仓库 `dsh` 分支把 pi-xai（原为 Pi 扩展）改造为 **DSH 原生 bundle 插件**。
> 协议层（Grok Build CLI 代理头、Responses payload 归一化、OAuth/凭据链、billing 查询）原样保留；
> 宿主抽象（ExtensionAPI → Cordis 服务）全部重写。

---

## 安装

```bash
# 作为三方 bundle 插件（推荐）
dsh plugin --profile <name> add github:ioOvOoi/pi-xai

# 本地开发装配
npm install && npm run build
# 运行时热装配（订阅 dsh-super-injector 的环境）
dev_install_package <本仓库绝对路径>
```

插件行 `pi-xai` 由包内 `cordis.patch.yml` 自动 insert；依赖官方 `llm` 核心行（dsh-base 自带）。

## 模型

Provider 路由：`pi-xai`（Grok Build (xAI)），默认走 **Grok CLI 订阅代理**，可切公开 API。

| id | name | reasoning | contextWindow | maxTokens |
|---|---|---|---|---|
| `grok-composer-2.5-fast` | Composer 2.5 | ✗ | 200k | 30k |
| `grok-build` | Grok Build | ✓ | 500k | 30k |
| `grok-4.6` | Grok 4.6 | ✓ | 500k | 131k |
| `grok-4.5` | Grok 4.5 | ✓ | 500k | 131k |
| `grok-4.3` | Grok 4.3 | ✓ | 1M | 131k |
| `grok-4.20-0309-reasoning` | Grok 4.20 Reasoning | ✓ | 2M | 131k |
| `grok-4.20-0309-non-reasoning` | Grok 4.20 Non-Reasoning | ✗ | 2M | 131k |
| `grok-4.20-multi-agent-0309` | Grok 4.20 Multi-Agent | ✓ | 2M | 131k |

## 凭据（优先级）

1. DSH credentials / 环境变量：`XAI_API_KEY`（默认引用，可在设置改 `pi-xai.apiKeyEnv`）
2. Grok Build 订阅链：`~/.pi/agent/auth.json` → `~/.grok/auth.json` 导入 → OAuth（自动检测/刷新）

```yaml
# $DSH_HOME/settings.yaml
pi-xai:
  apiKeyEnv: XAI_API_KEY
  baseURL: https://cli-chat-proxy.grok.com/v1   # 公开 API key 改 https://api.x.ai/v1
  defaultContextWindow: 500000
  maxTokens: 131072
```

## 工具

| 工具 | 说明 |
|---|---|
| `xai_generate_text` | Responses API 文本生成（reasoning effort / 结构化输出 / 内置工具 / previous_response_id） |
| `xai_multi_agent` | grok-4.20-multi-agent 深度研究（4 / 16 agents） |
| `xai_x_search` | X 实时搜索（真实帖子 + 引用） |
| `image_gen` / `image_edit` | Imagine 文生图 / 图编（保存到本地） |
| `image_to_video` | 图生视频（image_gen → animate） |
| `web_fetch` | SSRF 防护的网页抓取（HTML → markdown） |

## 命令

| 命令 | 说明 |
|---|---|
| `/xai-usage` | Grok Build 订阅用量 / 配额 |

## 与 DSH 原生能力的关系（去重）

- **goal / plan-mode**：DSH 已原生提供 `create_goal/get_goal/update_goal` 与 plan-mode；pi-xai 在 Pi 版里的对应功能不重复注册。
- **usage 状态栏 / prompt 幽灵**：依赖 GUI 形态，暂缓（客户端半体二期）。

## 开发

```bash
npm install
npm run build      # tsc → lib/（prepare 钩子自动执行）
npm run typecheck  # tsc --noEmit
npm test           # vitest（协议层断言）
```

详见 [`docs/`](docs/)：`dsh-plugin-research.md`（DSH 插件规范）、`pi-xai-inventory.md`（能力盘点）、`dsh-adaptation-spec.md`（适配规格）、`TICKETS.md`（模块工单）。

## License

[MIT](LICENSE)