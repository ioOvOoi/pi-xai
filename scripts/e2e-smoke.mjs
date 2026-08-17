/**
 * pi-xai DSH adapter 端到端冒烟测试（需本机 xAI/Grok 凭据，会真实调用 Grok Build 订阅）。
 * 走完整链路：credentials 解析 → Responses 序列化 → CLI 代理头 → SSE → StreamChunk。
 * 用法：node scripts/e2e-smoke.mjs [模型id]（默认 grok-4.6）
 */
import { fileURLToPath } from "node:url";

const here = (p) => new URL(p, import.meta.url);
const model = process.argv[2] ?? "grok-4.6";

const { XaiLlmAdapter } = await import(here("../lib/adapter.js"));
const { getEffectiveXaiApiKey } = await import(here("../lib/protocol/xai-oauth.js"));
const { resolveOptions } = await import(here("../lib/config.js"));

const effective = await getEffectiveXaiApiKey();
if (!effective?.apiKey) {
  console.error("E2E: no xAI credentials resolved (grok-build OAuth / XAI_API_KEY)");
  process.exit(2);
}
console.log(`E2E: credentials source=${effective.source}`);

const options = () => resolveOptions({ baseURL: "https://cli-chat-proxy.grok.com/v1" });
const adapter = new XaiLlmAdapter({ options, resolveApiKey: async () => effective.apiKey });

const chunks = [];
const gen = adapter.stream({
  provider: "pi-xai",
  model,
  messages: [
    {
      id: "e2e-m1",
      role: "user",
      content: [{ type: "text", text: 'Reply with exactly: OK' }],
      source: { kind: "user" },
    },
  ],
  signal: AbortSignal.timeout(60_000),
});

let text = "";
let usage;
let finish;
try {
  for await (const c of gen) {
    chunks.push(c);
    if (c.type === "text-delta") text += c.text;
    if (c.type === "usage") usage = c.usage;
    if (c.type === "finish") finish = c.reason;
  }
} catch (err) {
  console.error("E2E: stream failed:", err.message, err.code ?? "");
  process.exit(1);
}

console.log(`E2E: model=${model} text="${text.trim()}"`);
console.log(`E2E: chunks=[${chunks.map((c) => c.type).join(", ")}]`);
console.log(`E2E: usage=${JSON.stringify(usage)} finish=${JSON.stringify(finish)}`);

if (finish?.kind !== "stop") {
  console.error("E2E: unexpected finish reason");
  process.exit(1);
}
console.log("E2E: PASS");