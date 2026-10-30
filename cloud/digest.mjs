// Morgonmejlet: körs av Cloud Run-jobbet med MODE=digest (se runner.mjs).
//  1. hämtar de senaste rapporterna från jobben som är markerade "Ta med i morgonmejlet"
//     (är inget jobb markerat tas alla påslagna jobb med)
//  2. låter Claude skriva en kort sammanfattning överst (utan MCP-servrar och utan tokens);
//     under den följer rapporterna i sin helhet
//  3. sparar mejlet i digests/<datum> och ber API-tjänsten skicka det (cloud/api.mjs,
//     cloud/mail.mjs); den skickar bara till ägaren och har den enda Gmail-token som kan skicka

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { cleanProfile, profileText } from './lib.mjs';

const WORK = '/work';
const APP_URL = process.env.APP_URL || '';
const API_URL = process.env.API_URL || '';
const MAX_AGE_MS = 20 * 3600_000;   // rapporter från det senaste dygnet
const MAX_REPORT = 60_000;
const MAX_RUNS_PER_DAY = 5;

if (!API_URL) { console.error('API_URL saknas'); process.exit(2); }

initializeApp();
const db = getFirestore();
const rawProfile = (await db.doc('profile/me').get()).data() || {};
const profile = cleanProfile(rawProfile);
const forced = process.env.FORCE === '1';
if (!rawProfile.digest?.enabled && !forced) { console.log('morgonmejlet är avstängt'); process.exit(0); }

process.env.TZ = profile.timezone || 'UTC';
const now = new Date();
const p2 = n => String(n).padStart(2, '0');
const date = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
const ref = db.doc(`digests/${date}`);

// Spärr mot att mejlet görs många gånger samma dag
const runs = await db.runTransaction(async tx => {
  const n = (await tx.get(ref)).data()?.runs || 0;
  if (n >= MAX_RUNS_PER_DAY) return -1;
  tx.set(ref, { date, status: 'running', runs: n + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return n + 1;
});
if (runs < 0) { console.error(`morgonmejlet har redan gjorts ${MAX_RUNS_PER_DAY} gånger i dag`); process.exit(1); }

let log = '';
try {
  // ---------- rapporter ----------
  const all = (await db.collection('tasks').get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const marked = all.filter(t => t.digest);
  const tasks = (marked.length ? marked : all.filter(t => t.enabled)).map(t => t.id).sort();
  const since = new Date(Date.now() - MAX_AGE_MS).toISOString();
  const sources = [];
  for (const task of tasks) {
    const files = (await db.collection('files').where('task', '==', task).get()).docs
      .map(d => d.data())
      .filter(f => typeof f.content === 'string' && f.modified >= since && /\.(md|txt)$/i.test(f.path))
      .sort((a, b) => b.modified.localeCompare(a.modified));
    if (!files.length) continue;
    const f = files[0];
    const full = path.join(WORK, 'rapporter', task, path.basename(f.path));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, f.content.slice(0, MAX_REPORT));
    sources.push({ task, path: f.path, modified: f.modified });
  }
  console.log(`rapporter: ${sources.map(s => `${s.task}/${s.path}`).join(', ') || 'inga'}`);

  // Rapporterna i sin helhet, med rubrikerna två nivåer ned så att de hamnar under jobbets rubrik
  const reports = (await Promise.all(sources.map(async s => {
    const text = await fs.readFile(path.join(WORK, 'rapporter', s.task, path.basename(s.path)), 'utf8');
    return `## ${s.task}\n\n${text.replace(/^(#{1,4}) /gm, '$1## ')}`;
  }))).join('\n\n---\n\n');

  // ---------- Claude sammanfattar ----------
  let summary = '';
  if (!sources.length) {
    summary = tasks.length ? `Inga nya rapporter från ${tasks.join(', ')} det senaste dygnet.` : 'Inga påslagna jobb.';
  } else {
    const intro = profileText(profile);
    const prompt = `${intro ? `${intro}\nUppgift:\n` : ''}` +
      `I /work/rapporter/<jobb>/ ligger dagens rapporter från mina automatiska jobb (${sources.map(s => s.task).join(', ')}). ` +
      'Skriv en kort sammanfattning i markdown som inleder mitt morgonmejl och spara den i /work/morgonmejl.md. ' +
      'Rapporterna i sin helhet läggs automatiskt in under din sammanfattning, så upprepa inte detaljerna. Skicka ingenting själv.\n\n' +
      'Struktur (hoppa över rubriker som blir tomma):\n' +
      '1. **Prioritera i dag** (allra först): de 1–3 viktigaste sakerna att göra i dag, numrerade, var och en med en kort motivering och källa.\n' +
      '2. **I korthet**: 2–3 meningar om läget i övrigt.\n' +
      '3. **Dagens schema**: möten och fokusblock med tider, om det finns i rapporterna.\n' +
      '4. **Att göra**: en samlad checklista (`- [ ] …`) över allt som kräver åtgärd, i prioritetsordning. Slå ihop dubbletter och ange källa i slutet av varje punkt, t.ex. (Slack #dev), (jobbmejl), (Linear HAL-123).\n' +
      '\nHögst cirka 250 ord. Skriv datum som ÅÅÅÅ-MM-DD (t.ex. 2026-10-30), aldrig som "29 okt". Behåll länkar. Ta bara med sådant som står i rapporterna och hitta inte på något. Ingen hälsningsfras eller signatur.';
    // Claude får inga tokens: bara det som behövs för att köra
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TZ: process.env.TZ, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
    const exit = await new Promise(resolve => {
      const child = spawn('claude', ['--strict-mcp-config', '--dangerously-skip-permissions', '-p', prompt],
        { cwd: WORK, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const add = b => { log += b.toString(); process.stdout.write(b); };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      child.on('error', e => { log += `\n${e.message}\n`; resolve(127); });
      child.on('close', code => resolve(code ?? 1));
    });
    summary = await fs.readFile(path.join(WORK, 'morgonmejl.md'), 'utf8').catch(() => '');
    if (exit !== 0 || !summary.trim()) summary = `*Kunde inte sammanfatta (exit ${exit}), rapporterna följer nedan.*`;
  }
  const markdown = reports ? `${summary.trim()}\n\n---\n\n# Rapporterna\n\n${reports}` : summary;

  // ---------- skicka ----------
  // Fast prefix gör det lätt att filtrera mejlen till en egen etikett i Gmail
  const subject = `[Local Automation] Morgonmejl ${date} (${now.toLocaleDateString('sv-SE', { weekday: 'long' })})`;
  const link = APP_URL ? `\n\n---\n\n[Öppna Local Automation](${APP_URL}) för att bocka av punkterna.` : '';
  await ref.set({
    status: 'ready', subject, markdown: markdown + link, sources, error: null, log: log.slice(-20_000),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await requestSend();
  console.log(`skickat: ${subject}`);
  process.exit(0);
} catch (e) {
  console.error(e);
  await ref.set({ status: 'error', error: String(e.message || e), log: log.slice(-20_000), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  process.exit(1);
}

// Skickas av API-tjänsten, som har Gmail-token; körningen (och Claude) har den inte
async function requestSend() {
  const meta = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=';
  const idToken = await fetch(meta + encodeURIComponent(API_URL), { headers: { 'Metadata-Flavor': 'Google' } }).then(r => r.text());
  const res = await fetch(`${API_URL}/digest/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ date }),
  });
  if (!res.ok) throw new Error(`utskick: ${res.status} ${(await res.json().catch(() => ({}))).error || ''}`);
}
