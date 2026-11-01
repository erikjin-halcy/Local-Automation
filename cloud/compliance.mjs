// Compliance-taggen "local-only": material från en sådan organisation (repon, Slack, Linear, jobbmejl …)
// behandlas bara på Macen. Det får aldrig hamna i Firestore, Cloud Run, bucketen eller morgonmejlet.
//
//   compliance.json   organisationerna: MCP-servrar som tillhör dem, GitHub-ägare, sökmönster, lokalt valv
//   devctl            repona: `devctl repos --json` ger compliance och org per repo (bara på Macen)
//
// Används av sync/ (synk och arkiv), cloud/ (körning, schema, morgonmejl), ui/ och cloud/deploy.sh.
// I molnet finns ingen devctl; där räcker compliance.json, eftersom molnet bara behöver veta vilka
// källor som är lokala.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const LOCAL_ONLY = 'local-only';
const FILES = [path.join(import.meta.dirname, '..', 'compliance.json'), path.join(import.meta.dirname, 'compliance.json')];
const home = p => p?.replace(/^~(?=\/|$)/, os.homedir());
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function readConfig() {
  for (const f of FILES) {
    const text = await fs.readFile(f, 'utf8').catch(() => null);
    if (text) return JSON.parse(text);
  }
  return { orgs: {} };
}

// Repona med compliance local-only enligt devctl. Fungerar inte devctl läses dess taggfil
// (~/.config/devctl/tags.json: {repos: {repo: [taggar]}, orgs: {repo: org}}); i molnet finns ingen av dem.
async function devctlRepos() {
  try {
    const { stdout } = await exec('devctl', ['repos', '--json'], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout).filter(r => r.compliance === LOCAL_ONLY || r.tags?.includes(LOCAL_ONLY));
  } catch { /* devctl är inte installerat eller svarar inte */ }
  try {
    const t = JSON.parse(await fs.readFile(path.join(os.homedir(), '.config/devctl/tags.json'), 'utf8'));
    return Object.entries(t.repos || {}).filter(([, tags]) => tags.includes(LOCAL_ONLY))
      .map(([name]) => ({ name, org: t.orgs?.[name] || '' }));
  } catch { return []; }
}

export async function loadCompliance({ devctl = true } = {}) {
  const cfg = await readConfig();
  const orgs = Object.entries(cfg.orgs || {}).filter(([, o]) => o.compliance === LOCAL_ONLY)
    .map(([name, o]) => ({ name, mcp: o.mcp || [], github: o.github || [], patterns: o.patterns || [], vault: home(o.vault), repos: [] }));
  for (const r of devctl ? await devctlRepos() : []) {
    let org = orgs.find(o => o.name === (r.org || r.name));
    if (!org) orgs.push(org = { name: r.org || r.name, mcp: [], github: [], patterns: [], vault: null, repos: [] });
    org.repos.push(r);
  }
  // Ord som visar att något hör till en sådan organisation: namnet, repona (namn och GitHub-sökväg) och
  // mönstren. Bara hela ord: "Acme-app" och "acme.se" räknas, men inte GitHub-användaren "erik-acme".
  const terms = [...new Set(orgs.flatMap(o => [o.name, ...o.patterns, ...o.github,
    ...o.repos.flatMap(r => [r.name, r.github].filter(Boolean))]))].sort((a, b) => b.length - a.length);
  const pattern = terms.length ? new RegExp(`(?<![\\w-])(?:${terms.map(esc).join('|')})(?![\\w])`, 'i') : /(?!)/;
  const localMcp = new Set(orgs.flatMap(o => o.mcp));
  return {
    orgs,
    pattern,
    localMcp,
    matches: text => pattern.test(text || ''),
    // De MCP-servrar i en uppgift som bara får köras lokalt
    localSources: mcp => (mcp || []).map(m => m.name ?? m).filter(n => localMcp.has(n)),
  };
}

// node cloud/compliance.mjs mcp    -> de lokala MCP-servrarna, en per rad (för deploy.sh)
// node cloud/compliance.mjs orgs   -> organisationer med valv: namn<TAB>valv (för local/run.sh)
// node cloud/compliance.mjs        -> sammanfattning
if (process.argv[1] === import.meta.filename) {
  const c = await loadCompliance();
  if (process.argv[2] === 'mcp') console.log([...c.localMcp].join('\n'));
  else if (process.argv[2] === 'orgs') console.log(c.orgs.filter(o => o.vault).map(o => `${o.name}\t${o.vault}`).join('\n'));
  else for (const o of c.orgs) {
    console.log(`${o.name} (local-only)\n  källor: ${o.mcp.join(', ') || '–'}\n  GitHub: ${o.github.join(', ') || '–'}` +
      `\n  repon:  ${o.repos.map(r => r.name).join(', ') || '–'}\n  valv:   ${o.vault || '–'}`);
  }
}
