import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";

const env = {
  ACCESS_CODE: "test-access",
  ANTHROPIC_API_KEY: "test-anthropic",
  TYPESAFE_API_KEY: "test-typesafe",
  ALLOWED_ORIGINS: "https://amarows.github.io,http://localhost:8000",
};
let ipCounter = 0;

function request(path, body, options = {}) {
  return new Request(`https://worker.test${path}`, {
    method: options.method || "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.auth === false ? {} : { "x-access-code": env.ACCESS_CODE }),
      "cf-connecting-ip": options.ip || `192.0.2.${++ipCounter}`,
      ...(options.origin ? { origin: options.origin } : {}),
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const typesafe = () => new Response(JSON.stringify({
  model: "jev-latest",
  answers: {
    time_to_prototype: { probabilities: { "0": 0.1, "1": 0.2, "2": 0.4, "3": 0.2, "4": 0.1 } },
    mvp_success: { noul: 0.7 }, evidence_fit: { score: 3 }, needs_specialist: { noul: 0.2 }, main_risk: { choice: "domain" },
  },
  usage: { input_tokens: 1, output_tokens: 1 },
}), { status: 200, headers: { "x-typesafe-request-id": "typesafe-123" } });

const claude = (stop_reason = "end_turn") => new Response(JSON.stringify({
  id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5",
  content: [{ type: "text", text: "Plan response" }, { type: "thinking", thinking: "hidden" }],
  stop_reason, usage: { input_tokens: 1, output_tokens: 1 },
}), { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } });

afterEach(() => vi.restoreAllMocks());

describe("worker routes", () => {
  it("handles allowed and denied OPTIONS preflight", async () => {
    const allowed = await worker.fetch(request("/api/jev", undefined, { method: "OPTIONS", origin: "https://amarows.github.io" }), env);
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-methods")).toBe("POST, GET, OPTIONS");
    expect(allowed.headers.get("access-control-allow-headers")).toBe("content-type, x-access-code");
    const denied = await worker.fetch(request("/api/jev", undefined, { method: "OPTIONS", origin: "https://bad.example" }), env);
    expect(denied.status).toBe(403);
  });

  it("rejects missing access code and oversized request", async () => {
    const missing = await worker.fetch(request("/api/claude", { role: "leva", task: "ask", question: "hi" }, { auth: false }), env);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "access_code" });
    const large = await worker.fetch(request("/api/jev", "x".repeat(16 * 1024 + 1)), env);
    expect(large.status).toBe(413);
  });

  it("builds Jev request and returns derived values", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(typesafe());
    const response = await worker.fetch(request("/api/jev", { role: "leva", project: { title: "Voting", brief: "Digital votes" }, sliders: { reg: 1 } }), env);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.derived.p_mvp).toBe(0.7);
    expect(result.request_id).toBe("typesafe-123");
    expect(result.state.project.title).toBe("Voting");
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.headers.authorization).toBe("Bearer test-typesafe");
    const outgoing = JSON.parse(init.body);
    expect(outgoing).toHaveProperty("model");
    expect(outgoing.state.project.title).toBe("Voting");
    expect(outgoing).toHaveProperty("questions");
  });

  it("retries three upstream 500 responses then returns 502", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("private upstream text", { status: 500 }));
    const response = await worker.fetch(request("/api/jev", { role: "leva", project: { title: "x", brief: "y" }, sliders: {} }), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "jev_unavailable", message: "Jev is temporarily unavailable." });
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("sends Claude plan options and redacts profile tags", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(claude());
    const response = await worker.fetch(request("/api/claude", { role: "leva", task: "plan", project: { title: "Voting", brief: "Digital votes" }, sliders: {} }), env);
    expect(response.status).toBe(200);
    expect((await response.json()).text).toBe("Plan response");
    const init = mock.mock.calls[0][1];
    const outgoing = JSON.parse(init.body);
    expect(outgoing.fallbacks).toBe("default");
    expect(init.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(outgoing.thinking.type).toBe("adaptive");
    expect(outgoing.system[1].text).not.toContain('"tags"');
  });

  it("maps Claude refusal and rejects invalid draft kind", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(claude("refusal"));
    const refusal = await worker.fetch(request("/api/claude", { role: "leva", task: "ask", question: "Why?" }), env);
    expect(refusal.status).toBe(200);
    expect((await refusal.json()).error).toBe("declined");
    const bad = await worker.fetch(request("/api/claude", { role: "leva", task: "draft", kind: "salary", project: {} }), env);
    expect(bad.status).toBe(400);
  });

  it("rate limits the 21st POST from one IP", async () => {
    const ip = `198.51.100.${++ipCounter}`;
    const responses = [];
    for (let i = 0; i < 21; i += 1) {
      responses.push(await worker.fetch(request("/api/claude", { role: "leva", task: "invalid" }, { ip }), env));
    }
    expect(responses.slice(0, 20).every((response) => response.status === 400)).toBe(true);
    expect(responses[20].status).toBe(429);
    expect(responses[20].headers.has("retry-after")).toBe(true);
  });
});
