/**
 * DSH tool surface: registration, schema, and execute wiring.
 * Network / Imagine / video / fetch are mocked — this file checks the tools
 * themselves, not the live xAI API.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ToolArgsError } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { resolveOptions } from "../src/config.ts";

const mocks = vi.hoisted(() => ({
  callXaiResponses: vi.fn(),
  generateImage: vi.fn(),
  editImage: vi.fn(),
  imageToVideo: vi.fn(),
  webFetch: vi.fn(),
}));

vi.mock("../src/protocol/xai-payload.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/protocol/xai-payload.ts")>();
  return { ...actual, callXaiResponses: mocks.callXaiResponses };
});

vi.mock("../src/protocol/xai-image-gen.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/protocol/xai-image-gen.ts")>();
  return { ...actual, generateImage: mocks.generateImage, editImage: mocks.editImage };
});

vi.mock("../src/protocol/xai-video-gen.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/protocol/xai-video-gen.ts")>();
  return { ...actual, imageToVideo: mocks.imageToVideo };
});

vi.mock("../src/protocol/xai-web-fetch.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/protocol/xai-web-fetch.ts")>();
  return { ...actual, webFetch: mocks.webFetch };
});

import { registerTools } from "../src/tools.ts";
import { registerMediaTools } from "../src/media-tools.ts";
import { formatResponseSummary } from "../src/protocol/xai-payload.ts";

const AGENTIC_NAMES = ["xai_generate_text", "xai_multi_agent", "xai_x_search"] as const;
const MEDIA_NAMES = ["image_gen", "image_edit", "image_to_video", "web_fetch"] as const;

function fakeResponse(overrides: Record<string, unknown> = {}) {
  return {
    model: "grok-4.6",
    output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 11, output_tokens: 7 },
    ...overrides,
  };
}

function collectTools() {
  const registered: ToolDefinition[] = [];
  const resolveApiKey = vi.fn(async () => "test-key");
  const env = {
    options: () => resolveOptions({ baseURL: "https://api.x.ai/v1" }),
    resolveApiKey,
  };
  const ctx = {
    tools: {
      register(tool: unknown) {
        registered.push(tool as ToolDefinition);
        return () => undefined;
      },
    },
    get() {
      return undefined;
    },
  };
  registerTools(ctx, env);
  registerMediaTools(ctx, env);
  const byName = Object.fromEntries(registered.map((t) => [t.name, t])) as Record<
    string,
    ToolDefinition
  >;
  return { registered, byName, resolveApiKey };
}

describe("tool registration", () => {
  test("registers all seven DSH tools with names, descriptions, and timeouts", () => {
    const { registered, byName } = collectTools();
    expect(registered.map((t) => t.name)).toEqual([...AGENTIC_NAMES, ...MEDIA_NAMES]);
    for (const name of [...AGENTIC_NAMES, ...MEDIA_NAMES]) {
      const tool = byName[name];
      expect(tool, name).toBeDefined();
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.timeoutMs).toBeGreaterThan(0);
      expect(tool.parameters).toMatchObject({ type: "object" });
      expect(typeof tool.execute).toBe("function");
      expect(typeof tool.output.render).toBe("function");
    }
  });

  test("required parameters match the public contract", () => {
    const { byName } = collectTools();
    expect(byName.xai_generate_text.parameters.required).toEqual(["prompt"]);
    expect(byName.xai_multi_agent.parameters.required).toEqual(["prompt"]);
    expect(byName.xai_x_search.parameters.required).toEqual(["query"]);
    expect(byName.image_gen.parameters.required).toEqual(["prompt"]);
    expect(byName.image_edit.parameters.required).toEqual(["prompt", "image"]);
    expect(byName.image_to_video.parameters.required).toEqual(["image"]);
    expect(byName.web_fetch.parameters.required).toEqual(["url"]);
  });
});

describe("schema validation", () => {
  test("rejects missing required args before any network call", async () => {
    const { byName } = collectTools();
    await expect(byName.xai_generate_text.execute({}, undefined as never)).rejects.toBeInstanceOf(
      ToolArgsError,
    );
    await expect(byName.xai_x_search.execute({}, undefined as never)).rejects.toBeInstanceOf(
      ToolArgsError,
    );
    await expect(
      byName.image_edit.execute({ prompt: "x" }, undefined as never),
    ).rejects.toBeInstanceOf(ToolArgsError);
    await expect(byName.web_fetch.execute({}, undefined as never)).rejects.toBeInstanceOf(
      ToolArgsError,
    );
    expect(mocks.callXaiResponses).not.toHaveBeenCalled();
    expect(mocks.editImage).not.toHaveBeenCalled();
    expect(mocks.webFetch).not.toHaveBeenCalled();
  });
});

describe("xai_generate_text", () => {
  beforeEach(() => {
    mocks.callXaiResponses.mockReset();
    mocks.callXaiResponses.mockResolvedValue(fakeResponse());
  });

  test("default model, user input, and 1h timeout for reasoning models", async () => {
    const { byName, resolveApiKey } = collectTools();
    const out = await byName.xai_generate_text.execute({ prompt: "hi" }, undefined as never);
    expect(resolveApiKey).toHaveBeenCalledOnce();
    expect(mocks.callXaiResponses).toHaveBeenCalledOnce();
    const [apiKey, baseUrl, body, timeout, sessionId] = mocks.callXaiResponses.mock.calls[0];
    expect(apiKey).toBe("test-key");
    expect(baseUrl).toBe("https://api.x.ai/v1");
    expect(body).toEqual({
      model: "grok-4.6",
      input: [{ role: "user", content: "hi" }],
    });
    expect(timeout).toBe(3_600_000);
    // Custom tools do not yet forward a session id, so callXaiResponses cannot
    // stamp prompt_cache_key from the DSH session (main-chat adapter still does).
    expect(sessionId).toBeUndefined();
    expect(out).toEqual({ text: formatResponseSummary(fakeResponse(), "xAI Response") });
  });

  test("system + tools + structured output + previous_response_id", async () => {
    const { byName } = collectTools();
    const schema = JSON.stringify({
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    });
    await byName.xai_generate_text.execute(
      {
        prompt: "q",
        system: "be brief",
        model: "grok-4.5",
        reasoningEffort: "low",
        previousResponseId: "resp_1",
        maxOutputTokens: 32,
        temperature: 0.2,
        store: false,
        include: ["reasoning.encrypted_content"],
        tools: ["web_search", { type: "x_search", from_date: "2025-01-01" }],
        responseFormat: schema,
      },
      undefined as never,
    );
    const body = mocks.callXaiResponses.mock.calls[0][2] as Record<string, unknown>;
    expect(body.model).toBe("grok-4.5");
    expect(body.input).toEqual([
      { role: "developer", content: "be brief" },
      { role: "user", content: "q" },
    ]);
    expect(body.previous_response_id).toBe("resp_1");
    expect(body.max_output_tokens).toBe(32);
    expect(body.temperature).toBe(0.2);
    expect(body.store).toBe(false);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.tools).toEqual([
      { type: "web_search" },
      { type: "x_search", from_date: "2025-01-01" },
    ]);
    expect(body.text).toEqual({
      format: {
        type: "json_schema",
        json_schema: { name: "response", schema: JSON.parse(schema), strict: true },
      },
    });
  });

  test("grok-build keeps default 1h timeout but does not send reasoning.effort", async () => {
    const { byName } = collectTools();
    await byName.xai_generate_text.execute(
      { prompt: "x", model: "grok-build", reasoningEffort: "high" },
      undefined as never,
    );
    const [, , body, timeout] = mocks.callXaiResponses.mock.calls[0];
    expect(body.model).toBe("grok-build");
    expect(body.reasoning).toBeUndefined();
    expect(timeout).toBe(3_600_000);
  });

  test("non-reasoning model uses 5min default timeout and skips reasoning", async () => {
    const { byName } = collectTools();
    await byName.xai_generate_text.execute(
      { prompt: "x", model: "grok-3", reasoningEffort: "high", timeout: 12_000 },
      undefined as never,
    );
    const [, , body, timeout] = mocks.callXaiResponses.mock.calls[0];
    expect(body.reasoning).toBeUndefined();
    expect(timeout).toBe(12_000);
  });

  test("invalid responseFormat JSON fails before the API call", async () => {
    const { byName } = collectTools();
    await expect(
      byName.xai_generate_text.execute(
        { prompt: "x", responseFormat: "{not-json" },
        undefined as never,
      ),
    ).rejects.toThrow(SyntaxError);
    expect(mocks.callXaiResponses).not.toHaveBeenCalled();
  });

  test("propagates xAI API errors", async () => {
    mocks.callXaiResponses.mockRejectedValueOnce(new Error("xAI API error: 401 unauthorized"));
    const { byName } = collectTools();
    await expect(
      byName.xai_generate_text.execute({ prompt: "x" }, undefined as never),
    ).rejects.toThrow(/401/);
  });
});

describe("xai_multi_agent", () => {
  beforeEach(() => {
    mocks.callXaiResponses.mockReset();
    mocks.callXaiResponses.mockResolvedValue(fakeResponse({ model: "grok-4.20-multi-agent-0309" }));
  });

  test("pins multi-agent model and maps tools", async () => {
    const { byName } = collectTools();
    const out = await byName.xai_multi_agent.execute(
      {
        prompt: "research cache",
        reasoningEffort: "high",
        tools: ["web_search"],
        previousResponseId: "r2",
        store: true,
        include: ["foo"],
      },
      undefined as never,
    );
    const [, , body, timeout] = mocks.callXaiResponses.mock.calls[0];
    expect(body).toEqual({
      model: "grok-4.20-multi-agent-0309",
      input: [{ role: "user", content: "research cache" }],
      reasoning: { effort: "high" },
      previous_response_id: "r2",
      tools: [{ type: "web_search" }],
      store: true,
      include: ["foo"],
    });
    expect(timeout).toBe(3_600_000);
    expect(out).toEqual({
      text: formatResponseSummary(
        fakeResponse({ model: "grok-4.20-multi-agent-0309" }),
        "xAI Multi-Agent",
      ),
    });
  });
});

describe("xai_x_search", () => {
  beforeEach(() => {
    mocks.callXaiResponses.mockReset();
    mocks.callXaiResponses.mockResolvedValue(
      fakeResponse({
        model: "grok-4.20-0309-reasoning",
        output: [
          { type: "x_search_call", action: { query: "grok" }, status: "completed" },
          { type: "message", content: [{ type: "output_text", text: "posts" }] },
        ],
      }),
    );
  });

  test("trims query/dates and always sends x_search + store:false", async () => {
    const { byName } = collectTools();
    const out = await byName.xai_x_search.execute(
      { query: "  grok  ", from_date: " 2025-01-01 ", to_date: " 2025-02-01 " },
      undefined as never,
    );
    const [, , body, timeout] = mocks.callXaiResponses.mock.calls[0];
    expect(body).toEqual({
      model: "grok-4.20-0309-reasoning",
      input: [{ role: "user", content: "grok" }],
      tools: [{ type: "x_search", from_date: "2025-01-01", to_date: "2025-02-01" }],
      store: false,
    });
    expect(timeout).toBe(300_000);
    expect(String((out as { text: string }).text)).toContain("X search");
    expect(String((out as { text: string }).text)).toContain("posts");
  });

  test("omits blank date filters", async () => {
    const { byName } = collectTools();
    await byName.xai_x_search.execute(
      { query: "x", from_date: "  ", to_date: "" },
      undefined as never,
    );
    const body = mocks.callXaiResponses.mock.calls[0][2] as {
      tools: Array<Record<string, unknown>>;
    };
    expect(body.tools).toEqual([{ type: "x_search" }]);
  });
});

describe("media tools", () => {
  beforeEach(() => {
    mocks.generateImage.mockReset();
    mocks.editImage.mockReset();
    mocks.imageToVideo.mockReset();
    mocks.webFetch.mockReset();
    mocks.generateImage.mockResolvedValue({
      path: "C:/tmp/gen.jpg",
      model: "grok-imagine-image-quality",
    });
    mocks.editImage.mockResolvedValue({
      path: "C:/tmp/edit.jpg",
      model: "grok-imagine-image-quality",
    });
    mocks.imageToVideo.mockResolvedValue({
      path: "C:/tmp/clip.mp4",
      requestId: "vid-1",
      model: "grok-imagine-video",
      duration: 6,
    });
    mocks.webFetch.mockResolvedValue({
      url: "https://example.com",
      finalUrl: "https://example.com/final",
      contentType: "text/html",
      text: "# Hello",
    });
  });

  test("image_gen forwards credentials and prompt", async () => {
    const { byName } = collectTools();
    const out = await byName.image_gen.execute(
      { prompt: "a cube", aspect_ratio: "1:1", model: "custom-imagine" },
      undefined as never,
    );
    expect(mocks.generateImage).toHaveBeenCalledWith("test-key", "https://api.x.ai/v1", {
      prompt: "a cube",
      aspect_ratio: "1:1",
      model: "custom-imagine",
    });
    expect(out).toEqual({
      text: "Image saved to C:/tmp/gen.jpg (grok-imagine-image-quality)",
    });
  });

  test("image_edit accepts a string or an array of refs", async () => {
    const { byName } = collectTools();
    await byName.image_edit.execute(
      { prompt: "make it red", image: "https://example.com/a.png" },
      undefined as never,
    );
    expect(mocks.editImage.mock.calls[0][2]).toMatchObject({
      prompt: "make it red",
      image: "https://example.com/a.png",
    });
    await byName.image_edit.execute(
      { prompt: "blend", image: ["https://a", "https://b"], aspect_ratio: "16:9" },
      undefined as never,
    );
    expect(mocks.editImage.mock.calls[1][2]).toMatchObject({
      prompt: "blend",
      image: ["https://a", "https://b"],
      aspect_ratio: "16:9",
    });
  });

  test("image_to_video does not require the plugin API key (protocol resolves its own)", async () => {
    const { byName, resolveApiKey } = collectTools();
    const out = await byName.image_to_video.execute(
      { image: "shot.png", prompt: "pan left", duration: 10, model: "grok-imagine-video" },
      undefined as never,
    );
    expect(resolveApiKey).not.toHaveBeenCalled();
    expect(mocks.imageToVideo).toHaveBeenCalledWith({
      image: "shot.png",
      prompt: "pan left",
      duration: 10,
      model: "grok-imagine-video",
    });
    expect(out).toEqual({ text: "Video saved to C:/tmp/clip.mp4 (grok-imagine-video, 6s)" });
  });

  test("web_fetch formats url + content-type + body", async () => {
    const { byName } = collectTools();
    const out = await byName.web_fetch.execute({ url: "https://example.com" }, undefined as never);
    expect(mocks.webFetch).toHaveBeenCalledWith("https://example.com");
    expect(out).toEqual({
      text: "**URL:** https://example.com/final\n**Content-Type:** text/html\n\n# Hello",
    });
  });

  test("render() surfaces the text field for the model", () => {
    const { byName } = collectTools();
    expect(byName.web_fetch.output.render({}, { text: "shown" })).toEqual([
      { type: "text", text: "shown" },
    ]);
    expect(byName.xai_generate_text.output.render({}, { other: 1 })).toEqual([
      { type: "text", text: JSON.stringify({ other: 1 }, null, 2) },
    ]);
  });
});
