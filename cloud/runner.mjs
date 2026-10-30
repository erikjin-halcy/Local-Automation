// Cloud Run Job: kör en uppgift en gång. Uppgiftens namn kommer i miljövariabeln TASK.
//  1. läser uppgift och profil från Firestore och tar ett lås på uppgiften
//  2. hämtar uppgiftens filer från Firestore till /work (arbetsytan mellan körningar)
//  3. hämtar Apple Notes och Obsidian-valv från Cloud Storage om uppgiften har notes/obsidian
//  4. kör Claude med de MCP-servrar uppgiften valt
//  5. sparar körningen, status och de nya filerna i Firestore; ändringar i anteckningar
//     läggs i outbox så att sync/sync.mjs på Macen för in dem

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { Storage } from '@google-cloud/storage';
import { cleanProfile, profileText } from './lib.mjs';

const TASK = process.env.TASK || '';
const WORK = '/work';
const DATA = '/data';
const MAX_LOG = 200_000;
const MAX_UPLOAD = 256_000;
const MAX_FILES = 50;
const LOCK_MS = 40 * 60_000;
const NAME_RE = /^[A-Za-z0-9_-]+$/;
// Tjänster som är synkade filer istället för MCP-servrar (se sync/sync.mjs)
const FILE_AREAS = { notes: '/notes', obsidian: '/obsidian' };
const MAX_OUTBOX = 5_000_000;

// Morgonmejlet körs av samma jobb, se digest.mjs
if (process.env.MODE === 'digest') { await import('./digest.mjs'); process.exit(0); }
if (!NAME_RE.test(TASK)) { console.error('TASK saknas eller är ogiltig'); process.exit(2); }

initializeApp();
const db = getFirestore();
const b64url = s => Buffer.from(s).toString('base64url');

const taskSnap = await db.doc(`tasks/${TASK}`).get();
if (!taskSnap.exists) { console.error(`uppgiften ${TASK} finns inte`); process.exit(2); }
const task = taskSnap.data();
const profile = cleanProfile((await db.doc('profile/me').get()).data() || {});

// Tid och körnings-id i användarens tidszon, samma format som lokalt (ÅÅÅÅ-MM-DD_HHMMSS)
process.env.TZ = profile.timezone || 'UTC';
const now = new Date();
const p2 = n => String(n).padStart(2, '0');
const runId = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}_${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
const start = runId.replace(/^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})$/, '$1T$2:$3:$4');

// Lås: hoppa över om samma uppgift redan körs
const stateRef = db.doc(`taskState/${TASK}`);
const locked = await db.runTransaction(async tx => {
  const s = (await tx.get(stateRef)).data() || {};
  if (s.running && Date.now() - (s.lockedAt?.toMillis?.() ?? 0) < LOCK_MS) return false;
  tx.set(stateRef, {
    running: true, lockedAt: FieldValue.serverTimestamp(), error: null,
    lastRun: { id: runId, start, exit: null, running: true }, updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return true;
});
if (!locked) { console.log(`${TASK} körs redan`); process.exit(0); }

const runRef = db.doc(`runs/${TASK}__${runId}`);
await runRef.set({ task: TASK, id: runId, start, exit: null, running: true, log: '', updatedAt: FieldValue.serverTimestamp() });

// ---------- arbetsytan ----------

async function listFiles(dir, base = dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await listFiles(full, base, out);
    else if (e.isFile()) {
      const st = await fs.stat(full);
      out.push({ path: path.relative(base, full), size: st.size, modified: st.mtime.toISOString() });
    }
  }
  return out;
}

const before = new Map();
for (const d of (await db.collection('files').where('task', '==', TASK).get()).docs) {
  const f = d.data();
  before.set(d.id, f);
  if (f.content == null) continue;
  const full = path.resolve(WORK, f.path);
  if (!full.startsWith(WORK + path.sep)) continue;
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, f.content);
  if (f.modified) await fs.utimes(full, new Date(f.modified), new Date(f.modified)).catch(() => {});
}

// ---------- Apple Notes och Obsidian ----------

