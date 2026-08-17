/**
 * Slash commands for pi-xai (DSH edition).
 */

import { fetchBillingUsage, formatGrokBuildBilling } from "./protocol/xai-oauth.ts";

export interface CommandHost {
  commands: {
    register(definition: {
      name: string;
      description: string;
      input?: { hint: string };
      handler(invocation: {
        commandId?: string;
        agent?: unknown;
        rawInput?: string;
        signal?: AbortSignal;
      }):
        | Promise<{ kind: "success" | "error"; text: string }>
        | { kind: "success" | "error"; text: string };
    }): () => void;
  };
}

export function registerCommands(ctx: CommandHost, resolveApiKey: () => Promise<string>): void {
  ctx.commands.register({
    name: "xai-usage",
    description: "Show Grok Build subscription usage / quota",
    input: { hint: "[statusbar|status|show|quota]" },
    async handler(invocation) {
      const sub = String(invocation.rawInput ?? "")
        .trim()
        .toLowerCase();
      if (sub === "statusbar" || sub === "status") {
        return {
          kind: "success",
          text: "/xai-usage statusbar 需要客户端 UI 常驻区（二期支持）；当前仅支持配额查询。/xai-usage 查看本期用量。",
        };
      }
      try {
        const apiKey = await resolveApiKey();
        const billing = await fetchBillingUsage(apiKey);
        return { kind: "success", text: formatGrokBuildBilling(billing, {}) };
      } catch (err: any) {
        return { kind: "error", text: `${err?.message ?? String(err)}` };
      }
    },
  });
}
