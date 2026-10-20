import Anthropic from "@anthropic-ai/sdk";
import profile from "../../docs/content/profile.json";
import leva from "../../docs/content/roles/leva.json";
import { buildJevState, deriveJev, describeSliders } from "../../docs/js/matcher.js";
import {
  CLAUDE_EFFORT, CLAUDE_MAX_TOKENS, CLAUDE_MODEL, JEV_MODEL, JEV_QUESTIONS,
  JEV_QUESTIONS_VERSION, OPERATING_ASSUMPTION, PROTOTYPE_WEEKS, SYSTEM_BASE, TASKS,
} from "./prompts.js";

const ROLES = { leva };
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 20;
const requestCounts = new Map();
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", ...headers },
});

function allowedOrigins(env) {
  return new Set(String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean));
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins(env).has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type, x-access-code",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}

function constantTimeEqual(a, b) {
  if (typeof b !== "string" || b.length === 0) return false;
  const encoder = new TextEncoder();
  const left = encoder.encode(String(a ?? ""));
  const right = encoder.encode(String(b ?? ""));
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) diff |= (left[i % (left.length || 1)] || 0) ^ (right[i % (right.length || 1)] || 0);
  return diff === 0;
}

function rateLimit(ip, now) {
  const entries = (requestCounts.get(ip) || []).filter((time) => now - time < RATE_WINDOW_MS);
  if (entries.length >= RATE_LIMIT) {
    requestCounts.set(ip, entries);
    return Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - entries[0])) / 1000));
  }
  entries.push(now);
  requestCounts.set(ip, entries);
  return 0;
}

function publicProfile() {
  const { dimensions, cases, ...rest } = profile;
  return { ...rest, cases: cases.map(({ tags, ...item }) => item) };
}

async function parseJson(request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 16 * 1024) return { error: 413 };
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 16 * 1024) return { error: 413 };
  try { return { body: JSON.parse(text) }; } catch { return { error: 400 }; }
}

function viewerText(body, task) {
  const fields = task === "plan" ? [body.project?.title, body.project?.brief]
    : task === "ask" ? [body.question]
      : task === "crossexam" ? [body.project?.title, body.project?.brief]
        : [body.project?.title, body.project?.brief, body.notes];
  return fields.map((value) => typeof value === "string" ? value.trim() : "").join("\n");
}

function cleanString(value) { return typeof value === "string" ? value.trim() : ""; }

function jevSummary(derived, role) {
  const band = Number.isInteger(derived?.likely_band) ? JEV_QUESTIONS.time_to_prototype.criteria[derived.likely_band] : "unknown";
  const pct = (value) => Number.isFinite(value) ? `${Math.round(value * 100)}%` : "unknown";
  return [
    `P(MVP): ${pct(derived?.p_mvp)}`,
    `Expected weeks: ${Number.isFinite(derived?.expected_weeks) ? derived.expected_weeks : "unknown"}`,
    `Likely prototype band: ${band}`,
    `Evidence fit level: ${derived?.fit_level ?? "unknown"}`,
    `Main risk: ${derived?.main_risk ?? "unknown"}`,
    `P(needs specialist): ${pct(derived?.p_specialist)}`,
    `Role: ${role.role} at ${role.company}`,
  ].join("\n");
}

async function fetchJev(state, env) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: JEV_MODEL, state, questions: JEV_QUESTIONS }),
        signal: controller.signal,
      });
      if (RETRY_STATUSES.has(response.status) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
        continue;
      }
      if (!response.ok) return null;
      return { data: await response.json(), requestId: response.headers.get("x-typesafe-request-id") };
    } catch {
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
        continue;
      }
      return null;
    } finally { clearTimeout(timer); }
  }
  return null;
}

async function handleJev(body, env) {
  if (!ROLES[body.role]) return json({ error: "unknown_role", message: "That role is not available." }, 404);
  const state = buildJevState(profile, ROLES[body.role], body.project, body.sliders, OPERATING_ASSUMPTION);
  const result = await fetchJev(state, env);
  if (!result) return json({ error: "jev_unavailable", message: "Jev is temporarily unavailable." }, 502);
  const answers = result.data.answers ?? {};
  return json({
    model: result.data.model ?? JEV_MODEL,
    questions_version: JEV_QUESTIONS_VERSION,
    request_id: result.requestId,
    answers,
    derived: deriveJev(answers, PROTOTYPE_WEEKS),
    evidence: state.evidence.map((item) => item.title),
    gaps: state.known_gaps.map((item) => item.title),
    state,
    questions: JEV_QUESTIONS,
    usage: result.data.usage ?? null,
  });
}

