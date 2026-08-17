/**
 * XaiLlmAdapter — DSH LLM adapter for the xAI Grok Build path.
 *
 * Wire protocol: xAI Responses API (`POST /responses`, SSE stream).
 * Everything provider-specific lives here; the DSH message vocabulary is
 * translated to Responses `input` items and Responses SSE events are
 * translated to StreamChunk.
 *
 * Notable ported behaviors (from the Pi-era protocol layer):
 * - Grok CLI proxy identity headers when baseURL is the cli-chat-proxy
 * - prompt_cache_key session affinity
 * - reasoning.encrypted_content include on reasoning models
 * - slash-enum stripping on tools (xAI 422)
 */

import {
  CallId,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  attributionHeaders,
} from "@deepseek-ai/dsh-llm";
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
  TokenUsage,
} from "@deepseek-ai/dsh-llm";
import { grokModelId, grokSupportsReasoningEffort } from "./protocol/xai-config.ts";
import { GROK_BUILD_MODELS } from "./protocol/xai-provider.ts";
import {
  ensureXaiPromptCacheKey,
  ensureXaiEncryptedReasoningInclude,
  normalizeForXai,
  stripSlashEnums,
} from "./protocol/xai-payload.ts";
import { xaiRequestHeaders } from "./protocol/xai-stream.ts";
import type { ResolvedOptions } from "./config.ts";

export interface AdapterConfig {
  options(): ResolvedOptions;
  resolveApiKey(): Promise<string>;
}

/** DSH-branded reasoning-effort id → xAI Responses `reasoning.effort` value. */
const EFFORT_TO_XAI: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

function httpErrorCode(status: number, detail: string): string {
  if (status === 401 || status === 403) return "INVALID_CREDENTIAL";
  if (status === 429) return "RATE_LIMIT";
  if (status === 408 || status === 504 || status === 524) return "TIMEOUT";
  if (status >= 500) return "SERVER";
  if (detail.includes("reasoning")) return "TRANSPORT";
  if (detail.toLowerCase().includes("context") || detail.toLowerCase().includes("token"))
    return "CONTEXT_WINDOW_EXCEEDED";
  return "TRANSPORT";
}

const EFFORT_NAMES: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
};

/**
 * Selectable reasoning efforts for one catalog model, mirroring the Pi-era
 * semantics (grokSupportsReasoningEffort gate + per-model thinkingLevelMap):
 * - explicit map → expose every level mapped to a canonical xAI effort
 *   (off→none and alias entries like minimal/max are hidden)
 * - no map but effort-capable (grok-4.3 / 4.5 / 4.6 / multi-agent) → low/medium/high
 *   (multi-agent also xhigh)
 * - non-reasoning and grok-build* models → no selector
 */
function reasoningInfoFor(
  spec:
    | { id: string; reasoning: boolean; thinkingLevelMap?: Record<string, string | null> }
    | undefined,
): LlmModelReasoningInfo | undefined {
  if (!spec?.reasoning) return undefined;
  const efforts: string[] = [];
  if (spec.thinkingLevelMap) {
    for (const [level, mapped] of Object.entries(spec.thinkingLevelMap)) {
      if (mapped === level && mapped in EFFORT_TO_XAI && !efforts.includes(level)) {
        efforts.push(level);
      }
    }
  }
  if (efforts.length === 0) {
    if (spec.id.startsWith("grok-build") || !grokSupportsReasoningEffort(spec.id)) {
      return undefined;
    }
    efforts.push("low", "medium", "high");
    if (spec.id.includes("multi-agent")) efforts.push("xhigh");
  }
  return {
    efforts: efforts.map((id) => ({ id: ReasoningEffortId(id), name: EFFORT_NAMES[id] ?? id })),
    defaultEffort: ReasoningEffortId("high"),
  };
}

