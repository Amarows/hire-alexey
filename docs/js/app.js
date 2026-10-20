import { DIMS, clampSliders, pickEvidence, activeGaps } from "./matcher.js?v=5";
import { WORKER_URL } from "./config.js?v=5";

const ROLE_ID = document.documentElement.dataset.role || "leva";
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
};
const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* storage blocked: memory only */ } },
};

// Must match JEV_QUESTIONS_VERSION and time_to_prototype.criteria in worker/src/prompts.js.
const QUESTIONS_VERSION = "2026-10-20.3";
const BANDS = ["≤ 2 days", "≤ 1 week", "2–3 weeks", "1–2 months", "longer"];
const RISK_LABELS = {
  domain: "domain knowledge", regulatory: "regulatory approval", stakeholders: "aligning stakeholders",
  build: "the build itself", scope: "unclear scope", none: "none stands out",
};
const SUGGESTED = [
  "What has he built that is closest to LEVA's product?",
  "How does he use AI coding tools day to day?",
  "What would his first month at LEVA look like?",
];

let profile, role, precomputed = null;
let state = { preset: null, sliders: {}, title: "", brief: "" };
let lastAssessment = null;
let accessCode = store.get("ha_code") || "";
let task = "ask";

async function loadJSON(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

async function init() {
  [profile, role] = await Promise.all([loadJSON("../content/profile.json"), loadJSON(`../content/roles/${ROLE_ID}.json`)]);
  try { precomputed = await loadJSON(`../content/precomputed/${ROLE_ID}.json`); } catch { precomputed = null; }
  if (precomputed && precomputed.questions_version !== QUESTIONS_VERSION) precomputed = null; // stale: different questions
  renderHero();
  renderSliders();
  renderPresets();
  renderFit();
  renderRecord();
  renderStats();
  $("email").textContent = profile.contact.email;
  $("linkedin").href = profile.contact.linkedin;
  $("postingLink").href = role.role_context.posting_url;
  wireAccess();
  wireAsk();
  $("assessRun").addEventListener("click", runAssessment);
  applyPreset(role.presets[0].id);
}

// ---------- access code ----------
function setAccess(code, msg) {
  accessCode = code; store.set("ha_code", code);
  const s = $("accessState");
  s.textContent = msg || (code ? "Live AI unlocked." : "Saved results work without a code.");
  s.classList.toggle("ok", !!code && !msg);
}

// Flash the access bar when a live-AI button is used without a code.
function needCode() {
  if (accessCode) return false;
  const bar = $("accessForm");
  bar.classList.remove("nudge"); void bar.offsetWidth; bar.classList.add("nudge");
  $("accessState").textContent = "Enter the access code to use live AI.";
  $("accessCode").focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  return true;
}

function wireAccess() {
  if (accessCode) setAccess(accessCode);
  $("accessForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("accessCode").value.trim();
    $("accessCode").value = "";
    $("accessForm").classList.remove("nudge");
    setAccess(v);
  });
}

// ---------- hero ----------
function renderHero() {
  $("question").textContent = role.question;
  role.answer.forEach((line, i) => $("answer").append(el("li", {}, el("span", { text: String(i + 1).padStart(2, "0") }), line)));
  ["14+ years in quantitative finance", "Ex-UBS Director, Group Risk Control", profile.credentials, profile.permit, profile.location]
    .forEach((f) => $("facts").append(el("span", { class: "chip", text: f })));
}

// ---------- simulator ----------
function renderPresets() {
  for (const p of role.presets) {
    const b = el("button", { class: "preset", type: "button", "aria-pressed": "false", "data-id": p.id, title: p.why }, p.title);
    b.addEventListener("click", () => applyPreset(p.id));
    $("presets").append(b);
  }
  const custom = el("button", { class: "preset", type: "button", "aria-pressed": "false", "data-id": "custom" }, "Your own project");
  custom.addEventListener("click", () => {
    state.preset = null;
    $("projTitle").value = "Your project"; $("projBrief").value = "";
    document.querySelector("details.proj").open = true;
    syncFromInputs(); markPreset(); $("projTitle").focus();
  });
  $("presets").append(custom);
  for (const id of ["projTitle", "projBrief"]) $(id).addEventListener("input", () => { state.preset = null; syncFromInputs(); markPreset(); });
}

