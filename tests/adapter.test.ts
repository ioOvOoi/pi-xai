/**
 * Adapter 回归测试：请求序列化 + SSE 翻译（不含网络调用）。
 * 覆盖已修复的关键路径：cli-chat-proxy 的 `item` 字段（工具调用）、
 * 官方 `output_item` 字段兼容、文本流、非流式 JSON 兜底。
 */
import { describe, expect, test } from "vitest";
import {
  buildResponsesBody,
  serializeMessages,
  translateResponsesJson,
  translateResponsesSse,
} from "../src/adapter.ts";
import { MessageId } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, Message, StreamChunk } from "@deepseek-ai/dsh-llm";

function sseStream(blocks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const block of blocks) controller.enqueue(new TextEncoder().encode(block));
      controller.close();
    },
  });
}

const event = (name: string, data: unknown): string =>
  `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

function userMessage(id: string, text: string): Message {
  return {
    id: MessageId(id),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

// ─── 请求序列化 ────────────────────────────────────────────────────────────

describe("buildResponsesBody / serializeMessages", () => {
  test("system → developer input; user → input_text; 代理所需 stream:true", () => {
    const options = {
      provider: "pi-xai",
      model: "grok-4.6",
      system: "Be concise.",
      sessionId: "sess-1",
      messages: [userMessage("m1", "hello")],
    } as unknown as GenerateOptions;
    const body = buildResponsesBody(options, "https://cli-chat-proxy.grok.com/v1");
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.model).toBe("grok-4.6");
    expect(body.input).toEqual([
      { role: "developer", content: [{ type: "input_text", text: "Be concise." }] },
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
    expect((body as any).prompt_cache_key).toBe("sess-1");
  });

  test("reasoning effort 映射进 body.reasoning；推理模型自动 include encrypted_content", () => {
    const options = {
      provider: "pi-xai",
      model: "grok-4.6",
      reasoningEffort: "low",
      messages: [userMessage("m1", "hi")],
    } as unknown as GenerateOptions;
    const body = buildResponsesBody(options, "https://cli-chat-proxy.grok.com/v1");
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("grok-build 模型不注入 encrypted include", () => {
    const options = {
      provider: "pi-xai",
      model: "grok-build",
      messages: [userMessage("m1", "hi")],
    } as unknown as GenerateOptions;
    const body = buildResponsesBody(options, "https://cli-chat-proxy.grok.com/v1");
    expect(body.include).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
  });

  test("tools → xAI function 格式；空 tools 不发送", () => {
    const options = {
      provider: "pi-xai",
      model: "grok-4.6",
      tools: [{ name: "web_fetch", description: "Fetch", parameters: { type: "object" } }],
      messages: [userMessage("m1", "hi")],
    } as unknown as GenerateOptions;
    const body = buildResponsesBody(options, "https://cli-chat-proxy.grok.com/v1");
    expect(body.tools).toEqual([
      { type: "function", name: "web_fetch", description: "Fetch", parameters: { type: "object" } },
    ]);
    const noTools = buildResponsesBody(
      {
        provider: "pi-xai",
        model: "grok-4.6",
        messages: [userMessage("m1", "hi")],
      } as unknown as GenerateOptions,
      "https://cli-chat-proxy.grok.com/v1",
    );
    expect(noTools.tools).toBeUndefined();
  });

  test("历史回放：assistant tool-call → function_call；tool-result → function_call_output", () => {
    const messages = [
      userMessage("m1", "fetch example.com"),
      {
        id: "a1",
        role: "assistant",
        source: { kind: "model", provider: "pi-xai", model: "grok-4.6" },
        content: [
          { type: "text", text: "let me fetch" },
          {
            type: "tool-call",
            id: "call-1",
            name: "web_fetch",
            arguments: '{"url":"https://example.com"}',
          },
        ],
      } as Message,
      {
        id: "t1",
        role: "user",
        source: { kind: "tool", callId: "call-1" },
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            content: [{ type: "text", text: "<title>Example</title>" }],
          },
        ],
      } as Message,
    ];
    const input = serializeMessages(messages, undefined);
    expect(input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "fetch example.com" }] },
      { role: "assistant", content: [{ type: "output_text", text: "let me fetch" }] },
      {
        type: "function_call",
        call_id: "call-1",
        name: "web_fetch",
        arguments: '{"url":"https://example.com"}',
      },
      { type: "function_call_output", call_id: "call-1", output: "<title>Example</title>" },
    ]);
  });
});

// ─── SSE 翻译 ──────────────────────────────────────────────────────────────

describe("translateResponsesSse", () => {
  test("cli-chat-proxy `item` 字段：工具调用被识别，finish 为 tool-calls（回归 #98a561e）", async () => {
    const raw = sseStream([
      event("response.output_item.added", {
        type: "response.output_item.added",
        item: {
          id: "fc_1",
          type: "function_call",
          name: "web_fetch",
          call_id: "call-1",
          arguments: "",
          status: "in_progress",
        },
        output_index: 1,
      }),
      event("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: '{"url":"https://example.com"}',
        output_index: 1,
      }),
      event("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        arguments: '{"url":"https://example.com"}',
        output_index: 1,
      }),
      event("response.completed", {
        type: "response.completed",
        response: {
          id: "r1",
          status: "completed",
          model: "grok-4.6-build",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            input_tokens_details: { cached_tokens: 10 },
            output_tokens_details: { reasoning_tokens: 20 },
          },
          output: [],
        },
      }),
    ]);
    const chunks = await collect(translateResponsesSse(raw, undefined));

    expect(chunks.some((c) => c.type === "block-start" && c.blockType === "tool-call")).toBe(true);
    const toolCall = chunks.find(
      (c): c is Extract<StreamChunk, { type: "block-end" }> =>
        c.type === "block-end" && c.block.type === "tool-call",
    );
    expect(toolCall?.block).toMatchObject({
      type: "tool-call",
      name: "web_fetch",
      arguments: '{"url":"https://example.com"}',
    });
    const usage = chunks.find(
      (c): c is Extract<StreamChunk, { type: "usage" }> => c.type === "usage",
    );
    expect(usage?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      reasoningTokens: 20,
    });
    const finish = chunks.find(
      (c): c is Extract<StreamChunk, { type: "finish" }> => c.type === "finish",
    );
    expect(finish?.reason).toEqual({ kind: "tool-calls" });
  });

  test("官方 `output_item` 字段同样兼容", async () => {
    const raw = sseStream([
      event("response.output_item.added", {
        type: "response.output_item.added",
        output_item: {
          id: "fc_2",
          type: "function_call",
          name: "x_search",
          call_id: "call-2",
          arguments: "",
          status: "in_progress",
        },
        output_index: 0,
      }),
      event("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: "fc_2",
        arguments: '{"query":"dsh"}',
        output_index: 0,
      }),
      event("response.completed", {
        type: "response.completed",
        response: {
          id: "r2",
          status: "completed",
          model: "grok-4.6-build",
          usage: { input_tokens: 1, output_tokens: 1 },
          output: [],
        },
      }),
    ]);
    const chunks = await collect(translateResponsesSse(raw, undefined));
    const blockEnd = chunks.find(
      (c): c is Extract<StreamChunk, { type: "block-end" }> =>
        c.type === "block-end" && c.block.type === "tool-call",
    );
    expect(blockEnd?.block).toMatchObject({
      type: "tool-call",
      name: "x_search",
      arguments: '{"query":"dsh"}',
    });
    const finish = chunks.find(
      (c): c is Extract<StreamChunk, { type: "finish" }> => c.type === "finish",
    );
    expect(finish?.reason).toEqual({ kind: "tool-calls" });
  });

  test("output_item.done 兜底关闭未完成块", async () => {
    const raw = sseStream([
      event("response.output_item.added", {
        type: "response.output_item.added",
        item: {
          id: "fc_3",
          type: "function_call",
          name: "web_fetch",
          call_id: "call-3",
          arguments: "",
          status: "in_progress",
        },
        output_index: 0,
      }),
      event("response.output_item.done", {
        type: "response.output_item.done",
        item: {
          id: "fc_3",
          type: "function_call",
          name: "web_fetch",
          call_id: "call-3",
          arguments: '{"url":"https://x.ai"}',
          status: "completed",
        },
        output_index: 0,
      }),
      event("response.completed", {
        type: "response.completed",
        response: {
          id: "r3",
          status: "completed",
          model: "grok-4.6-build",
          usage: { input_tokens: 1, output_tokens: 1 },
          output: [],
        },
      }),
    ]);
    const chunks = await collect(translateResponsesSse(raw, undefined));
    const blockEnd = chunks.find(
      (c): c is Extract<StreamChunk, { type: "block-end" }> =>
        c.type === "block-end" && c.block.type === "tool-call",
    );
    expect(blockEnd?.block).toMatchObject({
      type: "tool-call",
      name: "web_fetch",
      arguments: '{"url":"https://x.ai"}',
    });
    expect(chunks.some((c) => c.type === "finish")).toBe(true);
  });

  test("纯文本流：text-delta + block-end + finish stop", async () => {
    const raw = sseStream([
      event("response.output_item.added", {
        type: "response.output_item.added",
        item: { id: "msg_1", type: "message", status: "in_progress", content: [] },
        output_index: 0,
      }),
      event("response.content_part.added", {
        type: "response.content_part.added",
        item_id: "msg_1",
        output_index: 0,
        content: { type: "output_text", text: "", annotations: [] },
      }),
      event("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        delta: "Hello",
      }),
      event("response.output_text.done", {
        type: "response.output_text.done",
        item_id: "msg_1",
        output_index: 0,
        text: "Hello",
      }),
      event("response.completed", {
        type: "response.completed",
        response: {
          id: "r4",
          status: "completed",
          model: "grok-4.6-build",
          usage: { input_tokens: 5, output_tokens: 5 },
          output: [],
        },
      }),
    ]);
    const chunks = await collect(translateResponsesSse(raw, undefined));
    const text = chunks
      .filter((c): c is Extract<StreamChunk, { type: "text-delta" }> => c.type === "text-delta")
      .map((c) => c.text)
      .join("");
    expect(text).toBe("Hello");
    const finish = chunks.find(
      (c): c is Extract<StreamChunk, { type: "finish" }> => c.type === "finish",
    );
    expect(finish?.reason).toEqual({ kind: "stop" });
  });

  test("reasoning 事件流：reasoning-delta 与 block-end reasoning", async () => {
    const raw = sseStream([
      event("response.output_item.added", {
        type: "response.output_item.added",
        item: { id: "rs_1", type: "reasoning", summary: [], status: "in_progress" },
        output_index: 0,
      }),
      event("response.reasoning_summary_part.added", {
        type: "response.reasoning_summary_part.added",
        item_id: "rs_1",
        summary_index: 0,
        reasoning_summary: [{ type: "summary_text", text: "" }],
      }),
      event("response.reasoning_summary_text.delta", {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_1",
        summary_index: 0,
        delta: "thinking...",
      }),
      event("response.reasoning_summary_text.done", {
        type: "response.reasoning_summary_text.done",
        item_id: "rs_1",
        summary_index: 0,
        text: [{ type: "summary_text", text: "thinking..." }],
      }),
      event("response.completed", {
        type: "response.completed",
        response: {
          id: "r5",
          status: "completed",
          model: "grok-4.6-build",
          usage: { input_tokens: 1, output_tokens: 1 },
          output: [],
        },
      }),
    ]);
    const chunks = await collect(translateResponsesSse(raw, undefined));
    const reasoning = chunks
      .filter(
        (c): c is Extract<StreamChunk, { type: "reasoning-delta" }> => c.type === "reasoning-delta",
      )
      .map((c) => c.text)
      .join("");
    expect(reasoning).toBe("thinking...");
    const blockEnd = chunks.find(
      (c): c is Extract<StreamChunk, { type: "block-end" }> =>
        c.type === "block-end" && c.block.type === "reasoning",
    );
    expect(blockEnd?.block).toEqual({ type: "reasoning", text: "thinking..." });
  });
});

// ─── 非流式 JSON 兜底 ──────────────────────────────────────────────────────

describe("translateResponsesJson", () => {
  test("完整 JSON 响应 → 文本块 + usage + finish stop", async () => {
    const json = {
      id: "r6",
      model: "grok-4.6-build",
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 3 },
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi there" }],
        },
      ],
    };
    const chunks = await collect(translateResponsesJson(json, undefined));
    const text = chunks
      .filter((c): c is Extract<StreamChunk, { type: "text-delta" }> => c.type === "text-delta")
      .map((c) => c.text)
      .join("");
    expect(text).toBe("hi there");
    const finish = chunks.find(
      (c): c is Extract<StreamChunk, { type: "finish" }> => c.type === "finish",
    );
    expect(finish?.reason).toEqual({ kind: "stop" });
  });

  test("JSON 兜底含 function_call → finish tool-calls", async () => {
    const json = {
      id: "r7",
      model: "grok-4.6-build",
      status: "completed",
      usage: { input_tokens: 1, output_tokens: 1 },
      output: [
        {
          type: "function_call",
          id: "fc_9",
          name: "web_fetch",
          arguments: '{"url":"https://x.ai"}',
        },
      ],
    };
    const chunks = await collect(translateResponsesJson(json, undefined));
    const blockEnd = chunks.find(
      (c): c is Extract<StreamChunk, { type: "block-end" }> =>
        c.type === "block-end" && c.block.type === "tool-call",
    );
    expect(blockEnd?.block).toMatchObject({ type: "tool-call", name: "web_fetch" });
    const finish = chunks.find(
      (c): c is Extract<StreamChunk, { type: "finish" }> => c.type === "finish",
    );
    expect(finish?.reason).toEqual({ kind: "tool-calls" });
  });
});
