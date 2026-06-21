const DEFAULT_UPSTREAM_BASE_URL = "https://unlimited.surf";
const DEFAULT_MODEL = "gateway-gpt-5";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,content-type,x-api-key,anthropic-api-key,anthropic-version,anthropic-beta,openai-beta",
  "Access-Control-Expose-Headers": "content-type,request-id,x-request-id",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      const authError = validateWorkerApiKey(request, env);
      if (authError) return authError;

      const url = new URL(request.url);
      const path = normalizePath(url.pathname);

      if (path === "/" || path === "/health") {
        return jsonResponse({
          ok: true,
          service: "unlimited.surf OpenAI-compatible Worker",
          upstream: upstreamBase(env),
          endpoints: ["/v1/models", "/v1/chat/completions", "/v1/responses", "/v1/messages", "/anthropic/v1/messages", "/api/*"],
        });
      }

      if (path.startsWith("/api/")) return proxyRawUpstream(request, env, path);

      if (path === "/v1/setup" || path === "/setup" || path === "/anthropic/v1/setup") return textResponse(setupText(request));
      if (path === "/v1/mcp" || path === "/mcp" || path === "/anthropic/v1/mcp") return jsonResponse(mcpInfo(request));
      if (path === "/v1/codex" || path === "/codex" || path === "/anthropic/v1/codex") return textResponse(codexText(request));

      if (isAnthropicMessagesPath(path) && request.method === "POST") return proxyAnthropic(request, env, "/v1/messages");
      if (isAnthropicModelsPath(path) && request.method === "GET") return anthropicModels(request, env);

      if (path === "/v1/models" && request.method === "GET") {
        if (looksLikeAnthropicRequest(request)) return anthropicModels(request, env);
        return openAIModels(request, env);
      }
      if (path === "/v1/chat/completions" && request.method === "POST") {
        return openAIChatCompletions(request, env, await readJson(request));
      }
      if (path === "/v1/responses" && request.method === "POST") {
        return openAIResponses(request, env, await readJson(request));
      }
      if ((path === "/v1/files/extract" || path === "/v1/attachments/extract") && request.method === "POST") {
        return proxyJsonCapability(request, env, "/api/attachments/extract", await readJson(request));
      }
      if (path === "/v1/files" && request.method === "GET") {
        return jsonResponse({ object: "list", data: [], has_more: false });
      }
      if (path === "/v1/embeddings" || path.startsWith("/v1/audio/") || path.startsWith("/v1/images/")) {
        return errorResponse(501, "unsupported_endpoint", `${path} is not provided by unlimited.surf.`);
      }

      return errorResponse(404, "not_found", `Unsupported route: ${path}`);
    } catch (error) {
      return errorResponse(500, "internal_error", error && error.message ? error.message : String(error));
    }
  },
};

async function openAIModels(request, env) {
  const response = await fetch(new URL("/api/models", upstreamBase(env)), {
    headers: upstreamHeaders(request, env, false),
  });

  if (!response.ok) return jsonResponse({ object: "list", data: fallbackModels() });

  const raw = await response.json();
  const models = Array.isArray(raw) ? raw : Array.isArray(raw.data) ? raw.data : [];
  return jsonResponse({
    object: "list",
    data: models.map((model) => ({
      id: model.id || model.name,
      object: "model",
      created: 0,
      owned_by: model.provider || "unlimited.surf",
    })).filter((model) => model.id),
  });
}

async function anthropicModels(request, env) {
  const response = await fetch(new URL("/api/models", upstreamBase(env)), {
    headers: upstreamHeaders(request, env, false),
  });

  const raw = response.ok ? await response.json() : { data: fallbackModels() };
  const models = Array.isArray(raw) ? raw : Array.isArray(raw.data) ? raw.data : [];
  return jsonResponse({
    data: models.filter((model) => model.id).map((model) => ({
      id: toAnthropicModelId(model.id),
      type: "model",
      display_name: model.name || model.id,
      created_at: "2026-01-01T00:00:00Z",
    })),
  });
}

