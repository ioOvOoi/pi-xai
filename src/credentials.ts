/**
 * Credential resolution for xAI / Grok Build inside DSH.
 *
 * Precedence (mirrors the Pi-era chain, adapted to the DSH credentials seam):
 *   1. DSH credentials service reference (settings `pi-xai.apiKeyEnv`, default XAI_API_KEY)
 *   2. launch-environment fallback for the same reference
 *   3. Grok Build subscription chain from the ported protocol layer:
 *      pi auth `grok-build` OAuth, ~/.grok/auth.json import, xai OAuth, env, settings
 */

import { assertUsableApiKey, LlmError } from "@deepseek-ai/dsh-llm";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import type { Context } from "@deepseek-ai/cordis";
import { getEffectiveXaiApiKey } from "./protocol/xai-oauth.ts";

/** The subset of the credentials service this helper consumes. */
export interface CredentialService {
  resolve(ref: string): Promise<{ value: string } | undefined>;
}

export interface CredentialOptions {
  (): { apiKeyEnv: string };
}

/**
 * Build a `() => Promise<string>` API-key resolver bound to the plugin host.
 * Throws LlmError('MISSING_CREDENTIAL') when nothing resolves.
 */
export function createXaiApiKeyResolver(
  ctx: Context,
  options: CredentialOptions,
): () => Promise<string> {
  return async (): Promise<string> => {
    const ref = options().apiKeyEnv;
    const credentials = (ctx.get("credentials") as CredentialService | null) ?? undefined;
    if (credentials !== void 0) {
      const hit = await credentials.resolve(ref);
      if (hit !== void 0) return assertUsableApiKey(hit.value, "pi-xai", ref);
    }
    const ambient = launchEnvironmentOf(ctx).get(ref);
    if (ambient !== void 0 && ambient.value.length > 0) {
      return assertUsableApiKey(ambient.value, "pi-xai", ref);
    }
    // Grok Build subscription OAuth / grok-cli import / settings (ported chain).
    const effective = await getEffectiveXaiApiKey();
    if (effective?.apiKey) return effective.apiKey;
    throw new LlmError(
      `pi-xai: no xAI credentials. Configure ${ref} (DSH settings/credentials) or log in to Grok Build (OAuth via ~/.grok/auth.json import).`,
      "MISSING_CREDENTIAL",
    );
  };
}