export class XaiLlmAdapter extends LlmAdapter {
  constructor(private readonly config: AdapterConfig) {
    super();
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: "Grok Build (xAI)" };
  }

  listModels(provider: string): Promise<LlmModelInfo[]> {
    return Promise.resolve(
      GROK_BUILD_MODELS.map((m) => ({
        provider,
        id: m.id,
        name: m.name,
        inputModalities: m.input as ("text" | "image")[],
      })),
    );
  }

  resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const spec = GROK_BUILD_MODELS.find((m) => m.id === model);
    const c = this.config.options();
    const info: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: spec?.name ?? model,
      inputModalities: (spec?.input ?? ["text"]) as ("text" | "image")[],
      context: { contextWindow: spec?.contextWindow ?? c.defaultContextWindow },
      defaultMaxTokens: spec?.maxTokens ?? c.maxTokens,
    };
    const reasoning = reasoningInfoFor(spec);
    if (reasoning) info.reasoning = reasoning;
    return Promise.resolve(info);
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const c = this.config.options();
    const apiKey = await this.config.resolveApiKey();
    const baseUrl = c.baseURL;
    const model = options.model;
    const sessionId = options.sessionId ? String(options.sessionId) : undefined;

    const body = buildResponsesBody(options, baseUrl);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...attributionHeaders(),
      ...xaiRequestHeaders(model, baseUrl, sessionId),
    };

    const url = `${baseUrl.replace(/\/+$/, "")}/responses`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      if (options.signal?.aborted) {
        throw new LlmError(`pi-xai: request aborted: ${message}`, "TRANSPORT", { status: 499 });
      }
      throw new LlmError(`pi-xai: transport error: ${message}`, "TRANSPORT");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LlmError(
        `pi-xai: xAI API error ${res.status}: ${text.slice(0, 300)}`,
        httpErrorCode(res.status, text),
        { status: res.status },
      );
    }
    if (!res.body) {
      throw new LlmError("pi-xai: empty response body", "EMPTY_RESPONSE");
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // Proxy fell back to a non-streaming full JSON response (observed on
      // cli-chat-proxy when stream:true is not honored). Synthesize chunks.
      const json = await res.json();
      yield* translateResponsesJson(json, options.signal);
      return;
    }
    yield* translateResponsesSse(res.body, options.signal);
  }
}

// ─── request serialization (DSH vocabulary → xAI Responses) ────────────────

export function buildResponsesBody(
  options: GenerateOptions,
  _baseUrl: string,
): Record<string, unknown> {
  const input = serializeMessages(options.messages ?? [], options.system);
  normalizeForXai(input as unknown[]);
  const body: Record<string, unknown> = {
    model: options.model,
    input,
    store: false,
    // Grok CLI proxy streams only when asked explicitly; without it the proxy
    // returns a full non-streaming JSON body (observed live on cli-chat-proxy).
    stream: true,
  };
  const tools = serializeTools(options.tools);
  if (tools.length > 0) {
    stripSlashEnums(tools);
    body.tools = tools;
  }
  if (options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.stop !== undefined && options.stop.length > 0) body.stop = options.stop;
  const effort = mapReasoningEffort(options.reasoningEffort, options.model);
  if (effort) body.reasoning = { effort };
  ensureXaiEncryptedReasoningInclude(body, options.model);
  ensureXaiPromptCacheKey(body, options.sessionId ? String(options.sessionId) : undefined);
  return body;
}

export function serializeMessages(messages: Message[], system: string | undefined): unknown[] {
  const input: unknown[] = [];
  if (system !== undefined && system.trim()) {
    input.push({ role: "developer", content: [{ type: "input_text", text: system }] });
  }
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const text = textOf(msg.content);
      if (text.trim()) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const block of msg.content) {
        if (block.type === "tool-call") {
          input.push({
            type: "function_call",
            call_id: String(block.id),
            name: block.name,
            arguments: block.arguments,
          });
        }
      }
    } else if (msg.role === "system") {
      const text = textOf(msg.content);
      if (text.trim()) input.push({ role: "system", content: [{ type: "input_text", text }] });
    } else {
      const toolResult = msg.content.find(
        (b): b is Extract<ContentBlock, { type: "tool-result" }> => b.type === "tool-result",
      );
      if (toolResult) {
        input.push({
          type: "function_call_output",
          call_id: String(toolResult.toolCallId),
          output: renderToolResult(toolResult.content),
        });
      } else {
        input.push({ role: "user", content: [{ type: "input_text", text: textOf(msg.content) }] });
      }
    }
  }
  return input;
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function renderToolResult(content: ContentBlock[]): string {
  const text = textOf(content);
  if (text.length > 0) return text;
  const parts = content.map((b) => String((b as { text?: unknown }).text ?? ""));
  return parts.join("\n") || '""';
}