const md5 = buf => crypto.createHash('md5').update(buf).digest('hex');
const areas = (task.mcp || []).filter(m => FILE_AREAS[m.name]);
const bucket = process.env.NOTES_BUCKET ? new Storage().bucket(process.env.NOTES_BUCKET) : null;
const snapshot = new Map(); // "<område>/<sökväg>" -> md5 när körningen började
let syncMeta = null;
if (areas.length && !bucket) console.error('NOTES_BUCKET saknas – notes/obsidian är inte tillgängliga');
if (areas.length && bucket) {
  syncMeta = await bucket.file('snapshot/meta.json').download().then(([b]) => JSON.parse(b), () => null);
  for (const m of areas) {
    const root = FILE_AREAS[m.name];
    const prefix = `snapshot/${m.name}/`;
    const [objects] = await bucket.getFiles({ prefix });
    for (let i = 0; i < objects.length; i += 16) {
      await Promise.all(objects.slice(i, i + 16).map(async o => {
        const rel = o.name.slice(prefix.length);
        const full = path.resolve(root, rel);
        if (!rel || rel.endsWith('/') || !full.startsWith(root + path.sep)) return;
        const [buf] = await o.download();
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, buf);
        snapshot.set(`${m.name}/${rel}`, md5(buf));
      }));
    }
    if (m.level !== 'write') await makeReadOnly(root);
    console.log(`${m.name}: ${objects.length} filer (${m.level === 'write' ? 'läsa + skriva' : 'läsa'})`);
  }
}

async function makeReadOnly(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await makeReadOnly(full);
    else await fs.chmod(full, 0o444);
  }
  await fs.chmod(dir, 0o555).catch(() => {});
}

function areaPrompt() {
  const synced = syncMeta?.syncedAt ? ` Kopian synkades från min Mac ${syncMeta.syncedAt}.` : '';
  const later = 'Ändringarna förs över till min Mac inom ungefär 10 minuter.';
  return areas.map(m => {
    const write = m.level === 'write';
    if (m.name === 'notes') return `Apple Notes: mina anteckningar finns som filer i /notes/<konto>/<mapp>/<titel>.md.${synced} ` +
      'Varje fil börjar med frontmatter (id, account, folder, created, modified, attachments) som du inte ska ändra. ' +
      (write ? 'Du får ändra befintliga filer för att uppdatera en anteckning, och skapa nya .md-filer (utan frontmatter) i en mappkatalog för nya anteckningar. ' +
        'Första raden blir titeln. Allt sparas som ren text, så formatering försvinner; anteckningar med bilagor skrivs aldrig över – då skapas en ny anteckning istället. ' +
        `Att ta bort en fil tar inte bort anteckningen. ${later}` : 'Katalogen är skrivskyddad.');
    const vaults = syncMeta?.vaults?.length ? ` (${syncMeta.vaults.map(v => `/obsidian/${v}`).join(', ')})` : '';
    return `Obsidian: mina valv finns i /obsidian/<valv>/${vaults}.${synced} ` +
      (write ? 'Du får skapa, ändra och ta bort markdown-filer. Följ valvets befintliga mappstruktur och använd [[wikilänkar]] mellan anteckningar. ' +
        `Borttagna filer hamnar i valvets .trash. ${later}` : 'Valven är skrivskyddade.');
  }).join('\n');
}

// Jämför /notes och /obsidian med kopian och lägger ändringarna i outbox
async function collectChanges() {
  const changes = [];
  for (const m of areas.filter(a => a.level === 'write')) {
    const root = FILE_AREAS[m.name];
    const seen = new Set();
    for (const f of await listFiles(root)) {
      const key = `${m.name}/${f.path}`;
      const buf = await fs.readFile(path.join(root, f.path));
      if (buf.includes(0)) continue;
      seen.add(key);
      const base = snapshot.get(key);
      if (md5(buf) !== base) changes.push({ area: m.name, path: f.path, op: 'put', content: buf.toString('utf8'), baseMd5: base ?? null });
    }
    for (const [key, base] of snapshot) {
      if (key.startsWith(`${m.name}/`) && !seen.has(key)) {
        changes.push({ area: m.name, path: key.slice(m.name.length + 1), op: 'delete', baseMd5: base });
      }
    }
  }
  return changes;
}

// ---------- MCP och inloggningar ----------

await fs.mkdir(`${DATA}/slack`, { recursive: true });
for (const [name, emailVar] of [['google', 'GOOGLE_EMAIL'], ['google-work', 'GOOGLE_WORK_EMAIL']]) {
  const src = `/secrets/${name}/creds.json`;
  const email = process.env[emailVar];
  if (!email) continue;
  try {
    await fs.mkdir(`${DATA}/${name}`, { recursive: true });
    // Hemligheten är skrivskyddad; kopian måste vara skrivbar så att förnyade tokens kan sparas
    await fs.writeFile(`${DATA}/${name}/${email}.json`, await fs.readFile(src), { mode: 0o600 });
  } catch { /* kontot är inte inloggat i molnet */ }
}

