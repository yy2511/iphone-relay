import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRelayServer } from "../src/server.mjs";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("forwards an uploaded image to an OpenAI-compatible vision endpoint", async () => {
  let providerBody;
  const provider = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer provider-secret");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    providerBody = JSON.parse(raw);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "网页截图",
                summary: "这是待稍后阅读的文章。",
                ocr: "文章标题",
                tags: ["阅读", "资料"],
                next_action: "稍后阅读",
                sensitive: false,
                sensitive_reason: "",
              }),
            },
          },
        ],
      }),
    );
  });
  const providerUrl = await listen(provider);
  const relay = createRelayServer({
    captureToken: "phone-token",
    providerApiKey: "provider-secret",
    providerApiUrl: providerUrl,
    providerModel: "vision-model",
  });
  const relayUrl = await listen(relay);

  try {
    const response = await fetch(`${relayUrl}/capture`, {
      method: "POST",
      headers: {
        "content-type": "image/jpeg",
        "x-capture-token": "phone-token",
      },
      body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.title, "网页截图");
    assert.match(result.note, /#阅读 #资料/);
    assert.equal(providerBody.model, "vision-model");
    assert.match(
      providerBody.messages[0].content[1].image_url.url,
      /^data:image\/jpeg;base64,/,
    );
  } finally {
    await close(relay);
    await close(provider);
  }
});

test("supports a local mock mode without forwarding screenshots", async () => {
  const relay = createRelayServer({
    mockAnalysis: true,
    allowInsecureLocal: true,
  });
  const relayUrl = await listen(relay);
  try {
    const response = await fetch(`${relayUrl}/capture`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: Buffer.from("png"),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.title, "本地测试截图");
    assert.match(result.note, /图片没有发送到第三方模型/);
  } finally {
    await close(relay);
  }
});

test("rejects missing phone token before provider invocation", async () => {
  const relay = createRelayServer({
    captureToken: "phone-token",
    providerApiKey: "provider-secret",
    providerModel: "vision-model",
  });
  const relayUrl = await listen(relay);
  try {
    const response = await fetch(`${relayUrl}/capture`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: Buffer.from("png"),
    });
    assert.equal(response.status, 401);
  } finally {
    await close(relay);
  }
});
