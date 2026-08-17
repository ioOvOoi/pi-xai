/**
 * Request payload helpers extracted from the former Pi extension entry
 * (index.ts). Pure protocol logic only — no ExtensionAPI / Cordis dependency.
 * Used by the DSH adapter (stream path) and by the agentic tools (direct path).
 */

import { normalizeImageParts, rewriteFunctionCallOutputImages } from "./xai-images.ts";
import { grokWantsEncryptedReasoningInclude } from "./xai-config.ts";
import { isXaiEntitlementError, isXaiStaleTokenError } from "./xai-oauth.ts";
import { xaiRequestHeaders } from "./xai-stream.ts";

/** Match Pi/openai-responses + xAI prompt cache key length limit. */
export const XAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/** Clamp a prompt_cache_key the same way Pi core does (max 64 code points). */
export function clampXaiPromptCacheKey(key: string | undefined | null): string | undefined {
  if (key == null) return undefined;
  const trimmed = String(key).trim();
  if (!trimmed) return undefined;
  const chars = Array.from(trimmed);
  if (chars.length <= XAI_PROMPT_CACHE_KEY_MAX_LENGTH) return trimmed;
  return chars.slice(0, XAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

/**
 * Ensure Responses body has prompt_cache_key for server affinity / cache hits.
 * xAI recommends this on Responses; Chat Completions uses x-grok-conv-id instead.
 * Prefers an existing non-empty body key; otherwise uses the session id.
 */
export function ensureXaiPromptCacheKey(
  body: Record<string, unknown>,
  sessionId?: string | null,
): void {
  const existing = body.prompt_cache_key;
  if (typeof existing === "string") {
    const clamped = clampXaiPromptCacheKey(existing);
    if (clamped) {
      body.prompt_cache_key = clamped;
      return;
    }
    delete body.prompt_cache_key;
  }
  const key = clampXaiPromptCacheKey(sessionId ?? undefined);
  if (key) body.prompt_cache_key = key;
}

/** POST /responses with payload normalization + CLI-proxy headers. */
export async function callXaiResponses(
  apiKey: string,
  baseUrl: string,
  body: Record<string, unknown>,
  timeout?: number,
  sessionId?: string | null,
  cwd?: string,
): Promise<any> {
  const input = (body as any).input;
  if (Array.isArray(input)) {
    normalizeForXai(input);
    if (cwd) {
      const modelId = typeof body.model === "string" ? body.model : "";
      const supportsImages = !modelId.toLowerCase().includes("composer");
      let next = normalizeImageParts(input, cwd) as Record<string, unknown>[];
      next = rewriteFunctionCallOutputImages(next, supportsImages);
      (body as any).input = next;
    }
  }
  ensureXaiPromptCacheKey(body, sessionId);

  const modelId = typeof body.model === "string" ? body.model : "";
  const url = `${baseUrl.replace(/\/+$/, "")}/responses`;
  const init: RequestInit & { signal?: AbortSignal } = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...xaiRequestHeaders(modelId, baseUrl, sessionId),
    },
    body: JSON.stringify(body),
  };
  if (timeout) init.signal = AbortSignal.timeout(timeout);

  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`xAI API error: ${res.status} ${text.slice(0, 500)}`);
    if (
      res.status === 401 ||
      (res.status === 403 && isXaiStaleTokenError(text) && !isXaiEntitlementError(text))
    ) {
      (err as any).reloginRequired = true;
    }
    throw err;
  }
  return res.json();
}

const VALID_CONTENT_TYPES = new Set(["input_text", "output_text", "text", "input_image"]);

/** Fix empty/malformed role message content (xAI 400). Siblings: call on body.input before POST. */
export function normalizeForXai(input: unknown[]): unknown[] {
  if (!Array.isArray(input)) return input as any[];
  for (const item of input) {
    if (!item || typeof item !== "object" || !(item as any).role) continue;
    const c = (item as any).content;
    let needsFix =
      c === undefined || c === null || c === "" || (Array.isArray(c) && c.length === 0);
    if (!needsFix && Array.isArray(c)) {
      const hasValid = c.some(
        (p: any) =>
          p &&
          typeof p === "object" &&
          (typeof p.text === "string" || VALID_CONTENT_TYPES.has(p.type)),
      );
      if (!hasValid) needsFix = true;
    }
    if (!needsFix && typeof c === "string" && !String(c).trim()) needsFix = true;
    if (needsFix) {
      const partType =
        (item as any).type === "message" && (item as any).role === "assistant"
          ? "output_text"
          : "input_text";
      (item as any).content = [{ type: partType, text: "" }];
    }
  }
  return input;
}

// ponytail: drops enums with '/', xAI 422; upgrade when xAI accepts slash enums
export function stripSlashEnums(tools: unknown[]): void {
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const rec = node as Record<string, unknown>;
    const en = rec.enum;
    if (Array.isArray(en) && en.some((v) => typeof v === "string" && v.includes("/"))) {
      delete rec.enum;
    }
    for (const v of Object.values(rec)) walk(v);
  };
  for (const tool of tools) walk(tool);
}

