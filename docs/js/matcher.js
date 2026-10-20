export const DIMS = ["reg", "dom", "build", "amb", "stake"];

export function clampSliders(sliders = {}) {
  const result = {};
  for (const dim of DIMS) {
    const value = sliders?.[dim];
    result[dim] = Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 50;
  }
  return result;
}

export function similarity(sliders, tags) {
  const s = clampSliders(sliders);
  const meanDifference = DIMS.reduce((total, dim) => {
    const value = Number.isFinite(tags?.[dim]) ? tags[dim] : 50;
    return total + Math.abs(s[dim] - value);
  }, 0) / DIMS.length;
  return 1 - meanDifference / 100;
}

export function matchCases(profile, sliders, n = 3) {
  return (profile?.cases ?? [])
    .map((item, index) => ({ case: item, score: similarity(sliders, item.tags), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, n))
    .map(({ case: item, score }) => ({ case: item, score: Math.round(score * 1000) / 1000 }));
}

export function activeGaps(profile, sliders) {
  const s = clampSliders(sliders);
  return (profile?.gaps ?? []).filter(gap => {
    const trigger = gap.trigger;
    return s[trigger.dim] > trigger.above &&
      (!trigger.and || s[trigger.and.dim] > trigger.and.above);
  });
}

export function describeSliders(profile, sliders) {
  const s = clampSliders(sliders);
  return DIMS.map(dim => {
    const descriptor = profile.dimensions[dim];
    return `${descriptor.label}: ${s[dim]}/100 (0 = ${descriptor.left}, 100 = ${descriptor.right})`;
  }).join("\n");
}

// Curated evidence ids (from a role preset) come first; the matcher fills the rest, without duplicates.
export function pickEvidence(profile, sliders, n = 3, curatedIds = []) {
  const byId = Object.fromEntries((profile?.cases ?? []).map(c => [c.id, c]));
  const curated = curatedIds.filter(id => byId[id]).map(id => ({ case: byId[id], score: null }));
  const rest = matchCases(profile, sliders, (profile?.cases ?? []).length).filter(m => !curatedIds.includes(m.case.id));
  return [...curated, ...rest].slice(0, n);
}

export function buildJevState(profile, role, project, sliders, operatingAssumption, curatedIds = []) {
  const s = clampSliders(sliders);
  const clean = (value, limit) => String(value ?? "").trim().slice(0, limit);
  return {
    candidate: profile.name,
    role: `${role.role} at ${role.company}: ${role.role_context.summary}`,
    company: role.company_context.what,
    project: {
      title: clean(project?.title, 120),
      brief: clean(project?.brief, 600),
      characteristics: describeSliders(profile, s)
    },
    evidence: pickEvidence(profile, s, 5, curatedIds).map(({ case: c }) => ({
      title: c.title, period: c.period, kind: c.kind, headline: c.headline, points: c.points
    })),
    known_gaps: activeGaps(profile, s).map(g => ({ title: g.title, detail: g.detail, mitigation: g.mitigation })),
    operating_assumption: operatingAssumption
  };
}

export function deriveJev(answers, prototypeWeeks) {
  const data = answers && typeof answers === "object" ? answers : {};
  const probabilities = data.time_to_prototype?.probabilities;
  const weeksDist = probabilities && typeof probabilities === "object"
    ? ["0", "1", "2", "3", "4"].map(key => Number.isFinite(probabilities[key]) ? probabilities[key] : 0)
    : null;
  let expectedWeeks = null;
  let likelyBand = null;
  if (weeksDist) {
    const weeks = Array.isArray(prototypeWeeks) ? prototypeWeeks : [];
    expectedWeeks = Math.round(weeksDist.reduce((sum, probability, index) =>
      sum + probability * (Number.isFinite(weeks[index]) ? weeks[index] : 0), 0) * 10) / 10;
    likelyBand = weeksDist.indexOf(Math.max(...weeksDist));
  }
  return {
    p_mvp: data.mvp_success?.noul ?? null,
    p_specialist: data.needs_specialist?.noul ?? null,
    weeks_dist: weeksDist,
    expected_weeks: expectedWeeks,
    likely_band: likelyBand,
    fit_level: data.evidence_fit?.score ?? null,
    main_risk: data.main_risk?.choice ?? null,
    main_risk_probs: data.main_risk?.probabilities ?? null
  };
}
