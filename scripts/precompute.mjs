import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const worker = arg("--worker");
const roleId = arg("--role");
if (!worker || !roleId) throw new Error("Usage: node scripts/precompute.mjs --worker <url> --role <role>");
if (!process.env.ACCESS_CODE) throw new Error("ACCESS_CODE must be set in the environment.");
const rolePath = new URL(`../docs/content/roles/${roleId}.json`, import.meta.url);
const role = JSON.parse(await readFile(rolePath, "utf8"));
const presets = {};
let model;
let questionsVersion;

for (let index = 0; index < role.presets.length; index += 1) {
  const preset = role.presets[index];
  if (index) await delay(1000);
  const response = await fetch(new URL("/api/jev", worker), {
    method: "POST",
    headers: { "content-type": "application/json", "x-access-code": process.env.ACCESS_CODE },
    body: JSON.stringify({ role: roleId, project: { title: preset.title, brief: preset.brief }, sliders: preset.sliders }),
  });
  if (!response.ok) throw new Error(`Preset ${preset.id} failed with HTTP ${response.status}: ${await response.text()}`);
  const data = await response.json();
  presets[preset.id] = data;
  model = data.model;
  questionsVersion = data.questions_version;
}

const output = new URL(`../docs/content/precomputed/${roleId}.json`, import.meta.url);
await writeFile(output, `${JSON.stringify({ generated_utc: new Date().toISOString(), questions_version: questionsVersion, model, presets }, null, 2)}\n`);
console.log(`Wrote ${role.presets.length} presets to ${output.pathname}`);