async function proxyAnthropic(request, env, upstreamPath) {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${upstreamApiKey(request, env)}`);
  headers.set("x-api-key", upstreamApiKey(request, env));
  headers.set("anthropic-api-key", upstreamApiKey(request, env));
  headers.set("Content-Type", request.headers.get("content-type") || "application/json");

  for (const name of ["anthropic-version", "anthropic-beta", "accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const response = await fetch(new URL(upstreamPath, upstreamBase(env)), {
    method: request.method,
    headers,
    body: request.body,
  });

  return addCors(new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: filterResponseHeaders(response.headers),
  }));
}

async function openAIChatCompletions(request, env, body) {
  const unsupported = unsupportedToolRequest(body);
  if (unsupported) return unsupported;

  const model = body.model || env.DEFAULT_MODEL || DEFAULT_MODEL;
  const id = `chatcmpl_${randomId()}`;
  const created = nowSeconds();
  const payload = {
    message: body.message || messagesToText(body.messages) || inputToText(body.input) || body.prompt || "",
    model,
    effort: reasoningEffort(body),
  };

  if (body.stream) {
    const upstream = await callUnlimitedStream(request, env, "/api/chat", payload);
    return sseResponse(streamOpenAIChat(upstream, { id, created, model }));
  }

  const result = await collectUnlimitedText(request, env, "/api/chat", payload);
  return jsonResponse({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: result.text },
      logprobs: null,
      finish_reason: result.reason || "stop",
    }],
    usage: usageFromText(payload.message, result.text),
    system_fingerprint: "unlimited-openai-worker",
  });
}

async function openAIResponses(request, env, body) {
  const unsupported = unsupportedToolRequest(body);
  if (unsupported) return unsupported;

  const model = body.model || env.DEFAULT_MODEL || DEFAULT_MODEL;
  const id = `resp_${randomId()}`;
  const created = nowSeconds();
  const input = inputToText(body.input) || messagesToText(body.messages) || body.prompt || "";
  const payload = { message: input, model, effort: reasoningEffort(body) };

  if (body.stream) {
    const upstream = await callUnlimitedStream(request, env, "/api/chat", payload);
    return sseResponse(streamOpenAIResponses(upstream, { id, created, model }));
  }

  const result = await collectUnlimitedText(request, env, "/api/chat", payload);
  return jsonResponse({
    id,
    object: "response",
    created_at: created,
    status: "completed",
    error: null,
    model,
    output: [{
      id: `msg_${randomId()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: result.text, annotations: [] }],
    }],
    output_text: result.text,
    usage: responseUsageFromText(input, result.text),
  });
}

function unsupportedToolRequest(body) {
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const wantsToolChoice = body.tool_choice && body.tool_choice !== "none";
  const hasToolMessages = Array.isArray(body.messages) && body.messages.some((message) => {
    return message.role === "tool" || message.function_call || Array.isArray(message.tool_calls);
  });

  if (!hasTools && !wantsToolChoice && !hasToolMessages) return null;

  return errorResponse(
    501,
    "tool_calls_not_supported",
    "unlimited.surf /api/chat streams text deltas and does not expose structured OpenAI tool_calls. Use this Worker for NewAPI chat, not agent command execution."
  );
}

async function proxyJsonCapability(request, env, path, body) {
  const response = await fetch(new URL(path, upstreamBase(env)), {
    method: "POST",
    headers: upstreamHeaders(request, env, false),
    body: JSON.stringify(body),
  });
  return addCors(new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: filterResponseHeaders(response.headers),
  }));
}