function serializeTools(tools: GenerateOptions["tools"]): unknown[] {
  if (!tools || tools.length === 0) return [];
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/** Map the DSH branded effort id to the xAI effort string via the model's thinkingLevelMap. */
function mapReasoningEffort(effort: unknown, model: string): string | undefined {
  if (effort == null) return undefined;
  const key = String(effort);
  const spec = GROK_BUILD_MODELS.find((m) => m.id === grokModelId(model));
  if (spec && spec.thinkingLevelMap) {
    const mapped = spec.thinkingLevelMap[key];
    if (typeof mapped === "string") return mapped;
    return undefined;
  }
  return EFFORT_TO_XAI[key];
}

// ─── SSE translation (xAI Responses events → StreamChunk) ──────────────────

interface SseEvent {
  event: string;
  data: string;
}

async function* parseSse(raw: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = raw.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const normalized = block.replace(/\r\n/g, "\n");
      let event = "message";
      const datas: string[] = [];
      for (const line of normalized.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) datas.push(line.slice(5).trimStart());
      }
      if (datas.length > 0) yield { event, data: datas.join("\n") };
    }
  }
}

type OpenBlock = {
  index: number;
  type: "text" | "reasoning" | "tool-call";
  itemId: string;
  text: string;
  args: string;
  callId?: string;
  name?: string;
};

