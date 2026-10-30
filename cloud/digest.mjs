// Morgonmejlet: körs av Cloud Run-jobbet med MODE=digest (se runner.mjs).
//  1. hämtar de senaste rapporterna från jobben som är markerade "Ta med i morgonmejlet"
//     (är inget jobb markerat tas alla påslagna jobb med)
//  2. låter Claude kontrollera varje att göra-punkt mot läget nu (Linear, Slack, Gmail och
//     kalendern, bara läsbehörighet) och skriva en kort sammanfattning överst; under den följer
//     rapporterna i sin helhet. Punkter som redan är gjorda bockas av, även i webbappen.
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
const WAIT_MS = 20 * 60_000;     // så länge mejlet väntar på jobb som fortfarande körs
const DATA = '/data';
// "- [ ] text" eller "1. [x] text": prefix, bock, avslut, text (samma som i ui/server.mjs)
const TODO_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s+)(.*)$/;
// Läsverktyg för att kontrollera vad som redan är gjort, och variablerna de behöver
const CHECK_MCP = [
  ['linear', ['LINEAR_API_KEY']],
  ['slack', ['SLACK_XOXP']],
  ['google-work', ['GOOGLE_WORK_EMAIL', 'GOOGLE_OAUTH_CLIENT_ID']],
  ['google', ['GOOGLE_EMAIL', 'GOOGLE_OAUTH_CLIENT_ID']],
];
const CHECK_ENV = ['LINEAR_API_KEY', 'SLACK_XOXP', 'GOOGLE_EMAIL', 'GOOGLE_WORK_EMAIL', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'];

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
  // Jobben körs parallellt; vänta tills de som körs nu är klara (högst WAIT_MS)
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const states = await Promise.all(tasks.map(t => db.doc(`taskState/${t}`).get().then(d => d.data() || {})));
    const running = tasks.filter((t, i) => states[i].running && Date.now() - (states[i].lockedAt?.toMillis?.() ?? 0) < 40 * 60_000);
    if (!running.length) break;
    if (Date.now() > deadline) { console.log(`väntade inte längre på: ${running.join(', ')}`); break; }
    console.log(`väntar på: ${running.join(', ')}`);
    await new Promise(r => setTimeout(r, 15_000));
  }
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
    sources.push({ task, path: f.path, modified: f.modified, content: f.content });
  }
  console.log(`rapporter: ${sources.map(s => `${s.task}/${s.path}`).join(', ') || 'inga'}`);

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
      '5. **Redan klart** (sist, bara om något): en kort lista över punkter från rapporterna som du såg var gjorda, med vad som visade det.\n\n' +
      'Kontrollera först, innan du skriver: rapporterna kan vara inaktuella. Gå igenom varje punkt i rapporternas checklistor (`- [ ]`) ' +
      'och kontrollera med verktygen om den redan är gjord. Exempel: Linear-ärendet är klart eller stängt, eller inbjudan är accepterad (jag är medlem); ' +
      'jag har svarat i Slack-tråden eller kanalen efter frågan; jag har svarat på mejlet; mötet är redan bokat. ' +
      'Punkter som är avbockade (`- [x]`) är redan klara. Ta inte med gjorda punkter under Prioritera i dag eller Att göra. ' +
      'Är du osäker, låt punkten vara kvar. Du får bara läsa: ändra, skicka eller svara inte på något.\n' +
      'Skriv också /work/klara.json: en JSON-lista med den exakta texten efter `- [ ] ` för varje punkt i rapporterna som är gjord, t.ex. ["Acceptera Ellens Linear-inbjudan (jobbmejl)"].\n' +
      '\nHögst cirka 250 ord. Skriv datum som ÅÅÅÅ-MM-DD (t.ex. 2026-10-30), aldrig som "29 okt". Behåll länkar. Ta bara med sådant som står i rapporterna och hitta inte på något. Ingen hälsningsfras eller signatur.';
    // Claude får bara läsverktygen (alla tokens är skrivskyddade); ingen token kan skicka mejl
    const mcp = await checkMcp();
    console.log(`kontrollerar med: ${mcp.map(m => path.basename(m)).join(', ') || 'inga verktyg'}`);
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TZ: process.env.TZ, MCP_TIMEOUT: '60000',
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      ...Object.fromEntries(CHECK_ENV.filter(v => process.env[v]).map(v => [v, process.env[v]])) };
    const exit = await new Promise(resolve => {
      const child = spawn('claude', [...(mcp.length ? ['--mcp-config', ...mcp] : []), '--strict-mcp-config', '--dangerously-skip-permissions', '-p', prompt],
        { cwd: WORK, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const add = b => { log += b.toString(); process.stdout.write(b); };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      child.on('error', e => { log += `\n${e.message}\n`; resolve(127); });
      child.on('close', code => resolve(code ?? 1));
    });
    summary = await fs.readFile(path.join(WORK, 'morgonmejl.md'), 'utf8').catch(() => '');
    if (exit !== 0 || !summary.trim()) summary = `*Kunde inte sammanfatta (exit ${exit}), rapporterna följer nedan.*`;
    await markDone(sources);
  }

  // Rapporterna i sin helhet, med rubrikerna två nivåer ned så att de hamnar under jobbets rubrik
  const reports = sources.map(s => `## ${s.task}\n\n${s.content.slice(0, MAX_REPORT).replace(/^(#{1,4}) /gm, '$1## ')}`)
    .join('\n\n---\n\n');
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

// Google-inloggningarna (bara läsbehörighet för Gmail) och de MCP-servrar som går att använda
async function checkMcp() {
  for (const [name, emailVar] of [['google', 'GOOGLE_EMAIL'], ['google-work', 'GOOGLE_WORK_EMAIL']]) {
    const email = process.env[emailVar];
    if (!email) continue;
    try {
      await fs.mkdir(`${DATA}/${name}`, { recursive: true });
      await fs.writeFile(`${DATA}/${name}/${email}.json`, await fs.readFile(`/secrets/${name}/creds.json`), { mode: 0o600 });
    } catch { /* kontot är inte inloggat i molnet */ }
  }
  const out = [];
  for (const [name, vars] of CHECK_MCP) {
    const cfg = `/mcp/${name}.read.json`;
    if (vars.every(v => process.env[v]) && await fs.access(cfg).then(() => true, () => false)) out.push(cfg);
  }
  return out;
}

// Bockar av punkterna som Claude såg var gjorda, i mejlet och i rapporterna i webbappen.
// Bara bocken ändras, så längden är densamma och runner.mjs laddar inte upp filen igen.
async function markDone(sources) {
  const done = await fs.readFile(path.join(WORK, 'klara.json'), 'utf8').then(JSON.parse, () => []);
  const norm = t => String(t).trim().replace(/\s+/g, ' ');
  const set = new Set((Array.isArray(done) ? done : []).map(norm));
  if (!set.size) return;
  for (const s of sources) {
    const lines = s.content.split('\n');
    let changed = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = TODO_RE.exec(lines[i]);
      if (m && m[2] === ' ' && set.has(norm(m[4]))) { lines[i] = `${m[1]}x${m[3]}${m[4]}`; changed++; }
    }
    if (!changed) continue;
    const content = lines.join('\n');
    const id = `${s.task}__${Buffer.from(s.path).toString('base64url')}`;
    await db.runTransaction(async tx => {
      const cur = (await tx.get(db.doc(`files/${id}`))).data();
      if (cur?.content === s.content) tx.update(db.doc(`files/${id}`), { content });
    });
    s.content = content;
    console.log(`bockade av ${changed} punkter i ${s.task}/${s.path}`);
  }
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
