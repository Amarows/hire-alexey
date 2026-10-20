import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DIMS, activeGaps, buildJevState, clampSliders, deriveJev, matchCases, pickEvidence, similarity } from '../docs/js/matcher.js';

const profile = JSON.parse(await readFile(new URL('../docs/content/profile.json', import.meta.url), 'utf8'));
const role = JSON.parse(await readFile(new URL('../docs/content/roles/leva.json', import.meta.url), 'utf8'));
const preset = id => role.presets.find(item => item.id === id).sliders;

test('similarity handles extremes, identity, and a single dimension difference', () => {
  const zeros = Object.fromEntries(DIMS.map(dim => [dim, 0]));
  const hundreds = Object.fromEntries(DIMS.map(dim => [dim, 100]));
  const middle = Object.fromEntries(DIMS.map(dim => [dim, 50]));
  assert.equal(similarity(zeros, hundreds), 0);
  assert.equal(similarity(middle, middle), 1);
  assert.equal(similarity(middle, { ...middle, reg: 100 }), 0.9);
});

test('clampSliders fills defaults, clamps values, and drops unknown keys', () => {
  assert.deepEqual(clampSliders({ reg: 150, dom: -3, x: 9 }), { reg: 100, dom: 0, build: 50, amb: 50, stake: 50 });
});

test('active gaps follow the LEVA presets and preserve file order', () => {
  const tokenised = activeGaps(profile, preset('tokenised')).map(g => g.id);
  assert.ok(tokenised.includes('private-markets'));
  assert.ok(tokenised.includes('kyc-aml'));
  const termsheet = activeGaps(profile, preset('termsheet')).map(g => g.id);
  assert.ok(termsheet.includes('no-cs-degree'));
  assert.ok(!termsheet.includes('private-markets'));
});

test('matchCases returns a deterministic sorted top three', () => {
  const one = matchCases(profile, preset('tokenised'));
  assert.equal(one.length, 3);
  assert.deepEqual(one, matchCases(profile, preset('tokenised')));
  assert.ok(one[0].score >= one[1].score && one[1].score >= one[2].score);
});

test('deriveJev handles missing answers and calculates expected weeks', () => {
  assert.deepEqual(deriveJev({}), {
    p_mvp: null, p_specialist: null, weeks_dist: null, expected_weeks: null,
    likely_band: null, fit_level: null, main_risk: null, main_risk_probs: null
  });
  const answers = {
    mvp_success: { noul: 0.8 }, needs_specialist: { noul: 0.2 },
    time_to_prototype: { probabilities: { '0': 0.1, '1': 0.2, '2': 0.3, '3': 0.25, '4': 0.15 } },
    evidence_fit: { score: 3.5 }, main_risk: { choice: 'scope', probabilities: { scope: 0.7 } }
  };
  assert.deepEqual(deriveJev(answers, [0, 1, 2, 4, 8]), {
    p_mvp: 0.8, p_specialist: 0.2, weeks_dist: [0.1, 0.2, 0.3, 0.25, 0.15],
    expected_weeks: 3, likely_band: 2, fit_level: 3.5, main_risk: 'scope', main_risk_probs: { scope: 0.7 }
  });
});

test('buildJevState trims project fields and excludes tags and phone-like data', () => {
  const state = buildJevState(profile, role, { title: `  ${'x'.repeat(130)} `, brief: ' brief ' }, preset('tokenised'), 'Assume no vendor constraints');
  assert.equal(state.project.title.length, 120);
  assert.equal(state.project.brief, 'brief');
  assert.equal(state.operating_assumption, 'Assume no vendor constraints');
  assert.equal(JSON.stringify(state).includes('"tags"'), false);
  assert.equal(/\+?\d[\d\s]{8,}\d/.test(JSON.stringify(state)), false);
});

test('pickEvidence puts curated preset cases first and fills without duplicates', () => {
  const voting = role.presets.find(p => p.id === 'voting');
  const picked = pickEvidence(profile, voting.sliders, 5, voting.evidence);
  assert.deepEqual(picked.slice(0, 3).map(p => p.case.id), voting.evidence);
  assert.ok(picked.slice(0, 3).every(p => p.score === null));
  assert.equal(new Set(picked.map(p => p.case.id)).size, 5);
  assert.deepEqual(pickEvidence(profile, voting.sliders, 3, ['no-such-case']).map(p => p.case.id),
    matchCases(profile, voting.sliders, 3).map(m => m.case.id));
});