const mcpArgs = [];
for (const m of task.mcp || []) {
  if (FILE_AREAS[m.name]) continue;
  const cfg = `/mcp/${m.name}.${m.level === 'write' ? 'write' : 'read'}.json`;
  try { await fs.access(cfg); mcpArgs.push(cfg); } catch { console.error(`okänd MCP-server: ${m.name}`); }
}

// ---------- kör Claude ----------

const intro = profileText(profile);
// Åtgärder i rapporterna blir en checklista som går att bocka av i webbappen (samma text som i run.sh)
const format = 'Format: Om du skriver en rapport till /work, skriv det som kräver svar eller åtgärd från mig som en checklista i markdown, en punkt per sak: `- [ ] Vad som ska göras (vem det gäller, eventuell deadline)`. Använd checklistan bara för sådant som faktiskt kräver en åtgärd. Skriv datum som ÅÅÅÅ-MM-DD (t.ex. 2026-10-30), även i rubriker och filnamn.';
const files = areas.length && bucket ? `\n\n${areaPrompt()}` : '';
const prompt = `${intro ? `${intro}\nUppgift:\n` : ''}${task.prompt}\n\n${format}${files}`;
const args = [
  ...(mcpArgs.length ? ['--mcp-config', ...mcpArgs] : []),
  '--strict-mcp-config', '--dangerously-skip-permissions', '-p', prompt,
];

let log = `=== ${TASK} ${new Date().toString()} ===\n`;
const exit = await new Promise(resolve => {
  const child = spawn('claude', args, { cwd: WORK, env: { ...process.env, MCP_TIMEOUT: '60000' } });
  const add = b => { log += b.toString(); process.stdout.write(b); };
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  child.on('error', e => { log += `\n${e.message}\n`; resolve(127); });
  child.on('close', code => resolve(code ?? 1));
});
if (areas.length && bucket) {
  try {
    const changes = await collectChanges();
    if (changes.length) {
      const body = JSON.stringify({ task: TASK, runId, createdAt: new Date().toISOString(), changes });
      if (body.length > MAX_OUTBOX) throw new Error(`för stora ändringar (${body.length} byte)`);
      await bucket.file(`outbox/${runId}__${TASK}.json`).save(body, { contentType: 'application/json' });
      // Uppdatera kopian direkt så att nästa körning ser ändringarna innan Macen har synkat
      await Promise.all(changes.map(c => c.op === 'put'
        ? bucket.file(`snapshot/${c.area}/${c.path}`).save(c.content)
        : bucket.file(`snapshot/${c.area}/${c.path}`).delete({ ignoreNotFound: true })));
      log += `\n=== ändringar till Macen: ${changes.map(c => `${c.op === 'put' ? '✎' : '✕'} ${c.area}/${c.path}`).join(', ')} ===\n`;
    }
  } catch (e) {
    log += `\n=== kunde inte spara ändringar i anteckningar: ${e.message} ===\n`;
  }
}
log += `=== exit ${exit} ===\n`;
if (log.length > MAX_LOG) log = '… (början av loggen är bortklippt)\n' + log.slice(-MAX_LOG);

// ---------- spara resultat ----------

const keep = new Set();
const batch = db.batch();
for (const f of (await listFiles(WORK)).slice(0, MAX_FILES)) {
  const id = `${TASK}__${b64url(f.path)}`;
  keep.add(id);
  const old = before.get(id);
  if (old && old.size === f.size && old.modified === f.modified) continue;
  let content = null, note = null;
  if (f.size > MAX_UPLOAD) note = 'för stor för att laddas upp';
  else {
    const buf = await fs.readFile(path.join(WORK, f.path));
    if (buf.includes(0)) note = 'binärfil, laddas inte upp';
    else content = buf.toString('utf8');
  }
  batch.set(db.doc(`files/${id}`), { task: TASK, path: f.path, size: f.size, modified: f.modified, content, note });
}
for (const id of before.keys()) if (!keep.has(id)) batch.delete(db.doc(`files/${id}`));
batch.set(runRef, { exit, running: false, log, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
batch.set(stateRef, {
  running: false, lockedAt: null, lastRun: { id: runId, start, exit, running: false },
  updatedAt: FieldValue.serverTimestamp(),
}, { merge: true });
await batch.commit();

console.log(`klar: ${TASK} exit ${exit}`);
process.exit(exit === 0 ? 0 : 1);
