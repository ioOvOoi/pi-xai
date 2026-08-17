# dsh 分支适配工单（TICKETS）

> 远端仓库关闭了 GitHub Issues，故以本文件作为模块拆分与进度工单（与《docs/dsh-adaptation-spec.md》§4 一一对应）。
> 状态图例：⬜ 待办 / 🔄 进行中 / ✅ 完成

| # | 工单 | 内容 | 验收 | 状态 |
|---|---|---|---|---|
| 1 | 插件骨架 | package.json dsh 声明 + cordis.patch.yml + tsconfig + build 管线 + 协议层迁入 src/protocol | `npm run build` 出 lib/index.js；本机注入成功且卸载干净 | ✅ |
| 2 | 凭据层 | grok-build OAuth（PKCE/device/CLI 导入/refresh/JWT 过期）+ 优先级链，接入 DSH credentials/launch-env | 单元测试通过；XAI_API_KEY 路径可用 | 🔄 |
| 3 | 模型注册 | Grok Build 模型目录 → `XaiLlmAdapter`（Responses SSE→StreamChunk）+ 请求归一化 + CLI 代理头 + settings 段 | 模型出现在 DSH 模型列表；流式对话可用 | ✅ 运行时注册已实证（8 模型）；真实流式调用待凭据 |
| 4 | 文本工具 | xai_generate_text / xai_multi_agent / xai_x_search | 工具注册成功、schema 校验、真实调用（mock/线上） | ✅ 已注册；真实调用待凭据 |
| 5 | 媒体与抓取 | image_gen / image_edit / image_to_video / web_fetch | mock 测试通过、产物落盘 | ✅ 已注册（运行时 fiber active）；真实调用待凭据 |
| 6 | 命令与用量 | /xai-usage（+statusbar 开关）、billing 查询 | 命令可用、格式化正确 | ✅ 已注册；billing 待凭据 |
| 7 | README 与发布 | README 重写（DSH 安装方式）、CHANGELOG、CI 适配 | 文档可指引安装 | ✅ |

## 已确认去重（不移植）

- `update_goal` / goal 状态机：DSH 原生 goal 工具（create_goal/get_goal/update_goal）更强且持久化。
- plan-mode 主体：DSH 原生已有；仅保留差异化逻辑（`isSafePlanBash` 白名单、plan 文件 helper）可选移植。
- prompt suggest 幽灵：绑定 GUI 形态，移植成本/收益比低，暂缓。