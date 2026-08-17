/**
 * Media + web tools for pi-xai (DSH edition), ported from the Pi-era extension.
 * image_gen / image_edit use the resolved plugin credentials; image_to_video and
 * web_fetch are self-contained (video resolves credentials internally per protocol).
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { generateImage, editImage } from "./protocol/xai-image-gen.ts";
import { imageToVideo } from "./protocol/xai-video-gen.ts";
import { webFetch } from "./protocol/xai-web-fetch.ts";
import type { ResolvedOptions } from "./config.ts";

export interface ToolHost {
  tools: {
    register(tool: unknown): () => void;
  };
}

export interface ToolEnv {
  options(): ResolvedOptions;
  resolveApiKey(): Promise<string>;
}

const renderResult = (_args: unknown, value: { text?: string } & Record<string, unknown>) => [
  { type: "text" as const, text: value?.text ?? JSON.stringify(value, null, 2) },
];

export function registerMediaTools(ctx: ToolHost, env: ToolEnv): void {
  const { options, resolveApiKey } = env;

  ctx.tools.register(
    defineTool({
      name: "image_gen",
      description:
        "Generate an image via xAI Imagine (Grok Build image_gen). Returns the saved local path.",
      parameters: {
        prompt: { type: "string", required: true, description: "Image description (verbatim)" },
        aspect_ratio: {
          type: "string",
          description: "Aspect ratio (default auto; e.g. 1:1, 16:9, 9:16)",
        },
        model: {
          type: "string",
          description: "Model override (default grok-imagine-image-quality)",
        },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderResult },
      timeoutMs: 300_000,
      async execute(args: any) {
        const { prompt, aspect_ratio, model } = args ?? {};
        const apiKey = await resolveApiKey();
        const baseUrl = options().baseURL;
        const result = await generateImage(apiKey, baseUrl, {
          prompt,
          aspect_ratio,
          model,
        });
        return { text: `Image saved to ${result.path} (${result.model})` };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "image_edit",
      description:
        "Edit an image via xAI Imagine (Grok Build image_edit). Returns the saved local path.",
      parameters: {
        prompt: { type: "string", required: true, description: "Edit instruction" },
        image: {
          type: "json",
          required: true,
          description: "Image reference: a local path / https URL / data URI, or an array of them",
        },
        aspect_ratio: {
          type: "string",
          description: "Aspect ratio for multi-image edits (default auto)",
        },
        model: {
          type: "string",
          description: "Model override (default grok-imagine-image-quality)",
        },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderResult },
      timeoutMs: 300_000,
      async execute(args: any) {
        const { prompt, image, aspect_ratio, model } = args ?? {};
        const apiKey = await resolveApiKey();
        const baseUrl = options().baseURL;
        const refs =
          typeof image === "string" ? image : Array.isArray(image) ? image : String(image);
        const result = await editImage(apiKey, baseUrl, {
          prompt,
          image: refs,
          aspect_ratio,
          model,
        });
        return { text: `Edited image saved to ${result.path} (${result.model})` };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "image_to_video",
      description:
        "Animate a source image into a short clip via xAI (Grok Build image_to_video). Returns the saved local path.",
      parameters: {
        image: {
          type: "string",
          required: true,
          description: "Source image: local path / https URL / data URI",
        },
        prompt: { type: "string", description: "Motion prompt (1–2 sentences)" },
        duration: { type: "number", description: "6 or 10 seconds (default 6)" },
        model: { type: "string", description: "Model override (default grok-imagine-video)" },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderResult },
      timeoutMs: 360_000,
      async execute(args: any) {
        const { image, prompt, duration, model } = args ?? {};
        const result = await imageToVideo({ image, prompt, duration, model });
        return {
          text: `Video saved to ${result.path} (${result.model}, ${result.duration ?? "?"}s)`,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "web_fetch",
      description:
        "Fetch a URL and return its text content (SSRF-guarded; HTML converted to rough markdown).",
      parameters: {
        url: { type: "string", required: true, description: "The URL to fetch (http/https)" },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderResult },
      timeoutMs: 30_000,
      async execute(args: any) {
        const { url } = args ?? {};
        const result = await webFetch(url);
        return {
          text:
            `**URL:** ${result.finalUrl}\n**Content-Type:** ${result.contentType}\n\n` +
            result.text,
        };
      },
    }),
  );
}
