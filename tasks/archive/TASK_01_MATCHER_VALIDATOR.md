# TASK 01 — Evidence matcher, content validator, CI (Codex)

Read first: `CLAUDE.md`, `docs/content/profile.json`, `docs/content/roles/leva.json`.

Pure JavaScript (ES modules, Node 24 built-ins only, no npm dependencies). No network, no file writes
outside the files listed below.

Files you may create/change: `docs/js/matcher.js`, `test/matcher.test.mjs`, `scripts/validate-content.mjs`,
`test/validate-content.test.mjs`, `package.json` (root, `"type": "module"`, scripts only, no dependencies),
`.github/workflows/test.yml`. Nothing else. Do **not** edit anything under `docs/content/` or `worker/`.

## 1. `docs/js/matcher.js` — pure, browser- and Worker-compatible (no `fs`, no `process`)

Exports:

- `DIMS = ["reg", "dom", "build", "amb", "stake"]`.
- `clampSliders(sliders) -> object`: every DIM present, integer, clamped to 0..100; missing → 50; unknown keys dropped.
- `similarity(sliders, tags) -> number` in [0, 1]: `1 - mean_over_DIMS(|sliders[d] - tags[d]|) / 100`.
- `matchCases(profile, sliders, n = 3) -> Array<{case, score}>`: all `profile.cases` scored by `similarity`,
  sorted by score desc, ties broken by original order (stable), first `n`. `score` rounded to 3 decimals.
- `activeGaps(profile, sliders) -> Array<gap>`: a gap is active when `sliders[trigger.dim] > trigger.above` and, if
  `trigger.and` exists, also `sliders[trigger.and.dim] > trigger.and.above`. Keep file order.
- `describeSliders(profile, sliders) -> string`: one line per DIM, e.g.
  `Regulatory depth: 75/100 (0 = No regulatory touchpoint, 100 = New licence or jurisdiction)`, joined by `\n`.
- `buildJevState(profile, role, project, sliders) -> object` where `project = {title, brief}`:
  ```
  {
    candidate: profile.name,
    role: `${role.role} at ${role.company}: ${role.role_context.summary}`,
    company: role.company_context.what,
    project: { title, brief, characteristics: describeSliders(profile, s) },
    evidence: matchCases(profile, s, 3).map(({case: c}) => ({ title: c.title, period: c.period, kind: c.kind,
              headline: c.headline, points: c.points })),
    known_gaps: activeGaps(profile, s).map(g => ({ title: g.title, detail: g.detail })),
    operating_assumption: <passed in as 5th param `operatingAssumption`>
  }
  ```
  Signature: `buildJevState(profile, role, project, sliders, operatingAssumption)`. `s = clampSliders(sliders)`.
  `title` trimmed to 120 chars, `brief` to 600 chars.
- `deriveJev(answers, prototypeWeeks) -> object` (answers = Jev response `answers`, may be missing/partial):
  ```
  {
    p_mvp:            answers.mvp_success?.noul ?? null,
    p_specialist:     answers.needs_specialist?.noul ?? null,
    weeks_dist:       [p0..p4] from answers.time_to_prototype.probabilities["0".."4"] (missing → 0), or null,
    expected_weeks:   Σ p_i × prototypeWeeks[i] (rounded 1 dp), or null,
    likely_band:      index of max probability in weeks_dist, or null,
    fit_level:        answers.evidence_fit?.score ?? null   (fractional 0..4),
    main_risk:        answers.main_risk?.choice ?? null,
    main_risk_probs:  answers.main_risk?.probabilities ?? null
  }
  ```
  Never throws on missing fields.

## 2. `test/matcher.test.mjs` (`node:test` + `node:assert`)

Load the real JSON files with `fs` in the test (allowed in tests). Hand-computed cases at minimum:
- `similarity({reg:0,dom:0,build:0,amb:0,stake:0}, {reg:100,dom:100,build:100,amb:100,stake:100}) === 0`; identical → 1;
  `{50×5}` vs `{reg:100, others 50}` → 0.9.
- `clampSliders({reg: 150, dom: -3, x: 9})` → `{reg:100, dom:0, build:50, amb:50, stake:50}`.
- With the LEVA preset `tokenised` sliders, `activeGaps` includes `private-markets` and `kyc-aml`; with `termsheet`
  sliders it includes `no-cs-degree` and not `private-markets`.
- `matchCases` returns 3 items, sorted, deterministic across two calls.
- `deriveJev({})` returns all-null fields; a hand-written answers fixture gives the exact expected_weeks.
- `buildJevState` output contains no key named `tags` and no phone-number-like string.

## 3. `scripts/validate-content.mjs` + test

CLI: `node scripts/validate-content.mjs` validates `docs/content/profile.json` and every `docs/content/roles/*.json`;
exit 1 with readable messages on failure. Export a pure `validate(profile, roles) -> string[]` (list of errors) for the test.
Checks:
- case ids unique; every case has all 5 DIMS in `tags`, integers 0..100; `kind` ∈ {employment, own build, pro bono, education}.
- every gap trigger dim is a DIM; `weight` in (0,1].
- every role: `fit[].req` exists in `role_context.requirements`; every `fit[].cases` id exists in profile; `strength` ∈
  {strong, medium, gap}; every preset has all 5 DIMS 0..100 and unique id.
- privacy guard: the serialized JSON of all files must not match `/\+?\d[\d\s]{8,}\d/` (phone-like), nor
  case-insensitive any of: `psychometric`, `ADEPT`, `salary`, `P&L of`, `holdings`.
Test: the real files pass; a mutated copy (duplicate case id, phone number, bad fit ref) yields the expected errors.

## 4. CI

`package.json` scripts: `"test": "node --test test/"`, `"validate": "node scripts/validate-content.mjs"`.
`.github/workflows/test.yml`: on push and pull_request, Node 24, run `npm run validate` and `npm test`
(the worker job is added later; don't reference `worker/`).

## Acceptance (Claude will run these)
- `node --test test/` all pass; `node scripts/validate-content.mjs` exits 0.
- `docs/js/matcher.js` imports nothing; `grep -n "require\|process\|fs" docs/js/matcher.js` finds nothing.