async function proxyRawUpstream(request, env, path) {
  const url = new URL(request.url);
  const upstreamUrl = new URL(path + url.search, upstreamBase(env));
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${upstreamApiKey(request, env)}`);
  headers.delete("host");

  const response = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  });
  return addCors(new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: filterResponseHeaders(response.headers),
  }));
}

async function callUnlimitedStream(request, env, path, payload) {
  const response = await fetch(new URL(path, upstreamBase(env)), {
    method: "POST",
    headers: upstreamHeaders(request, env, true),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`upstream ${path} failed: ${response.status} ${await response.text()}`);
  return response;
}

async function collectUnlimitedText(request, env, path, payload) {
  const response = await callUnlimitedStream(request, env, path, payload);
  const events = await readUnlimitedEvents(response);
  let text = "";
  let reason = "stop";
  for (const event of events) {
    if (typeof event.delta === "string") text += event.delta;
    if (event.text && typeof event.text === "string") text += event.text;
    if (event.finish || event.done) reason = event.reason || reason;
    if (event.error) throw new Error(typeof event.error === "string" ? event.error : JSON.stringify(event.error));
  }
  return { text, reason };
}

function streamOpenAIChat(upstream, meta) {
  return streamUnlimitedEvents(upstream, {
    start(controller) {
      writeSse(controller, {
        id: meta.id,
        object: "chat.completion.chunk",
        created: meta.created,
        model: meta.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });
    },
    delta(controller, text) {
      writeSse(controller, {
        id: meta.id,
        object: "chat.completion.chunk",
        created: meta.created,
        model: meta.model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      });
    },
    finish(controller, reason) {
      writeSse(controller, {
        id: meta.id,
        object: "chat.completion.chunk",
        created: meta.created,
        model: meta.model,
        choices: [{ index: 0, delta: {}, finish_reason: openAIStopReason(reason) }],
      });
      writeRawSse(controller, "data: [DONE]\n\n");
    },
  });
}

function streamOpenAIResponses(upstream, meta) {
  const outputId = `msg_${randomId()}`;
  let fullText = "";
  return streamUnlimitedEvents(upstream, {
    start(controller) {
      writeSseEvent(controller, "response.created", {
        type: "response.created",
        response: { id: meta.id, object: "response", created_at: meta.created, status: "in_progress", model: meta.model, output: [] },
      });
      writeSseEvent(controller, "response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: outputId, type: "message", status: "in_progress", role: "assistant", content: [] },
      });
      writeSseEvent(controller, "response.content_part.added", {
        type: "response.content_part.added",
        item_id: outputId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    },
    delta(controller, text) {
      fullText += text;
      writeSseEvent(controller, "response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: outputId,
        output_index: 0,
        content_index: 0,
        delta: text,
      });
    },
    finish(controller) {
      writeSseEvent(controller, "response.output_text.done", {
        type: "response.output_text.done",
        item_id: outputId,
        output_index: 0,
        content_index: 0,
        text: fullText,
      });
      writeSseEvent(controller, "response.content_part.done", {
        type: "response.content_part.done",
        item_id: outputId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: fullText, annotations: [] },
      });
      writeSseEvent(controller, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: outputId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: fullText, annotations: [] }] },
      });
      writeSseEvent(controller, "response.completed", {
        type: "response.completed",
        response: { id: meta.id, object: "response", created_at: meta.created, status: "completed", model: meta.model },
      });
      writeRawSse(controller, "data: [DONE]\n\n");
    },
  });
}

function streamUnlimitedEvents(upstream, handlers) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return new ReadableStream({
    async start(controller) {
      let finished = false;
      let buffer = "";
      try {
        if (handlers.start) handlers.start(controller);
        const reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            const event = parseDataLine(line);
            if (!event) continue;
            if (event.error) throw new Error(typeof event.error === "string" ? event.error : JSON.stringify(event.error));
            if (typeof event.delta === "string" && handlers.delta) handlers.delta(controller, event.delta, event);
            if (typeof event.text === "string" && handlers.delta) handlers.delta(controller, event.text, event);
            if (event.finish || event.done) {
              finished = true;
              if (handlers.finish) handlers.finish(controller, event.reason || "stop", event);
            }
          }
        }
        if (!finished && handlers.finish) handlers.finish(controller, "stop", {});
      } catch (error) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: { message: error.message || String(error) } })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
}

async function readUnlimitedEvents(response) {
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const events = [];
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const event = parseDataLine(line);
      if (event) events.push(event);
    }
  }
  const event = parseDataLine(buffer);
  if (event) events.push(event);
  return events;
}

function parseDataLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch (_) {
    return null;
  }
}

function messagesToText(messages) {
  if (!Array.isArray(messages)) return "";
  return messages.map((message) => {
    const role = message.role || "user";
    return `${role}: ${contentToText(message.content)}`;
  }).filter(Boolean).join("\n\n");
}

function inputToText(input) {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return contentToText(input);
  return input.map((item) => {
    if (typeof item === "string") return item;
    if (item.type === "message") return `${item.role || "user"}: ${contentToText(item.content)}`;
    if (item.role) return `${item.role}: ${contentToText(item.content)}`;
    if (item.type === "input_text" || item.type === "output_text") return item.text || "";
    return contentToText(item);
  }).filter(Boolean).join("\n\n");
}

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentToText).filter(Boolean).join("\n");
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (content.type === "text" && typeof content.text === "string") return content.text;
    if (content.type === "input_text" && typeof content.text === "string") return content.text;
    if (content.type === "image_url") return "[image]";
    if (content.type === "tool_result") return `[tool_result] ${contentToText(content.content)}`;
    if (content.type) return `[${content.type}] ${JSON.stringify(content)}`;
  }
  return String(content);
}

function upstreamHeaders(request, env, wantsStream) {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${upstreamApiKey(request, env)}`);
  headers.set("Content-Type", "application/json");
  if (wantsStream) headers.set("Accept", "text/event-stream");
  return headers;
}