export async function* translateResponsesSse(
  raw: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncGenerator<StreamChunk> {
  const open = new Map<string, OpenBlock>();
  let nextIndex = 0;
  let sawToolCall = false;
  let completed = false;

  const openBlock = (
    itemId: string | undefined,
    kind: "text" | "reasoning" | "tool-call",
  ): void => {
    if (!itemId || open.has(itemId)) return;
    const index = nextIndex++;
    open.set(itemId, { index, type: kind, itemId, text: "", args: "" });
  };

  try {
    for await (const ev of parseSse(raw)) {
      let json: any;
      try {
        json = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (ev.event) {
        case "response.output_item.added": {
          // cli-chat-proxy carries the item under `item`, the official API under
          // `output_item` — accept both (missing the proxy shape silently drops
          // every tool call, which made agents answer instead of executing).
          const item = json?.output_item ?? json?.item;
          if (item && item.type === "function_call") {
            sawToolCall = true;
            openBlock(item.id, "tool-call");
            const block = open.get(item.id);
            if (block && block.type === "tool-call") {
              block.callId = item.call_id ?? item.id;
              block.name = item.name;
              yield {
                type: "block-start",
                index: block.index,
                blockType: "tool-call" as const,
              } as StreamChunk;
            }
          }
          break;
        }
        case "response.output_item.done": {
          // Fallback close: proxies may skip the *_arguments.done / *_text.done
          // events; close any still-open block from the completed item payload.
          const item = json?.output_item ?? json?.item;
          const itemId = item?.id ?? json?.item_id;
          const block = itemId ? open.get(itemId) : undefined;
          if (!block) break;
          open.delete(itemId);
          if (block.type === "tool-call") {
            yield {
              type: "block-end",
              index: block.index,
              block: {
                type: "tool-call",
                id: CallId(block.callId ?? item.call_id ?? itemId),
                name: block.name ?? item?.name ?? "",
                arguments: String(item?.arguments ?? block.args),
              },
            } as StreamChunk;
          } else if (block.type === "reasoning") {
            const summary = Array.isArray(item?.summary)
              ? item.summary.map((t: any) => t?.text ?? "").join("")
              : String(item?.text ?? block.text);
            yield {
              type: "block-end",
              index: block.index,
              block: { type: "reasoning", text: summary || block.text },
            } as StreamChunk;
          } else {
            yield {
              type: "block-end",
              index: block.index,
              block: { type: "text", text: String(item?.text ?? block.text) },
            } as StreamChunk;
          }
          break;
        }
        case "response.content_part.added": {
          const content = json?.content;
          const itemId = json?.item_id;
          const kind =
            content?.type === "reasoning" || content?.type === "redacted_reasoning"
              ? ("reasoning" as const)
              : ("text" as const);
          openBlock(itemId, kind);
          const block = open.get(itemId);
          if (block) {
            yield {
              type: "block-start",
              index: block.index,
              blockType: kind,
            } as StreamChunk;
          }
          break;
        }
        case "response.reasoning_summary_part.added":
        case "response.reasoning_text_part.added": {
          // Reasoning parts can arrive under their own event (proxy live-observed)
          // instead of via content_part.added; open a reasoning block for the item.
          const itemId = json?.item_id;
          const had = itemId ? open.has(itemId) : false;
          openBlock(itemId, "reasoning");
          if (!had && itemId) {
            const block = open.get(itemId);
            if (block) {
              yield {
                type: "block-start",
                index: block.index,
                blockType: "reasoning",
              } as StreamChunk;
            }
          }
          break;
        }
        case "response.output_text.delta": {
          const itemId = json?.item_id;
          const block = itemId ? open.get(itemId) : undefined;
          if (block && block.type === "text" && typeof json?.delta === "string") {
            yield {
              type: "text-delta",
              index: block.index,
              text: json.delta,
            } as StreamChunk;
          }
          break;
        }
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta": {
          const itemId = json?.item_id;
          const block = itemId ? open.get(itemId) : undefined;
          if (block && block.type === "reasoning" && typeof json?.delta === "string") {
            yield {
              type: "reasoning-delta",
              index: block.index,
              text: json.delta,
            } as StreamChunk;
          }
          break;
        }
        case "response.output_text.done": {
          const itemId = json?.item_id;
          const block = itemId ? open.get(itemId) : undefined;
          if (block && block.type === "text") {
            open.delete(itemId);
            yield {
              type: "block-end",
              index: block.index,
              block: { type: "text", text: String(json?.text ?? block.text) },
            } as StreamChunk;
          }
          break;
        }
        case "response.reasoning_summary_text.done": {
          const itemId = json?.item_id;
          const block = itemId ? open.get(itemId) : undefined;
          if (block && block.type === "reasoning") {
            open.delete(itemId);
            const summary = Array.isArray(json?.text)
              ? json.text.map((t: any) => t?.text ?? "").join("")
              : String(json?.text ?? "");
            yield {
              type: "block-end",
              index: block.index,
              block: { type: "reasoning", text: summary || block.text },
            } as StreamChunk;
          }
          break;
        }
        case "response.function_call_arguments.delta": {
          const itemId = json?.item_id;
          const block = itemId ? open.get(itemId) : undefined;
          if (block && block.type === "tool-call" && typeof json?.delta === "string") {
            yield {
              type: "tool-call-delta",
              index: block.index,
              id: CallId(block.callId ?? block.itemId),
              name: block.name,
              argumentsDelta: json.delta,
            } as StreamChunk;
          }
          break;
        }
        case "response.function_call_arguments.done": {
          const itemId = json?.item_id;
          const block = itemId ? open.get(itemId) : undefined;
          if (block && block.type === "tool-call") {
            open.delete(itemId);
            yield {
              type: "block-end",
              index: block.index,
              block: {
                type: "tool-call",
                id: CallId(block.callId ?? itemId),
                name: block.name ?? "",
                arguments: String(json?.arguments ?? block.args),
              },
            } as StreamChunk;
          }
          break;
        }
        case "response.completed": {
          const response = json?.response;
          if (response && typeof response.usage === "object" && response.usage !== null) {
            const usage = response.usage as {
              input_tokens?: number;
              output_tokens?: number;
              input_tokens_details?: { cached_tokens?: number };
              output_tokens_details?: { reasoning_tokens?: number };
            };
            const tokenUsage: TokenUsage = {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheReadTokens: usage.input_tokens_details?.cached_tokens,
              reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
            };
            yield { type: "usage", usage: tokenUsage };
          }
          const reason: FinishReason = sawToolCall
            ? { kind: "tool-calls" }
            : response?.status === "incomplete"
              ? { kind: "max-tokens" }
              : { kind: "stop" };
          yield { type: "finish", reason };
          completed = true;
          return;
        }
        case "response.failed": {
          const err = json?.response?.error;
          const detail = `${err?.code ?? ""} ${err?.message ?? "request failed"}`;
          throw new LlmError(
            `pi-xai: ${detail}`,
            err?.code === "rate_limit_exceeded"
              ? "RATE_LIMIT"
              : httpErrorCode(err?.status ?? 0, detail),
            { status: err?.status },
          );
        }
        default:
          break;
      }
    }
  } catch (err) {
    if (signal?.aborted || (err as Error)?.name === "AbortError") {
      throw new LlmError("pi-xai: stream aborted", "TRANSPORT", { status: 499 });
    }
    throw err;
  }
  if (!completed) {
    if (signal?.aborted) throw new LlmError("pi-xai: stream aborted", "TRANSPORT", { status: 499 });
    throw new LlmError("pi-xai: stream ended without response.completed", "EMPTY_RESPONSE");
  }
}

/**
 * Non-streaming fallback: synthesize StreamChunk from a complete Responses JSON
 * (used when a proxy ignores stream:true and returns application/json).
 */
export async function* translateResponsesJson(
  json: any,
  signal: AbortSignal | undefined,
): AsyncGenerator<StreamChunk> {
  const response = json?.response ?? json;
  if (!response) throw new LlmError("pi-xai: unexpected non-streaming payload", "EMPTY_RESPONSE");
  const output: any[] = response.output ?? [];
  let index = 0;
  let sawToolCall = false;

  for (const item of output) {
    if (item.type === "reasoning") {
      const text = Array.isArray(item.summary)
        ? item.summary.map((s: any) => s?.text ?? "").join("")
        : "";
      if (text) {
        const i = index++;
        yield { type: "block-start", index: i, blockType: "reasoning" } as StreamChunk;
        yield { type: "reasoning-delta", index: i, text } as StreamChunk;
        yield { type: "block-end", index: i, block: { type: "reasoning", text } } as StreamChunk;
      }
    } else if (item.type === "function_call") {
      sawToolCall = true;
      const i = index++;
      const id = CallId(item.id ?? `fc-${i}`);
      yield { type: "block-start", index: i, blockType: "tool-call" } as StreamChunk;
      yield {
        type: "tool-call-delta",
        index: i,
        id,
        name: item.name,
        argumentsDelta: item.arguments,
      } as StreamChunk;
      yield {
        type: "block-end",
        index: i,
        block: { type: "tool-call", id, name: item.name, arguments: item.arguments },
      } as StreamChunk;
    } else if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === "output_text" && typeof part.text === "string") {
          const i = index++;
          yield { type: "block-start", index: i, blockType: "text" } as StreamChunk;
          yield { type: "text-delta", index: i, text: part.text } as StreamChunk;
          yield {
            type: "block-end",
            index: i,
            block: { type: "text", text: part.text },
          } as StreamChunk;
        }
      }
    }
  }

  const usage = response.usage;
  if (usage && typeof usage === "object") {
    yield {
      type: "usage",
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.input_tokens_details?.cached_tokens,
        reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
      },
    } as StreamChunk;
  }
  const reason: FinishReason = sawToolCall
    ? { kind: "tool-calls" }
    : response.status === "incomplete"
      ? { kind: "max-tokens" }
      : { kind: "stop" };
  yield { type: "finish", reason };
  if (signal?.aborted) throw new LlmError("pi-xai: stream aborted", "TRANSPORT", { status: 499 });
}