function renderSliders() {
  for (const d of DIMS) {
    const meta = profile.dimensions[d];
    const input = el("input", { type: "range", min: "0", max: "100", step: "5", id: `s_${d}` });
    input.addEventListener("input", () => { state.preset = null; syncFromInputs(); markPreset(); });
    $("sliders").append(el("div", { class: "slider" },
      el("div", { class: "row" }, el("label", { for: `s_${d}` }, el("b", { text: meta.label })), el("span", { class: "num", id: `v_${d}` })),
      input,
      el("div", { class: "ends" }, el("span", { text: meta.left }), el("span", { text: meta.right }))));
  }
}

function applyPreset(id) {
  const p = role.presets.find((x) => x.id === id);
  if (!p) return;
  state.preset = id;
  $("projTitle").value = p.title; $("projBrief").value = p.brief;
  for (const d of DIMS) $(`s_${d}`).value = p.sliders[d];
  syncFromInputs(); markPreset();
}

function markPreset() {
  for (const b of $("presets").children) b.setAttribute("aria-pressed", String(b.dataset.id === (state.preset || "custom")));
}

const projectKey = () => JSON.stringify([state.title, state.brief, state.sliders]);

function syncFromInputs() {
  const raw = {};
  for (const d of DIMS) raw[d] = Number($(`s_${d}`).value);
  state.sliders = clampSliders(raw);
  state.title = $("projTitle").value.trim() || "Untitled project";
  state.brief = $("projBrief").value.trim();
  for (const d of DIMS) $(`v_${d}`).textContent = state.sliders[d];
  renderRamp(); renderEvidence();
  const saved = state.preset && precomputed?.presets?.[state.preset];
  if (saved) showAssessment(saved, "saved");
  else if (lastAssessment?.key !== projectKey()) { lastAssessment = null; showEmpty("Press Assess this project for a live assessment."); }
}

function renderRamp() {
  const box = $("ramp"); box.replaceChildren();
  const gaps = activeGaps(profile, state.sliders);
  if (!gaps.length) { box.append(el("p", { class: "none", text: "Nothing stands out for this project." })); return; }
  for (const g of gaps) box.append(el("details", {}, el("summary", { text: g.title }),
    el("p", { text: g.detail }), g.mitigation ? el("p", {}, el("strong", { text: "Mitigation: " }), g.mitigation) : null));
}

function renderEvidence() {
  const box = $("evidence"); box.replaceChildren();
  const curated = role.presets.find((p) => p.id === state.preset)?.evidence || [];
  for (const { case: c, score } of pickEvidence(profile, state.sliders, 3, curated))
    box.append(el("li", {}, el("a", { href: `#case-${c.id}`, text: c.title }),
      el("span", { class: "num", text: score == null ? "selected for this project" : `match ${Math.round(score * 100)}%` })));
}

// ---------- assessment ----------
function showEmpty(msg) {
  $("assessBody").replaceChildren(el("p", { class: "none", text: msg }));
  $("asked").hidden = true;
}

function fmtTime(weeks) {
  if (weeks == null) return "–";
  const days = Math.round(weeks * 7);
  return weeks < 2 ? `≈ ${days} day${days === 1 ? "" : "s"}` : `≈ ${Math.round(weeks)} wk`;
}

