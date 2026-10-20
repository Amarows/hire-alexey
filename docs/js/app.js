import { DIMS, clampSliders, matchCases, activeGaps } from "./matcher.js";
import { WORKER_URL } from "./config.js";

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
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* storage blocked: keep in memory only */ } },
};

const BANDS = ["≤ 2 wk", "2–4 wk", "1–2 mo", "2–4 mo", "> 4 mo"];
const FIT_LEVELS = ["none", "adjacent", "partial", "strong", "direct"];
const RISK_LABELS = {
  domain: "missing domain knowledge", regulatory: "regulator or licence approval",
  stakeholders: "aligning legal, compliance, customers and engineering", build: "the technical build",
  scope: "unclear scope", none: "no material risk",
};

let profile, role, precomputed = null;
let state = { preset: null, sliders: {}, title: "", brief: "" };
let lastJev = null;            // {derived, ...} for the current project, or null
let accessCode = store.get("ha_code") || "";
let task = "plan";
let draftKind = "invite";

// ---------- data ----------
async function loadJSON(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

async function init() {
  [profile, role] = await Promise.all([
    loadJSON("../content/profile.json"),
    loadJSON(`../content/roles/${ROLE_ID}.json`),
  ]);
  try { precomputed = await loadJSON(`../content/precomputed/${ROLE_ID}.json`); } catch { precomputed = null; }

  renderHero();
  renderSliders();
  renderPresets();
  renderFit();
  renderRecord();
  renderContact();
  wireAccess();
  wireClaude();
  wireDraft();
  $("jevRun").addEventListener("click", runJev);
  applyPreset(role.presets[0].id);
}

// ---------- hero ----------
function renderHero() {
  $("question").textContent = role.question;
  role.answer.forEach((line, i) => $("answer").append(el("li", {}, el("span", { text: String(i + 1).padStart(2, "0") }), line)));
  const facts = [
    "14+ years in quantitative finance", "UBS Director, Group Risk Control", profile.credentials,
    profile.permit, profile.location, profile.languages.map((l) => `${l.lang} ${l.level.split(" ")[0]}`).join(" · "),
  ];
  facts.forEach((f) => $("facts").append(el("span", { class: "chip", text: f })));
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
    syncFromInputs(); markPreset();
    $("projBrief").focus();
  });
  $("presets").append(custom);
  for (const id of ["projTitle", "projBrief"]) $(id).addEventListener("input", () => { state.preset = null; syncFromInputs(); markPreset(); });
}

function renderSliders() {
  for (const d of DIMS) {
    const meta = profile.dimensions[d];
    const input = el("input", { type: "range", min: "0", max: "100", step: "5", id: `s_${d}`, "aria-describedby": `e_${d}` });
    input.addEventListener("input", () => { state.preset = null; syncFromInputs(); markPreset(); });
    $("sliders").append(el("div", { class: "slider" },
      el("div", { class: "row" }, el("label", { for: `s_${d}` }, el("b", { text: meta.label })), el("span", { class: "num", id: `v_${d}` })),
      input,
      el("div", { class: "ends", id: `e_${d}` }, el("span", { text: meta.left }), el("span", { text: meta.right })),
    ));
  }
}

function applyPreset(id) {
  const p = role.presets.find((x) => x.id === id);
  if (!p) return;
  state.preset = id;
  $("projTitle").value = p.title;
  $("projBrief").value = p.brief;
  for (const d of DIMS) $(`s_${d}`).value = p.sliders[d];
  syncFromInputs();
  markPreset();
}

function markPreset() {
  for (const b of $("presets").children) b.setAttribute("aria-pressed", String(b.dataset.id === (state.preset || "custom")));
}

function syncFromInputs() {
  const raw = {};
  for (const d of DIMS) raw[d] = Number($(`s_${d}`).value);
  state.sliders = clampSliders(raw);
  state.title = $("projTitle").value.trim() || "Untitled project";
  state.brief = $("projBrief").value.trim();
  for (const d of DIMS) $(`v_${d}`).textContent = state.sliders[d];
  renderEvidence();
  renderGaps();
  const saved = state.preset && precomputed?.presets?.[state.preset];
  if (saved) showJev(saved, "saved");
  else if (lastJev?.key !== projectKey()) { lastJev = null; showJevEmpty(); }
}

const projectKey = () => JSON.stringify([state.title, state.brief, state.sliders]);

function caseCard(c, score) {
  return el("article", { class: "case" },
    el("div", { class: "meta" },
      el("span", { class: "kind", text: c.kind }), el("span", { text: c.period }),
      score != null ? el("span", { class: "match", text: `match ${Math.round(score * 100)}%` }) : null),
    el("h3", {}, el("a", { href: `#case-${c.id}`, text: c.title })),
    el("p", { text: c.headline }));
}

function renderEvidence() {
  const box = $("evidence"); box.replaceChildren();
  for (const { case: c, score } of matchCases(profile, state.sliders, 3)) box.append(caseCard(c, score));
}

