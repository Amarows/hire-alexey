import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validate } from '../scripts/validate-content.mjs';

const profile = JSON.parse(await readFile(new URL('../docs/content/profile.json', import.meta.url), 'utf8'));
const role = JSON.parse(await readFile(new URL('../docs/content/roles/leva.json', import.meta.url), 'utf8'));

test('real profile and role content pass validation', () => {
  assert.deepEqual(validate(profile, [role]), []);
});

test('validator reports duplicate case id, phone-like content, and bad fit reference', () => {
  const changedProfile = structuredClone(profile);
  changedProfile.cases[1].id = changedProfile.cases[0].id;
  changedProfile.contact.extra = '+1 212 555 0199';
  const changedRole = structuredClone(role);
  changedRole.fit[0].cases.push('missing-case');
  const errors = validate(changedProfile, [changedRole]);
  assert.ok(errors.some(error => error.includes('duplicate case id')));
  assert.ok(errors.some(error => error.includes('phone-number-like')));
  assert.ok(errors.some(error => error.includes('unknown case id "missing-case"')));
});
