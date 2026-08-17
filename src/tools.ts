/**
 * Agentic xAI tools for DSH, ported from the Pi-era extension.
 * All three speak the Responses API directly (like the original custom tools).
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { callXaiResponses, formatResponseSummary } from "./protocol/xai-payload.ts";
import { grokSupportsReasoningEffort } from "./protocol/xai-config.ts";
import type { ResolvedOptions } from "./config.ts";

export interface ToolHost {
  tools: {
    register(tool: unknown): () => void;
  };
  get(service: string): unknown;
}

export interface ToolEnv {
  options(): ResolvedOptions;
  resolveApiKey(): Promise<string>;
}

const renderText = (_args: unknown, value: { text?: string } & Record<string, unknown>) => [
  { type: "text" as const, text: value?.text ?? JSON.stringify(value, null, 2) },
];

export function registerTools(ctx: ToolHost, env: ToolEnv): void {
  const { options, resolveApiKey } = env;

  ctx.tools.register(
    defineTool({
      name: "xai_generate_text",
      description:
        "Generate text via the xAI Responses API (Grok). Supports reasoning effort, structured output, built-in tools (web_search, x_search, code_interpreter, collections_search), stateful conversation via previous_response_id, and encrypted reasoning content. Returns a formatted markdown summary with citations.",
      parameters: {
        prompt: { type: "string", required: true, description: "User prompt / message" },
        model: {
          type: "string",
          description: "Model override (default grok-4.6; see provider catalog for ids)",
        },
        reasoningEffort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh"],
          description: "grok-4.6 supports low/medium/high/xhigh (API default high)",
        },
        system: { type: "string", description: "System / developer instruction" },
        previousResponseId: {
          type: "string",
          description: "Previous response id for conversation continuity",
        },
        maxOutputTokens: { type: "number", description: "Max output tokens" },
        temperature: { type: "number", description: "Sampling temperature" },
        store: { type: "boolean", description: "Store response server-side (default true)" },
        include: {
          type: "array",
          items: { type: "string" },
          description: "Additional data to include, e.g. reasoning.encrypted_content",
        },
        tools: {
          type: "json",
          description:
            'xAI built-in tools via simple strings or full config objects, e.g. ["web_search"] or [{type:"x_search", from_date:"2025-01-01"}]',
        },
        responseFormat: {
          type: "string",
          description: "JSON schema string for structured output",
        },
        timeout: { type: "number", description: "Timeout ms (default 300000; reasoning 3600000)" },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderText },
      timeoutMs: 3_700_000,
      async execute(args: any) {
        const {
          prompt,
          model,
          reasoningEffort,
          system,
          previousResponseId,
          maxOutputTokens,
          temperature,
          store,
          include,
          tools,
          responseFormat,
          timeout,
        } = args ?? {};
        const apiKey = await resolveApiKey();
        const baseUrl = options().baseURL;
        const input: Array<{ role: "user" | "developer"; content: string }> = [];
        if (system) input.push({ role: "developer", content: system });
        input.push({ role: "user", content: prompt });

        const mappedTools = Array.isArray(tools)
          ? tools.map((t: any) => (typeof t === "string" ? { type: t } : t))
          : undefined;
        let parsedFormat: Record<string, unknown> | undefined;
        if (responseFormat) {
          parsedFormat = {
            type: "json_schema",
            json_schema: { name: "response", schema: JSON.parse(responseFormat), strict: true },
          };
        }
        const modelToUse = model || "grok-4.6";
        const isReasoningModel =
          grokSupportsReasoningEffort(modelToUse) ||
          modelToUse === "grok-build" ||
          modelToUse.startsWith("grok-build-") ||
          modelToUse.includes("reasoning");
        const effectiveTimeout = timeout ?? (isReasoningModel ? 3_600_000 : 300_000);

        const body: Record<string, unknown> = { model: modelToUse, input };
        if (previousResponseId) body.previous_response_id = previousResponseId;
        if (maxOutputTokens !== undefined) body.max_output_tokens = maxOutputTokens;
        if (temperature !== undefined) body.temperature = temperature;
        if (store !== undefined) body.store = store;
        if (include?.length) {
          body.include = include;
        }
        if (mappedTools?.length) body.tools = mappedTools;
        if (parsedFormat) body.text = { format: parsedFormat };
        if (reasoningEffort && isReasoningModel && !modelToUse.startsWith("grok-build")) {
          body.reasoning = { effort: reasoningEffort };
        }
        const result = await callXaiResponses(apiKey, baseUrl, body, effectiveTimeout);
        return { text: formatResponseSummary(result, "xAI Response") };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "xai_multi_agent",
      description:
        "Deep research via the xAI multi-agent model (grok-4.20-multi-agent). Orchestrates 4 (low/medium) or 16 (high/xhigh) agents with built-in tools (web_search, x_search, code_interpreter, collections_search).",
      parameters: {
        prompt: { type: "string", required: true, description: "Research query" },
        reasoningEffort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh"],
          description: "low/medium = 4 agents, high/xhigh = 16 agents",
        },
        tools: {
          type: "json",
          description: "Built-in tools (strings or config objects)",
        },
        previousResponseId: { type: "string", description: "Continue a previous research run" },
        store: { type: "boolean" },
        include: { type: "array", items: { type: "string" } },
        timeout: { type: "number", description: "Timeout ms (default 3600000)" },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderText },
      timeoutMs: 3_700_000,
      async execute(args: any) {
        const { prompt, reasoningEffort, tools, previousResponseId, store, include, timeout } =
          args ?? {};
        const apiKey = await resolveApiKey();
        const baseUrl = options().baseURL;
        const mappedTools = Array.isArray(tools)
          ? tools.map((t: any) => (typeof t === "string" ? { type: t } : t))
          : undefined;
        const body: Record<string, unknown> = {
          model: "grok-4.20-multi-agent-0309",
          input: [{ role: "user", content: prompt }],
        };
        if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
        if (previousResponseId) body.previous_response_id = previousResponseId;
        if (mappedTools?.length) body.tools = mappedTools;
        if (store !== undefined) body.store = store;
        if (include?.length) body.include = include;
        const result = await callXaiResponses(apiKey, baseUrl, body, timeout ?? 3_600_000);
        return { text: formatResponseSummary(result, "xAI Multi-Agent") };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "xai_x_search",
      description:
        "Search X (Twitter) using Grok's live x_search built-in tool (real posts with citations).",
      parameters: {
        query: { type: "string", required: true, description: "X search query" },
        from_date: { type: "string", description: "Posts on/after this date (YYYY-MM-DD, UTC)" },
        to_date: { type: "string", description: "Posts on/before this date (YYYY-MM-DD, UTC)" },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderText },
      timeoutMs: 320_000,
      async execute(args: any) {
        const { query, from_date, to_date } = args ?? {};
        const apiKey = await resolveApiKey();
        const baseUrl = options().baseURL;
        const xSearchTool: Record<string, unknown> = { type: "x_search" };
        if (from_date?.trim()) xSearchTool.from_date = from_date.trim();
        if (to_date?.trim()) xSearchTool.to_date = to_date.trim();
        const body: Record<string, unknown> = {
          model: "grok-4.20-0309-reasoning",
          input: [{ role: "user", content: query.trim() }],
          tools: [xSearchTool],
          store: false,
        };
        const result = await callXaiResponses(apiKey, baseUrl, body, 300_000);
        return { text: formatResponseSummary(result, "xAI X Search") };
      },
    }),
  );
}