async function handleClaude(body, env) {
  if (!ROLES[body.role]) return json({ error: "unknown_role", message: "That role is not available." }, 404);
  const task = body.task;
  if (!Object.hasOwn(TASKS, task)) return json({ error: "invalid_task", message: "That task is not available." }, 400);
  if (task === "draft" && !["invite", "references", "offer"].includes(body.kind)) {
    return json({ error: "invalid_kind", message: "That draft kind is not available." }, 400);
  }
  const viewer = viewerText(body, task);
  if (viewer.length > TASKS[task].maxInput) return json({ error: "input_too_large", message: "The supplied text is too long." }, 413);
  const role = ROLES[body.role];
  const project = body.project || {};
  const sliders = body.sliders || {};
  const params = {
    title: cleanString(project.title), brief: cleanString(project.brief),
    characteristicsText: describeSliders(profile, sliders),
    question: cleanString(body.question), kind: body.kind,
    notes: cleanString(body.notes),
  };
  if (task === "crossexam") params.jevSummary = jevSummary(body.jev, role);
  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 2 });
    const msg = await client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: CLAUDE_EFFORT },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [
        { type: "text", text: SYSTEM_BASE },
        { type: "text", text: "CONTEXT:\n" + JSON.stringify({ profile: publicProfile(), role }), cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: TASKS[task].prompt(params) }],
    });
    if (msg.stop_reason === "refusal") return json({ error: "declined", message: "The model declined this request." });
    return json({ text: (msg.content || []).filter((block) => block.type === "text").map((block) => block.text).join(""), model: msg.model, usage: msg.usage, stop_reason: msg.stop_reason });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) return json({ error: "rate_limited", message: "Claude is temporarily rate limited." }, 429);
    if (error instanceof Anthropic.APIError) return json({ error: "claude_unavailable", message: "Claude is temporarily unavailable." }, 502);
    return json({ error: "claude_unavailable", message: "Claude is temporarily unavailable." }, 502);
  }
}

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    const origin = request.headers.get("Origin");
    if (origin && !allowedOrigins(env).has(origin)) return json({ error: "origin_denied", message: "This origin is not allowed." }, 403);
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }
  if (url.pathname === "/api/health" && request.method === "GET") return json({ ok: true, questions_version: JEV_QUESTIONS_VERSION });
  if (request.method !== "POST" || !["/api/jev", "/api/claude"].includes(url.pathname)) return json({ error: "not_found", message: "Route not found." }, 404);
  const origin = request.headers.get("Origin");
  if (origin && !allowedOrigins(env).has(origin)) return json({ error: "origin_denied", message: "This origin is not allowed." }, 403);
  if (!constantTimeEqual(request.headers.get("x-access-code"), env.ACCESS_CODE)) return json({ error: "access_code" }, 401);
  const retryAfter = rateLimit(request.headers.get("cf-connecting-ip") || "unknown", Date.now());
  if (retryAfter) return json({ error: "rate_limited", message: "Too many requests. Try again later." }, 429, { "retry-after": String(retryAfter) });
  const parsed = await parseJson(request);
  if (parsed.error === 413) return json({ error: "body_too_large", message: "The request body exceeds 16 KB." }, 413);
  if (parsed.error) return json({ error: "invalid_json", message: "The request body must be valid JSON." }, 400);
  return url.pathname === "/api/jev" ? handleJev(parsed.body, env) : handleClaude(parsed.body, env);
}

export default {
  async fetch(request, env) {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    let response;
    let model = null;
    let inputTokens = null;
    let outputTokens = null;
    try {
      response = await route(request, env);
      if (response.status === 200 && ["/api/jev", "/api/claude"].includes(url.pathname)) {
        const result = await response.clone().json().catch(() => ({}));
        model = result.model ?? null;
        inputTokens = result.usage?.input_tokens ?? null;
        outputTokens = result.usage?.output_tokens ?? null;
      }
    } catch {
      response = json({ error: "internal_error", message: "The request could not be completed." }, 500);
    }
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders(request, env))) headers.set(key, value);
    const logged = { route: url.pathname, status: response.status, latency_ms: Date.now() - started, model, input_tokens: inputTokens, output_tokens: outputTokens, request_id: requestId };
    console.log(JSON.stringify(logged));
    return new Response(response.body, { status: response.status, headers });
  },
};
