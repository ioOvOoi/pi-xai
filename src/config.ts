/**
 * pi-xai DSH plugin: settings schema + provider identity.
 * The config schema doubles as the plugin row config and the `pi-xai:` settings section.
 */

import z from "@deepseek-ai/schemastery";
import { RetryPolicySchema } from "@deepseek-ai/dsh-llm";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

/** Settings namespace key (top-level settings.yaml section). */
export const NS = settingsNamespace("pi-xai");

/** LLM provider route id registered by this plugin. */
export const PROVIDER = "pi-xai";

export const Config = z.object({
  /** DSH credentials reference (env-var name) for the xAI API key. */
  apiKeyEnv: z.string().role("credential-ref").default("XAI_API_KEY"),
  /** Grok Build CLI proxy by default; override to https://api.x.ai/v1 for public API keys. */
  baseURL: z.string().default("https://cli-chat-proxy.grok.com/v1"),
  defaultContextWindow: z.number().step(1).min(1).default(500_000),
  maxTokens: z.number().step(1).min(1).default(131_072),
  streamIdleTimeoutMs: z.number().min(1).default(300_000),
  retryPolicy: RetryPolicySchema,
});

export interface ResolvedOptions {
  apiKeyEnv: string;
  baseURL: string;
  defaultContextWindow: number;
  maxTokens: number;
  streamIdleTimeoutMs: number;
  retryPolicy?: unknown;
}

/** Normalize any config source (row config / settings section) into runtime facts. */
export function resolveOptions(input: unknown): ResolvedOptions {
  const c = (input ?? {}) as Record<string, any>;
  return {
    apiKeyEnv: c.apiKeyEnv ?? "XAI_API_KEY",
    baseURL: (c.baseURL as string | undefined) ?? "https://cli-chat-proxy.grok.com/v1",
    defaultContextWindow: c.defaultContextWindow ?? 500_000,
    maxTokens: c.maxTokens ?? 131_072,
    streamIdleTimeoutMs: c.streamIdleTimeoutMs ?? 300_000,
    retryPolicy: c.retryPolicy,
  };
}