function renderGaps() {
  const box = $("gaps"); box.replaceChildren();
  const gaps = activeGaps(profile, state.sliders);
  if (!gaps.length) { box.append(el("p", { class: "none", text: "No ramp-up area stands out for this project." })); return; }
  for (const g of gaps) box.append(el("div", { class: "gapi" }, el("b", { text: g.title }), el("br"), g.detail,
    g.mitigation ? el("span", { class: "mit" }, el("strong", { text: "Mitigation: " }), g.mitigation) : null));
}

// ---------- Jev ----------
function showJevEmpty(msg) {
  $("jevBody").replaceChildren(el("p", { class: "none", text: msg || "Press Assess to get a delivery assessment for this project." }));
  $("jevAsked").hidden = true;
}

function showJev(res, source) {
  const d = res.derived || {};
  lastJev = { key: projectKey(), derived: d };
  const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
  const band = d.likely_band != null ? BANDS[d.likely_band] : "–";
  const fit = d.fit_level != null ? FIT_LEVELS[Math.round(d.fit_level)] : "–";
  const max = Math.max(...(d.weeks_dist || [0]), 0.0001);
  const bars = el("div", { class: "bars", role: "img", "aria-label": `Time to first prototype, most likely ${band}` });
  (d.weeks_dist || [0, 0, 0, 0, 0]).forEach((p, i) =>
    bars.append(el("div", { class: `bar${i === d.likely_band ? " top" : ""}`, style: `height:${Math.max(2, (p / max) * 100)}%`, title: `${BANDS[i]}: ${pct(p)}` })));
  const labels = el("div", { class: "barlabels" }); BANDS.forEach((b) => labels.append(el("span", { text: b })));
  const when = res.generated_utc || precomputed?.generated_utc;
  $("jevBody").replaceChildren(
    el("p", { class: "jevhead src", text: source === "saved"
      ? `Saved result for this preset${when ? `, ${when.slice(0, 10)}` : ""}`
      : "Live result" }),
    el("div", { class: "metrics" },
      metric(pct(d.p_mvp), "chance of a usable MVP within six months"),
      metric(d.expected_weeks != null ? `${d.expected_weeks} wk` : "–", `expected time to first prototype (most likely ${band})`),
      metric(fit, "how closely the evidence fits"),
    ),
    bars, labels,
    el("p", { class: "riskline" },
      el("b", { text: "Main risk: " }), d.main_risk ? RISK_LABELS[d.main_risk] || d.main_risk : "–",
      ` · Needs a specialist he can't borrow from LEVA's staff: ${pct(d.p_specialist)}`),
  );
  if (res.state && res.questions) {
    $("jevAskedPre").textContent = JSON.stringify({ state: res.state, questions: res.questions }, null, 2);
    $("jevAsked").hidden = false;
  } else $("jevAsked").hidden = true;
}

const metric = (v, l) => el("div", { class: "metric" }, el("div", { class: "v", text: v }), el("div", { class: "l", text: l }));

async function runJev() {
  if (!accessCode) { showJevEmpty("Enter the access code at the top of the page to run a live assessment. Presets show saved results without it."); return; }
  const btn = $("jevRun"); btn.disabled = true;
  $("jevBody").replaceChildren(el("p", { class: "busy", text: "Assessing…" }));
  try {
    const res = await api("/api/jev", { role: ROLE_ID, project: { title: state.title, brief: state.brief }, sliders: state.sliders });
    showJev(res, "live");
  } catch (e) { $("jevBody").replaceChildren(el("p", { class: "err", text: e.message })); }
  finally { btn.disabled = false; }
}

// ---------- API ----------
async function api(path, body) {
  let r;
  try {
    r = await fetch(WORKER_URL + path, {
      method: "POST", headers: { "content-type": "application/json", "x-access-code": accessCode }, body: JSON.stringify(body),
    });
  } catch { throw new Error("The AI service could not be reached. Check your connection and try again."); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { setAccess("", "The access code was not accepted."); throw new Error("The access code was not accepted. Re-enter it at the top of the page."); }
  if (r.status === 429) throw new Error("Too many requests from this connection. Wait a few minutes and try again.");
  if (!r.ok || data.error) throw new Error(data.message || `The AI service returned an error (${r.status}).`);
  return data;
}

// ---------- access ----------
function setAccess(code, msg) {
  accessCode = code; store.set("ha_code", code);
  const s = $("accessState");
  s.textContent = msg || (code ? "Live AI unlocked for this tab." : "Live AI locked; preset results still work.");
  s.classList.toggle("ok", !!code && !msg);
}

function wireAccess() {
  if (accessCode) setAccess(accessCode);
  $("accessForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("accessCode").value.trim();
    $("accessCode").value = "";
    setAccess(v, v ? null : undefined);
  });
}

// ---------- Claude ----------
const TASK_UI = {
  plan: { button: "Write the plan", hint: "Uses the project set in the simulator." },
  ask: { button: "Ask", hint: "Answers come only from this page's material." },
  crossexam: { button: "Challenge the assessment", hint: "Needs an assessment of the current project." },
};

