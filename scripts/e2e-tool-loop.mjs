/**
 * pi-xai 工具调用闭环端到端验证（需本机 xAI/Grok 凭据，会真实消耗少量订阅额度）。
 * 验证：模型调用工具 → function_call 翻译 → 工具结果回传 → 模型总结。
 * 用法：node scripts/e2e-tool-loop.mjs
 */
import { XaiLlmAdapter } from "../lib/adapter.js";
import { getEffectiveXaiApiKey } from "../lib/protocol/xai-oauth.js";
import { resolveOptions } from "../lib/config.js";

const WEB_FETCH_TOOL = {
  name: "web_fetch",
  description: "Fetch a URL and return its text content",
  parameters: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
};

const effective = await getEffectiveXaiApiKey();
if (!effective?.apiKey) {
  console.error("E2E: no xAI credentials resolved");
  process.exit(2);
}
const options = () => resolveOptions({ baseURL: "https://cli-chat-proxy.grok.com/v1" });
const adapter = new XaiLlmAdapter({ options, resolveApiKey: async () => effective.apiKey });

// 第一轮：模型应调用 web_fetch
let name = "";
let args = "";
let callId = "";
const g1 = adapter.stream({
  provider: "pi-xai",
  model: "grok-4.6",
  tools: [WEB_FETCH_TOOL],
  messages: [
    {
      id: "e2e-m1",
      role: "user",
      content: [{ type: "text", text: "Fetch https://example.com and tell me the title." }],
      source: { kind: "user" },
    },
  ],
  signal: AbortSignal.timeout(90_000),
});
for await (const c of g1) {
  if (c.type === "tool-call-delta") {
    name = c.name ?? name;
    callId = c.id;
    args += c.argumentsDelta;
  }
}
console.log(`round1: tool=${name} callId=${callId} args=${args}`);
if (!name) {
  console.error("E2E: round1 未产生工具调用");
  process.exit(1);
}

// 第二轮：模拟 agent 执行工具后回传结果
let text = "";
let finish;
const g2 = adapter.stream({
  provider: "pi-xai",
  model: "grok-4.6",
  tools: [WEB_FETCH_TOOL],
  messages: [
    {
      id: "e2e-m1",
      role: "user",
      content: [{ type: "text", text: "Fetch https://example.com and tell me the title." }],
      source: { kind: "user" },
    },
    {
      id: "e2e-a1",
      role: "assistant",
      source: { kind: "model", provider: "pi-xai", model: "grok-4.6" },
      content: [{ type: "tool-call", id: callId, name, arguments: args }],
    },
    {
      id: "e2e-t1",
      role: "user",
      source: { kind: "tool", callId },
      content: [
        { type: "tool-result", toolCallId: callId, content: [{ type: "text", text: "<title>Example Domain</title>" }] },
      ],
    },
  ],
  signal: AbortSignal.timeout(90_000),
});
for await (const c of g2) {
  if (c.type === "text-delta") text += c.text;
  if (c.type === "finish") finish = c.reason;
}
console.log(`round2: text="${text.trim().slice(0, 120)}" finish=${JSON.stringify(finish)}`);
if (finish?.kind !== "stop" || !/example domain/i.test(text)) {
  console.error("E2E: 第二轮结果不符合预期");
  process.exit(1);
}
console.log("E2E TOOL LOOP: PASS");