function showAssessment(res, source) {
  const d = res.derived || {};
  lastAssessment = { key: projectKey(), derived: d };
  const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
  const band = d.likely_band != null ? BANDS[d.likely_band] : "–";
  const max = Math.max(...(d.weeks_dist || [0]), 0.0001);
  const bars = el("div", { class: "bars", role: "img", "aria-label": `Time to a clickable prototype, most likely ${band}` });
  (d.weeks_dist || [0, 0, 0, 0, 0]).forEach((p, i) =>
    bars.append(el("div", { class: `bar${i === d.likely_band ? " top" : ""}`, style: `height:${Math.max(2, (p / max) * 100)}%`, title: `${BANDS[i]}: ${pct(p)}` })));
  const labels = el("div", { class: "barlabels" }); BANDS.forEach((b) => labels.append(el("span", { text: b })));
  const when = precomputed?.generated_utc;
  $("assessBody").replaceChildren(
    el("p", { class: "src", text: source === "saved" ? `Saved result${when ? `, ${when.slice(0, 10)}` : ""}` : "Live result" }),
    el("div", { class: "metrics" },
      metric(fmtTime(d.expected_weeks), `to a clickable prototype (most likely ${band})`),
      metric(pct(d.p_mvp), "chance of a usable MVP within 3 months")),
    bars, labels,
    el("p", { class: "riskline" }, el("b", { text: "Main risk: " }), d.main_risk ? RISK_LABELS[d.main_risk] || d.main_risk : "–"));
  if (res.state && res.questions) {
    $("askedPre").textContent = JSON.stringify({ state: res.state, questions: res.questions }, null, 2);
    $("asked").hidden = false;
  } else $("asked").hidden = true;
}

const metric = (v, l) => el("div", { class: "metric" }, el("div", { class: "v", text: v }), el("div", { class: "l", text: l }));

async function runAssessment() {
  if (needCode()) return;
  const btn = $("assessRun"); btn.disabled = true;
  $("assessBody").replaceChildren(el("p", { class: "busy", text: "Assessing…" }));
  try {
    showAssessment(await api("/api/jev", { role: ROLE_ID, preset: state.preset, project: { title: state.title, brief: state.brief }, sliders: state.sliders }), "live");
  } catch (e) { $("assessBody").replaceChildren(el("p", { class: "err", text: e.message })); }
  finally { btn.disabled = false; }
}

async function api(path, body) {
  let r;
  try {
    r = await fetch(WORKER_URL + path, { method: "POST", headers: { "content-type": "application/json", "x-access-code": accessCode }, body: JSON.stringify(body) });
  } catch { throw new Error("The AI service could not be reached. Check your connection and try again."); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { setAccess(""); needCode(); throw new Error("The access code was not accepted. Re-enter it at the top."); }
  if (r.status === 429) throw new Error("Too many requests from this connection. Wait a few minutes and try again.");
  if (!r.ok || data.error) throw new Error(data.message || `The AI service returned an error (${r.status}).`);
  return data;
}

// ---------- ask ----------
const TASKS = {
  plan: { button: "Write the 30/60/90 plan", hint: "A plan for the project currently set in the simulator." },
  crossexam: { button: "Challenge the assessment", hint: "Argues both ways on the current assessment and suggests an interview question." },
};

function wireAsk() {
  for (const q of SUGGESTED) {
    const b = el("button", { class: "chip", type: "button", text: q });
    b.addEventListener("click", () => { $("askText").value = q; runClaude("ask"); });
    $("suggest").append(b);
  }
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    task = t.dataset.task;
    document.querySelectorAll(".tab").forEach((x) => x.setAttribute("aria-selected", String(x === t)));
    $("askUi").hidden = task !== "ask";
    $("taskUi").hidden = task === "ask";
    if (task !== "ask") { $("taskRun").textContent = TASKS[task].button; $("taskHint").textContent = TASKS[task].hint; }
  }));
  $("askRun").addEventListener("click", () => runClaude("ask"));
  $("askText").addEventListener("keydown", (e) => { if (e.key === "Enter") runClaude("ask"); });
  $("taskRun").addEventListener("click", () => runClaude(task));
}

async function runClaude(which) {
  if (needCode()) return;
  const out = $("out"); out.hidden = false;
  const project = { title: state.title, brief: state.brief };
  let body;
  if (which === "ask") {
    const q = $("askText").value.trim();
    if (!q) { $("askText").focus(); out.hidden = true; return; }
    body = { role: ROLE_ID, task: "ask", question: q };
  } else if (which === "plan") body = { role: ROLE_ID, task: "plan", project, sliders: state.sliders };
  else {
    if (!lastAssessment) { out.replaceChildren(el("p", { class: "none", text: "Assess the current project first, or pick a project with a saved result." })); return; }
    body = { role: ROLE_ID, task: "crossexam", project, sliders: state.sliders, jev: lastAssessment.derived };
  }
  const buttons = [$("askRun"), $("taskRun")]; buttons.forEach((b) => { b.disabled = true; });
  out.replaceChildren(el("p", { class: "busy", text: "Claude is writing… up to a minute." }));
  try { renderMarkdown(out, (await api("/api/claude", body)).text); }
  catch (e) { out.replaceChildren(el("p", { class: "err", text: e.message })); }
  finally { buttons.forEach((b) => { b.disabled = false; }); }
}

