// Räknarna från en lokal körning: det enda från en local-only-organisation som får lämna Macen.
// Claude skriver /work/counts.json; här behålls bara de kända nycklarna med heltal (0–9999), allt annat
// (text, namn, ämnen, nya nycklar) kastas. Resultatet skrivs till Firestore digests/<datum>.counts.<org>.<del>,
// där morgonmejlet och Översikten i webbappen visar det. Med --dry-run skrivs bara resultatet ut.
// Användning: node local/counts.mjs <org> <morgon|kvall> <counts.json> <datum> <rapport i valvet> [--dry-run]
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
// Samma nycklar som i local/<org>/*.md; bara antal, aldrig innehåll
export const SCHEMA = {
  mejl: ['nya', 'relevanta', 'hogPrio', 'vantarSvar'],
  slack: ['omnamnanden', 'dm', 'vantarSvar'],
  linear: ['tilldelade', 'nya', 'hogPrio'],
  github: ['oppnaPr', 'vantarReview', 'ciFel', 'mergade'],
};

export function clean(raw) {
  const out = {};
  for (const [group, keys] of Object.entries(SCHEMA)) {
    for (const k of keys) {
      const v = raw?.[group]?.[k];
      if (Number.isInteger(v) && v >= 0 && v < 10_000) (out[group] ||= {})[k] = v;
    }
  }
  return out;
}

// En rad text av räknarna, byggd här (inte av Claude), som mejlet och webbappen visar som den är
export function describe(c) {
  const n = (v, one, many) => `${v} ${v === 1 ? one : many}`;
  const extra = list => { const x = list.filter(Boolean); return x.length ? ` (${x.join(', ')})` : ''; };
  const parts = [];
  if (c.mejl) parts.push(`Mejl: ${n(c.mejl.nya ?? 0, 'nytt', 'nya')}` + extra([
    c.mejl.relevanta != null && `${c.mejl.relevanta} relevanta`, c.mejl.hogPrio && `${c.mejl.hogPrio} hög prio`,
    c.mejl.vantarSvar && `${c.mejl.vantarSvar} väntar på svar`]));
  if (c.slack) parts.push(`Slack: ${n(c.slack.omnamnanden ?? 0, 'omnämnande', 'omnämnanden')}` + extra([
    c.slack.dm && `${c.slack.dm} DM`, c.slack.vantarSvar && `${c.slack.vantarSvar} väntar på svar`]));
  if (c.linear) parts.push(`Linear: ${c.linear.tilldelade ?? 0} tilldelade` + extra([
    c.linear.nya && n(c.linear.nya, 'ny', 'nya'), c.linear.hogPrio && `${c.linear.hogPrio} hög prio`]));
  if (c.github) parts.push(`GitHub: ${c.github.oppnaPr ?? 0} öppna PR` + extra([
    c.github.vantarReview && `${c.github.vantarReview} väntar på min review`, c.github.ciFel && `${c.github.ciFel} med CI-fel`,
    c.github.mergade && `${c.github.mergade} mergade`]));
  return parts.join(' · ') || 'inga räknare';
}

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2).filter(a => a !== '--dry-run');
  const dry = process.argv.includes('--dry-run');
  const [org, kind, file, date, report] = args;
  if (!/^[A-Za-z0-9-]+$/.test(org || '') || !['morgon', 'kvall'].includes(kind) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    console.error('användning: counts.mjs <org> <morgon|kvall> <counts.json> <datum> <rapport> [--dry-run]'); process.exit(2);
  }
  const raw = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
  if (!raw) { console.log('inga räknare'); process.exit(0); }
  const counts = clean(raw);
  // Sökvägen byggs här (organisation, datum och del), inte av Claude
  const entry = { ...counts, text: describe(counts), rapport: `${org}-valvet/Sammanfattningar/${path.basename(report || '')}`, tid: new Date().toISOString() };
  if (dry) { console.log(JSON.stringify(entry)); process.exit(0); }

  const project = JSON.parse(await fs.readFile(path.join(ROOT, '.firebaserc'), 'utf8')).projects.default;
  const value = v => typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'string' ? { stringValue: v }
    : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x)])) } };
  const token = (await exec('gcloud', ['auth', 'print-access-token'])).stdout.trim();
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/digests/${date}` +
    `?updateMask.fieldPaths=${encodeURIComponent(`counts.\`${org}\`.${kind}`)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'x-goog-user-project': project, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { counts: value({ [org]: { [kind]: entry } }) } }),
  });
  if (!res.ok) { console.error(`räknarna kunde inte sparas: ${res.status} ${await res.text()}`); process.exit(1); }
  console.log(`räknare sparade: ${JSON.stringify(counts)}`);
}