function wireClaude() {
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    task = t.dataset.task;
    document.querySelectorAll(".tab").forEach((x) => x.setAttribute("aria-selected", String(x === t)));
    $("askField").hidden = task !== "ask";
    $("claudeRun").textContent = TASK_UI[task].button;
    $("claudeHint").textContent = TASK_UI[task].hint;
  }));
  $("claudeHint").textContent = TASK_UI.plan.hint;
  $("askText").addEventListener("keydown", (e) => { if (e.key === "Enter") runClaude(); });
  $("claudeRun").addEventListener("click", runClaude);
}

async function runClaude() {
  const out = $("claudeOut");
  if (!accessCode) { out.replaceChildren(el("p", { class: "none", text: "Enter the access code at the top of the page to use Claude." })); return; }
  const project = { title: state.title, brief: state.brief };
  let body;
  if (task === "plan") body = { role: ROLE_ID, task, project, sliders: state.sliders };
  else if (task === "ask") {
    const q = $("askText").value.trim();
    if (!q) { $("askText").focus(); return; }
    body = { role: ROLE_ID, task, question: q };
  } else {
    if (!lastJev) { out.replaceChildren(el("p", { class: "none", text: "Assess the current project first, or pick a preset with a saved result." })); return; }
    body = { role: ROLE_ID, task, project, sliders: state.sliders, jev: lastJev.derived };
  }
  const btn = $("claudeRun"); btn.disabled = true;
  out.replaceChildren(el("p", { class: "busy", text: "Claude is writing… this can take up to a minute." }));
  try { const res = await api("/api/claude", body); renderMarkdown(out, res.text); }
  catch (e) { out.replaceChildren(el("p", { class: "err", text: e.message })); }
  finally { btn.disabled = false; }
}

// Minimal, safe markdown: headings, bullets, numbered lists, bold, and [case-id] citations. Text nodes only, no innerHTML.
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
    const h = line.match(/^#{1,4}\s+(.*)/);
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ul || ol) {
      const tag = ul ? "UL" : "OL";
      if (!list || list.tagName !== tag) { list = el(tag.toLowerCase()); target.append(list); }
      list.append(el("li", {}, inline((ul || ol)[1])));
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    if (h) target.append(el("h4", {}, inline(h[1])));
    else target.append(el("p", {}, inline(line)));
  }
}

// ---------- fit map & record ----------
function renderFit() {
  const byId = Object.fromEntries(profile.cases.map((c) => [c.id, c]));
  for (const f of role.fit) {
    const req = role.role_context.requirements.find((r) => r.id === f.req);
    const links = el("div", { class: "caselinks" });
    for (const id of f.cases) links.append(el("a", { href: `#case-${id}`, text: byId[id]?.title || id }));
    $("fitMap").append(el("div", { class: "fitrow" },
      el("div", { class: "req", text: req?.text || f.req }),
      el("span", { class: `pill ${f.strength}`, text: f.strength }),
      el("div", { class: "note", text: f.note }),
      f.cases.length ? links : null));
  }
}

function renderRecord() {
  for (const c of profile.cases) {
    const card = caseCard(c);
    card.id = `case-${c.id}`;
    const ul = el("ul"); c.points.forEach((p) => ul.append(el("li", { text: p })));
    card.append(ul);
    $("cases").append(card);
  }
  for (const t of profile.timeline) {
    const when = `${t.from.replace("-", ".")} – ${t.to === "present" ? "now" : t.to.replace("-", ".")}`;
    $("timeline").append(el("div", {}, el("span", { class: "when", text: when }),
      el("span", { text: [t.role, t.org].filter(Boolean).join(", ") })));
  }
}

function renderContact() {
  $("email").textContent = profile.contact.email;
  $("linkedin").href = profile.contact.linkedin;
}

// ---------- next step ----------
function wireDraft() {
  document.querySelectorAll("[data-kind]").forEach((b) => b.addEventListener("click", () => {
    draftKind = b.dataset.kind;
    document.querySelectorAll("[data-kind]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
  $("draftRun").addEventListener("click", async () => {
    if (!accessCode) { $("draftHint").textContent = "Enter the access code at the top of the page first."; return; }
    const btn = $("draftRun"); btn.disabled = true; $("draftHint").textContent = "Drafting…";
    try {
      const res = await api("/api/claude", { role: ROLE_ID, task: "draft", kind: draftKind,
        project: { title: state.title, brief: state.brief }, notes: $("draftNotes").value.trim() });
      $("draftText").value = res.text; $("draftCopy").disabled = false; $("draftHint").textContent = "Edit freely, then copy.";
    } catch (e) { $("draftHint").textContent = e.message; }
    finally { btn.disabled = false; }
  });
  $("draftCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("draftText").value); $("draftHint").textContent = "Copied."; }
    catch { $("draftText").select(); $("draftHint").textContent = "Copy was blocked; the text is selected, press Ctrl+C."; }
  });
}

init().catch((e) => {
  document.querySelector("main").prepend(el("p", { class: "wrap err", text: `The page could not load its content: ${e.message}` }));
});