// Minimal, safe markdown: headings, lists, bold, [case-id] links. Text nodes only.
function renderMarkdown(target, md) {
  target.replaceChildren();
  const ids = new Set(profile.cases.map((c) => c.id));
  const inline = (line) => {
    const frag = document.createDocumentFragment();
    for (const part of line.split(/(\*\*[^*]+\*\*|\[[a-z0-9-]+\])/g)) {
      if (!part) continue;
      const bold = part.match(/^\*\*([^*]+)\*\*$/);
      const cite = part.match(/^\[([a-z0-9-]+)\]$/);
      if (bold) frag.append(el("strong", { text: bold[1] }));
      else if (cite && ids.has(cite[1])) frag.append(el("a", { class: "cite", href: `#case-${cite[1]}`, text: cite[1] }));
      else frag.append(part);
    }
    return frag;
  };
  let list = null;
  for (const raw of String(md || "").split("\n")) {
    const line = raw.trimEnd();
    const h = line.match(/^#{1,4}\s+(.*)/), ul = line.match(/^\s*[-*]\s+(.*)/), ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ul || ol) {
      const tag = ul ? "UL" : "OL";
      if (!list || list.tagName !== tag) { list = el(tag.toLowerCase()); target.append(list); }
      list.append(el("li", {}, inline((ul || ol)[1])));
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    target.append(h ? el("h4", {}, inline(h[1])) : el("p", {}, inline(line)));
  }
}

// ---------- fit, record, stats ----------
function caseLink(id) {
  const c = profile.cases.find((x) => x.id === id);
  return el("a", { href: `#case-${id}`, text: c ? c.title.split(",")[0] : id });
}

function renderFit() {
  const cols = [["strong", "Strong"], ["medium", "Partial"], ["gap", "To build"]];
  for (const [key, label] of cols) {
    const items = role.fit.filter((f) => f.strength === key);
    if (!items.length) continue;
    const col = el("div", { class: `col ${key}` }, el("h3", {}, el("span", { class: "dot" }), `${label} (${items.length})`));
    for (const f of items) {
      const links = el("div", { class: "links" }); f.cases.forEach((id) => links.append(caseLink(id)));
      col.append(el("div", { class: "box" }, el("b", { text: f.label }), el("p", { text: f.note }), f.cases.length ? links : null));
    }
    $("fitCols").append(col);
  }
}

function renderRecord() {
  for (const [gid, gname] of Object.entries(profile.groups)) {
    const col = el("div", { class: "col" }, el("h3", { text: gname }));
    for (const c of profile.cases.filter((x) => x.group === gid)) {
      const ul = el("ul"); c.points.forEach((p) => ul.append(el("li", { text: p })));
      col.append(el("details", { class: "case", id: `case-${c.id}` },
        el("summary", {}, el("b", { text: c.title }), el("span", { text: `${c.period} · ${c.kind}` })),
        el("div", { class: "body" }, el("p", { text: c.headline }), ul)));
    }
    $("groups").append(col);
  }
  // Opening a case from a link (evidence, fit map, Claude citation) expands it.
  const openTarget = () => { const t = location.hash && document.querySelector(location.hash); if (t?.tagName === "DETAILS") t.open = true; };
  addEventListener("hashchange", openTarget); openTarget();
}

function renderStats() {
  for (const s of role.build_stats || []) $("stats").append(el("div", { class: "stat" }, el("div", { class: "v", text: s.v }), el("div", { class: "l", text: s.l })));
}

init().catch((e) => {
  document.querySelector("main").prepend(el("p", { class: "wrap err", text: `The page could not load its content: ${e.message}` }));
});