const XAI_BUILTIN_TOOL_TYPES = new Set([
  "web_search",
  "x_search",
  "code_interpreter",
  "collections_search",
]);

/** Merge client-side function tools with xAI server-side builtins, dedupe by name. */
export function mergeXaiTools(existing: unknown[], builtins: unknown[]): unknown[] {
  const filtered = existing.filter((t) => {
    if (!t || typeof t !== "object") return true;
    const rec = t as { type?: string; name?: string };
    return !(rec.type === "function" && rec.name && XAI_BUILTIN_TOOL_TYPES.has(rec.name));
  });
  const seen = new Set<string>();
  return [...filtered, ...builtins].filter((t) => {
    if (!t || typeof t !== "object") return true;
    const key = (t as { name?: string; type?: string }).name ?? (t as { type?: string }).type;
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Request reasoning.encrypted_content on reasoning models for multi-turn replay.
 * Official Grok Build always includes this (store:false + client-side replay).
 * Live-verified on cli-chat-proxy with CLI headers — do not strip for proxy.
 */
export function ensureXaiEncryptedReasoningInclude(
  payload: Record<string, unknown>,
  model: string | undefined,
): void {
  if (!grokWantsEncryptedReasoningInclude(model ?? "")) return;
  const want = "reasoning.encrypted_content";
  const inc = (payload as any).include;
  if (!Array.isArray(inc)) {
    (payload as any).include = [want];
    return;
  }
  if (!inc.includes(want)) (payload as any).include = [...inc, want];
}

const CITATION_GLUE_RE = /((?:https?:\/\/|www\.)[^\s<>\]]+)(\[\[\d+\]\]\([^)]+\))/g;

function glueCitationSpacing(text: string): string {
  return text.replace(CITATION_GLUE_RE, "$1 $2");
}

function citationsSummary(citations: string[] | undefined): string {
  if (!citations?.length) return "";
  const lines = citations.map((url, i) => `${i + 1}. ${url}`);
  return `\n\n**Sources consulted**\n${lines.join("\n")}`;
}

/** Format a completed Responses result into a readable markdown summary. */
export function formatResponseSummary(
  result: {
    model: string;
    output?: any[];
    usage?: any;
    citations?: string[];
    server_side_tool_usage?: Record<string, number>;
  },
  title: string,
): string {
  const items = result.output ?? [];
  const textParts: string[] = [];
  const toolCalls: string[] = [];

  for (const item of items) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === "output_text" && typeof c.text === "string") textParts.push(c.text);
      }
    } else if (item.type === "web_search_call") {
      const action = item.action;
      const detail = action?.query
        ? ` "${action.query}"`
        : action?.url
          ? ` ${action.url}`
          : typeof item.name === "string"
            ? ` (${item.name})`
            : "";
      const status = item.status ? ` [${item.status}]` : "";
      toolCalls.push(`- Web search${detail}${status}`);
    } else if (item.type === "x_search_call") {
      const action = item.action;
      const detail = action?.query
        ? ` "${action.query}"`
        : typeof item.name === "string"
          ? ` (${item.name})`
          : "";
      const status = item.status ? ` [${item.status}]` : "";
      toolCalls.push(`- X search${detail}${status}`);
    } else if (item.type === "code_interpreter_call") {
      const lang = item.language ?? "python";
      const status = item.status ? ` [${item.status}]` : "";
      toolCalls.push(`- Code execution (${lang})${status}`);
    } else if (item.type === "function_call") {
      const name = typeof item.name === "string" ? item.name : "function_call";
      toolCalls.push(`- Tool call: ${name}`);
    }
  }

  const text = glueCitationSpacing(textParts.join("\n"));
  const toolCallText = toolCalls.join("\n");
  const usage = result.usage
    ? `Tokens: ${result.usage.input_tokens ?? "?"} in / ${result.usage.output_tokens ?? "?"} out`
    : "";
  const reasoning = result.usage?.output_tokens_details?.reasoning_tokens
    ? ` (reasoning: ${result.usage.output_tokens_details.reasoning_tokens})`
    : "";
  const tools = result.server_side_tool_usage
    ? `\nServer-side tools: ${Object.entries(result.server_side_tool_usage)
        .map(([k, v]) => {
          const short = k.replace(/^SERVER_SIDE_TOOL_/, "").toLowerCase();
          return `${short}×${v}`;
        })
        .join(", ")}`
    : "";
  const body = [text, toolCallText].filter(Boolean).join("\n\n");
  return `**${title}** (${result.model})\n\n${body || "(no text output)"}\n\n${usage}${reasoning}${tools}${citationsSummary(result.citations)}`;
}
