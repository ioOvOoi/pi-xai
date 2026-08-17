/**
 * pi-xai — xAI / Grok Build extras for DeepSeek Harness.
 *
 * Host half: registers the `pi-xai` LLM provider route (Grok Build subscription
 * path via the xAI Responses API), a `pi-xai:` settings section, three agentic
 * tools, and the /xai-usage command.
 */

import { Context } from "@deepseek-ai/cordis";
import { installSettingsSection } from "@deepseek-ai/dsh-settings";
import {
  LlmRuntime,
  type AdapterRegistrationHandle,
  type DirectoryRegistrationHandle,
} from "@deepseek-ai/dsh-llm";
import { Config, NS, PROVIDER, resolveOptions } from "./config.ts";
import { XaiLlmAdapter } from "./adapter.ts";
import { createXaiApiKeyResolver } from "./credentials.ts";
import { registerTools } from "./tools.ts";
import { registerCommands } from "./commands.ts";

export const name = "pi-xai";

export const inject = ["llm", "tools", "commands"];

export function apply(ctx: Context, config: unknown): void {
  let current: () => unknown = () => config;
  const options = () => resolveOptions(current());
  const resolveApiKey = createXaiApiKeyResolver(ctx, options);
  const adapter = new XaiLlmAdapter({ options, resolveApiKey });

  // Registration handles are disposed explicitly on fiber teardown.
  let adapterHandle: AdapterRegistrationHandle | undefined;
  let directoryHandle: DirectoryRegistrationHandle | undefined;

  const registerRoutes = (): void => {
    try {
      adapterHandle?.();
    } catch {
      /* already disposed */
    }
    adapterHandle = ctx.llm.registerAdapter([PROVIDER], adapter);
  };

  ctx.effect(() => {
    registerRoutes();
    directoryHandle = ctx.llm.registerConfigurableProviders([
      { provider: PROVIDER, displayName: "Grok Build (xAI)", settingsNs: NS, settingsPath: [] },
    ]);
    return () => {
      try {
        adapterHandle?.();
      } catch {
        /* ignore */
      }
      try {
        directoryHandle?.();
      } catch {
        /* ignore */
      }
    };
  }, "pi-xai: llm route + directory");

  // `pi-xai:` settings section overlays the row config; config changes re-resolve
  // connection facts on the next request (options() reads the live source).
  installSettingsSection(ctx, NS, Config, config as never, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {
      registerRoutes();
    },
  });

  registerTools(ctx, { options, resolveApiKey });
  registerCommands(ctx as unknown as Parameters<typeof registerCommands>[0], resolveApiKey);
}