function upstreamApiKey(request, env) {
  const key = env.UNLIMITED_SURF_API_KEY || clientApiKey(request);
  if (key) return key;
  throw new Error("Missing upstream API key. Set UNLIMITED_SURF_API_KEY or pass Authorization: Bearer <key>.");
}

function validateWorkerApiKey(request, env) {
  if (!env.WORKER_API_KEY) return null;
  const key = clientApiKey(request);
  if (key && constantTimeEqual(key, env.WORKER_API_KEY)) return null;
  return errorResponse(401, "unauthorized", "Invalid or missing API key.");
}

function clientApiKey(request) {
  const auth = request.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return (request.headers.get("x-api-key") || request.headers.get("anthropic-api-key") || "").trim();
}

function constantTimeEqual(actual, expected) {
  const a = String(actual || "");
  const b = String(expected || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(init.headers || {}) },
  });
}

function textResponse(text, init = {}) {
  return new Response(text, {
    ...init,
    headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...(init.headers || {}) },
  });
}

function errorResponse(status, code, message) {
  return jsonResponse({ error: { message, type: code, code } }, { status });
}

function sseResponse(body) {
  return new Response(body, {
    headers: { ...CORS_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive" },
  });
}

function addCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function filterResponseHeaders(source) {
  const headers = new Headers();
  for (const name of ["content-type", "cache-control", "request-id", "x-request-id"]) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

async function readJson(request) {
  if (!request.body) return {};
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error("Request body must be valid JSON.");
  }
}

function writeSse(controller, data) {
  writeRawSse(controller, `data: ${JSON.stringify(data)}\n\n`);
}

function writeSseEvent(controller, event, data) {
  writeRawSse(controller, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function writeRawSse(controller, chunk) {
  controller.enqueue(new TextEncoder().encode(chunk));
}

function reasoningEffort(body) {
  const effort = body.effort || (body.reasoning && body.reasoning.effort);
  if (["low", "medium", "high"].includes(effort)) return effort;
  return "medium";
}

function usageFromText(input, output) {
  return {
    prompt_tokens: estimateTokens(input),
    completion_tokens: estimateTokens(output),
    total_tokens: estimateTokens(input) + estimateTokens(output),
  };
}

function responseUsageFromText(input, output) {
  return {
    input_tokens: estimateTokens(input),
    output_tokens: estimateTokens(output),
    total_tokens: estimateTokens(input) + estimateTokens(output),
  };
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function openAIStopReason(reason) {
  if (!reason || reason === "done") return "stop";
  if (reason === "length" || reason === "stop" || reason === "content_filter") return reason;
  return "stop";
}

function fallbackModels() {
  return [
    { id: "gateway-gpt-5", object: "model", created: 0, owned_by: "openai" },
    { id: "gateway-gpt-5-5", object: "model", created: 0, owned_by: "openai" },
    { id: "gateway-claude-opus-4-7", object: "model", created: 0, owned_by: "anthropic" },
    { id: "gateway-google-2.5-pro", object: "model", created: 0, owned_by: "google" },
  ];
}

function isAnthropicMessagesPath(path) {
  return path === "/v1/messages" || path === "/anthropic/v1/messages" || path === "/anthropic/messages";
}

function isAnthropicModelsPath(path) {
  return path === "/anthropic/v1/models" || path === "/anthropic/models";
}

function looksLikeAnthropicRequest(request) {
  return request.headers.has("anthropic-version") || request.headers.has("anthropic-beta") || request.headers.has("anthropic-api-key");
}

function toAnthropicModelId(id) {
  const value = String(id || "");
  if (/^claude-.*-\d{8}$/.test(value)) return value;
  if (value.startsWith("gateway-claude-opus-4-8")) return "claude-opus-4-8-20260601";
  if (value.startsWith("gateway-claude-opus-4-7")) return "claude-opus-4-7-20260101";
  if (value.startsWith("gateway-claude-opus-4-6")) return "claude-opus-4-6-20260101";
  if (value.startsWith("gateway-claude-opus-4-5")) return "claude-opus-4-5-20260101";
  if (value.startsWith("gateway-claude-opus-4-1")) return "claude-opus-4-1-20250805";
  if (value.startsWith("gateway-claude-sonnet-4-6")) return "claude-sonnet-4-6-20260101";
  if (value.startsWith("gateway-claude-sonnet-4")) return "claude-sonnet-4-20250514";
  return value;
}

function setupText(request) {
  const origin = new URL(request.url).origin;
  return `unlimited.surf Worker setup

OpenAI/NewAPI:
  Base URL: ${origin}/v1
  API key: WORKER_API_KEY
  Model: gateway-gpt-5

Hermes / Claude Code / Anthropic-compatible agents:
  ANTHROPIC_BASE_URL=${origin}
  ANTHROPIC_AUTH_TOKEN=WORKER_API_KEY
  ANTHROPIC_API_KEY=WORKER_API_KEY
  ANTHROPIC_MODEL=claude-opus-4-7-20260101

MCP/tools execute in the local client or agent. This Worker only preserves and forwards Anthropic-compatible /v1/messages requests to unlimited.surf.`;
}

function codexText(request) {
  const origin = new URL(request.url).origin;
  return `Codex notes

OpenAI chat-compatible endpoint:
  ${origin}/v1/chat/completions

Text-only Responses compatibility:
  ${origin}/v1/responses

Anthropic-compatible endpoint for agents that support it:
  ${origin}/v1/messages

Native OpenAI structured tool_calls are not created by unlimited.surf /api/chat. Use the Anthropic-compatible route when your agent supports it.`;
}

function mcpInfo(request) {
  const origin = new URL(request.url).origin;
  return {
    supported: true,
    note: "MCP servers and shell tools run in the local agent, not inside Cloudflare Worker.",
    endpoints: {
      openai_chat_completions: `${origin}/v1/chat/completions`,
      openai_responses_text_only: `${origin}/v1/responses`,
      anthropic_messages: `${origin}/v1/messages`,
      anthropic_messages_alias: `${origin}/anthropic/v1/messages`,
    },
  };
}

function upstreamBase(env) {
  return stripTrailingSlash(env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_BASE_URL) + "/";
}

function normalizePath(path) {
  if (!path || path === "") return "/";
  const normalized = path.replace(/\/+/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
