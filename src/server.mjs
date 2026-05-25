import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const ANALYSIS_PROMPT = `You are organizing a personal screenshot inbox.
Analyze only what is visible in the screenshot. Do not invent missing context.
Return only valid JSON with this exact shape:
{
  "title": "short searchable Chinese title",
  "summary": "one or two concise Chinese sentences",
  "ocr": "important visible text, shortened if long",
  "tags": ["2 to 5 short Chinese tags"],
  "next_action": "useful next action, or empty string",
  "sensitive": false,
  "sensitive_reason": "why it may be sensitive, or empty string"
}
Treat account numbers, codes, private conversations, medical, identity, payment, and login information as sensitive.`;

function asBoolean(value) {
  return String(value).toLowerCase() === "true";
}

export function readConfig(env = process.env) {
  return {
    port: Number(env.PORT || 8787),
    maxImageBytes: Number(env.MAX_IMAGE_BYTES || DEFAULT_MAX_IMAGE_BYTES),
    captureToken: env.CAPTURE_TOKEN || "",
    providerApiUrl:
      env.PROVIDER_API_URL || "https://api.zetatechs.com/v1/chat/completions",
    providerApiKey: env.PROVIDER_API_KEY || "",
    providerModel: env.PROVIDER_MODEL || "",
    providerJsonMode: asBoolean(env.PROVIDER_JSON_MODE),
    mockAnalysis: asBoolean(env.MOCK_ANALYSIS),
    allowInsecureLocal: asBoolean(env.ALLOW_INSECURE_LOCAL),
    bindAddress: env.BIND_ADDRESS || "",
  };
}

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function isLoopback(address = "") {
  return address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

function secureEqual(left = "", right = "") {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(request, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      const error = new Error("Image is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function unwrapContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && (item.type === "text" || typeof item.text === "string"))
    .map((item) => item.text || "")
    .join("\n");
}

function parseJsonText(text) {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(withoutFence.slice(start, end + 1));
    }
    throw new Error("Provider did not return a JSON analysis");
  }
}

function normalizedAnalysis(value) {
  return {
    title: String(value.title || "未命名截图").slice(0, 100),
    summary: String(value.summary || "未生成摘要。").slice(0, 1000),
    ocr: String(value.ocr || "").slice(0, 3000),
    tags: Array.isArray(value.tags)
      ? value.tags.map((tag) => String(tag).replace(/^#/, "").trim()).filter(Boolean).slice(0, 5)
      : [],
    next_action: String(value.next_action || "").slice(0, 500),
    sensitive: Boolean(value.sensitive),
    sensitive_reason: String(value.sensitive_reason || "").slice(0, 500),
  };
}

function formatNote(analysis, timestamp = new Date()) {
  const savedAt = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(timestamp);
  const tags = analysis.tags.length ? analysis.tags.map((tag) => `#${tag}`).join(" ") : "无";
  const lines = [
    analysis.title,
    "",
    `保存时间：${savedAt}`,
    "",
    "摘要",
    analysis.summary,
    "",
    "关键文字",
    analysis.ocr || "未识别到需要摘录的文字。",
    "",
    `标签：${tags}`,
  ];

  if (analysis.next_action) {
    lines.push("", "后续动作", analysis.next_action);
  }
  if (analysis.sensitive) {
    lines.push("", "隐私提醒", analysis.sensitive_reason || "截图可能含有敏感信息。");
  }
  return lines.join("\n");
}

async function requestProvider(image, mimeType, config) {
  const providerRequest = {
    model: config.providerModel,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: ANALYSIS_PROMPT },
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${image.toString("base64")}`,
            },
          },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 1000,
  };
  if (config.providerJsonMode) {
    providerRequest.response_format = { type: "json_object" };
  }

  const response = await fetch(config.providerApiUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.providerApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(providerRequest),
    signal: AbortSignal.timeout(45_000),
  });
  const rawText = await response.text();
  if (!response.ok) {
    const error = new Error(`Provider request failed (${response.status}): ${rawText.slice(0, 300)}`);
    error.status = 502;
    throw error;
  }

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    const error = new Error("Provider returned invalid JSON");
    error.status = 502;
    throw error;
  }
  const output = unwrapContent(payload.choices?.[0]?.message?.content);
  if (!output) {
    const error = new Error("Provider response has no message content");
    error.status = 502;
    throw error;
  }
  return normalizedAnalysis(parseJsonText(output));
}

function mockedAnalysis() {
  return {
    title: "本地测试截图",
    summary: "中转服务已收到一张截图。当前使用模拟分析，图片没有发送到第三方模型。",
    ocr: "MOCK_ANALYSIS=true",
    tags: ["测试", "截图收件箱"],
    next_action: "配置 Zeta 视觉模型后进行真实分析。",
    sensitive: false,
    sensitive_reason: "",
  };
}

async function handleCapture(request, response, config) {
  const permittedWithoutToken = config.allowInsecureLocal && isLoopback(request.socket.remoteAddress);
  if (!permittedWithoutToken) {
    if (!config.captureToken) {
      return json(response, 500, { error: "CAPTURE_TOKEN is not configured" });
    }
    if (!secureEqual(request.headers["x-capture-token"], config.captureToken)) {
      return json(response, 401, { error: "Invalid capture token" });
    }
  }

  const mimeType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(mimeType)) {
    return json(response, 415, { error: "Send a JPEG, PNG, or WEBP image file" });
  }

  const image = await readBody(request, config.maxImageBytes);
  if (!image.length) {
    return json(response, 400, { error: "Image body is empty" });
  }

  if (!config.mockAnalysis && (!config.providerApiKey || !config.providerModel)) {
    return json(response, 500, {
      error: "Set PROVIDER_API_KEY and PROVIDER_MODEL, or use MOCK_ANALYSIS=true",
    });
  }

  const analysis = config.mockAnalysis
    ? normalizedAnalysis(mockedAnalysis())
    : await requestProvider(image, mimeType, config);
  return json(response, 200, {
    ...analysis,
    note: formatNote(analysis),
  });
}

export function createRelayServer(configOverrides = {}) {
  const config = { ...readConfig(), ...configOverrides };
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://relay.local");
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, {
          ok: true,
          providerConfigured: Boolean(config.providerApiKey && config.providerModel),
          mockAnalysis: config.mockAnalysis,
        });
      }
      if (request.method === "POST" && url.pathname === "/capture") {
        return await handleCapture(request, response, config);
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      const status = Number(error.status) || 500;
      return json(response, status, { error: error.message || "Relay failed" });
    }
  });
}

function start() {
  const config = readConfig();
  const server = createRelayServer(config);
  const host = config.bindAddress || "127.0.0.1";
  server.listen(config.port, host, () => {
    const mode = config.mockAnalysis ? "mock analysis" : "provider analysis";
    console.log(`Screenshot relay listening at http://${host}:${config.port} (${mode})`);
  });
}

const entryPoint = process.argv[1] && pathToFileURL(process.argv[1]).href;
if (entryPoint === import.meta.url) {
  start();
}
