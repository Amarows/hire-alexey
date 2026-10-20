import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DIMS } from '../docs/js/matcher.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const phoneLike = /\+?\d[\d\s]{8,}\d/;
const forbidden = /psychometric|ADEPT|salary|P&L of|holdings/i;

export function validate(profile, roles) {
  const errors = [];
  const cases = Array.isArray(profile?.cases) ? profile.cases : [];
  const caseIds = new Set();
  for (const [index, item] of cases.entries()) {
    const path = `profile.cases[${index}]`;
    if (caseIds.has(item.id)) errors.push(`${path}: duplicate case id "${item.id}"`);
    caseIds.add(item.id);
    for (const dim of DIMS) {
      if (!Number.isInteger(item.tags?.[dim]) || item.tags[dim] < 0 || item.tags[dim] > 100) {
        errors.push(`${path}.tags.${dim}: must be an integer from 0 to 100`);
      }
    }
    if (!["employment", "own build", "pro bono", "education"].includes(item.kind)) {
      errors.push(`${path}.kind: invalid case kind "${item.kind}"`);
    }
  }
  for (const [index, gap] of (profile?.gaps ?? []).entries()) {
    for (const [label, trigger] of [["trigger", gap.trigger], ["trigger.and", gap.trigger?.and]]) {
      if (trigger && !DIMS.includes(trigger.dim)) errors.push(`profile.gaps[${index}].${label}.dim: unknown dimension "${trigger.dim}"`);
    }
    if (!(gap.weight > 0 && gap.weight <= 1)) errors.push(`profile.gaps[${index}].weight: must be in (0, 1]`);
  }

  for (const [roleIndex, role] of (roles ?? []).entries()) {
    const rolePath = `roles[${roleIndex}]`;
    const requirementIds = new Set((role.role_context?.requirements ?? []).map(req => req.id));
    for (const [fitIndex, fit] of (role.fit ?? []).entries()) {
      const path = `${rolePath}.fit[${fitIndex}]`;
      if (!requirementIds.has(fit.req)) errors.push(`${path}.req: unknown requirement "${fit.req}"`);
      for (const id of fit.cases ?? []) if (!caseIds.has(id)) errors.push(`${path}.cases: unknown case id "${id}"`);
      if (!["strong", "medium", "gap"].includes(fit.strength)) errors.push(`${path}.strength: invalid strength "${fit.strength}"`);
    }
    const presetIds = new Set();
    for (const [presetIndex, preset] of (role.presets ?? []).entries()) {
      const path = `${rolePath}.presets[${presetIndex}]`;
      if (presetIds.has(preset.id)) errors.push(`${path}.id: duplicate preset id "${preset.id}"`);
      presetIds.add(preset.id);
      for (const dim of DIMS) {
        if (!Number.isInteger(preset.sliders?.[dim]) || preset.sliders[dim] < 0 || preset.sliders[dim] > 100) {
          errors.push(`${path}.sliders.${dim}: must be an integer from 0 to 100`);
        }
      }
    }
  }

  // `_comment` and `source` fields are authoring metadata. Source citations can
  // contain numeric posting identifiers, which are not personal phone numbers.
  const publicContent = value => Array.isArray(value)
    ? value.map(publicContent)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== '_comment' && key !== 'source').map(([key, child]) => [key, publicContent(child)]))
      : value;
  const serialized = JSON.stringify(publicContent({ profile, roles }));
  if (phoneLike.test(serialized)) errors.push('content matches a phone-number-like pattern');
  if (forbidden.test(serialized)) errors.push('content contains a forbidden privacy term');
  return errors;
}

async function main() {
  const profile = JSON.parse(await readFile(resolve(root, 'docs/content/profile.json'), 'utf8'));
  const roleDir = resolve(root, 'docs/content/roles');
  const names = (await readdir(roleDir)).filter(name => name.endsWith('.json')).sort();
  const roles = await Promise.all(names.map(async name => JSON.parse(await readFile(resolve(roleDir, name), 'utf8'))));
  const errors = validate(profile, roles);
  if (errors.length) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`Content valid (${names.length} role file${names.length === 1 ? '' : 's'}).`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
