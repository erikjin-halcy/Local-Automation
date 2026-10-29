// Molnagent för Local-Automation. Körs på Macen och ansluter bara utåt till Firestore.
//  - speglar uppgifter från molnet till tasks/*.md och uppdaterar scheman
//  - startar körningar när webbappen begär det
//  - laddar upp körningar (status + Claudes svar) och resultatfiler från work/
// Startas med: node agent/agent.mjs   (eller automatiskt via agent/install-agent.sh)

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import {
  getFirestore, collection, doc, query, where, onSnapshot, getDocs,
  setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, deleteField,
} from 'firebase/firestore';
import { firebaseConfig } from '../ui/public/firebase-config.js';
import {
  ROOT, TASKS, WORK, LOGS, NAME_RE, parseTask, serializeTask, listMcp, exists, isRunning, listRuns,
  checkSchedule, syncSchedules, startRun, status, listFiles, validInput, validMcp, renameTask,
} from '../ui/lib.mjs';

const RUN_KEEP = 20;            // antal senaste körningar per uppgift som laddas upp
const MAX_LOG = 200_000;        // tecken
const MAX_UPLOAD = 256_000;     // byte per fil
const MAX_FILES = 50;           // filer per uppgift
const SCAN_MS = 10_000;
const HEARTBEAT_MS = 60_000;

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function readEnv() {
  const text = await fs.readFile(path.join(ROOT, '.env'), 'utf8');
  return Object.fromEntries(text.split('\n')
    .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));
}

const env = await readEnv();
if (!env.FIREBASE_AGENT_EMAIL || !env.FIREBASE_AGENT_PASSWORD) {
  console.error('FIREBASE_AGENT_EMAIL/FIREBASE_AGENT_PASSWORD saknas i .env – kör agent/setup.sh');
  process.exit(1);
}

const app = initializeApp(firebaseConfig);
await signInWithEmailAndPassword(getAuth(app), env.FIREBASE_AGENT_EMAIL, env.FIREBASE_AGENT_PASSWORD);
const db = getFirestore(app);
log('inloggad som agent i', firebaseConfig.projectId);

const taskFile = name => path.join(TASKS, `${name}.md`);
const b64url = s => Buffer.from(s).toString('base64url');

async function localTaskNames() {
  const files = await fs.readdir(TASKS).catch(() => []);
  return files.filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).filter(n => NAME_RE.test(n));
}

function setState(name, patch) {
  return setDoc(doc(db, 'taskState', name), { ...patch, updatedAt: serverTimestamp() }, { merge: true });
}

// Allt som ändrar lokala filer körs i tur och ordning
let queue = Promise.resolve();
const enqueue = fn => { queue = queue.then(fn).catch(e => log('fel:', e.message)); return queue; };

let syncTimer;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    const r = await syncSchedules();
    log('scheman:', r.out.replace(/\n/g, ' | '));
  }, 1000);
}

// ---------- uppgifter: molnet -> tasks/ ----------

async function applyTask(snap) {
  const name = snap.id;
  const t = snap.data();
  if (!NAME_RE.test(name)) return;

  let err = validInput(t) || await validMcp(t.mcp || []);
  if (!err) {
    const c = await checkSchedule(t.schedule.trim());
    if (!c.ok) err = c.out || 'ogiltigt schema';
  }
  if (err) { log(name, 'ogiltig:', err); return setState(name, { error: err }); }

  // Namnbyte: flytta loggar och filer lokalt och städa bort det gamla namnet i molnet
  const from = t.renamedFrom;
  if (from && from !== name && NAME_RE.test(from) && await exists(taskFile(from))) {
    try { await renameTask(from, name); } catch (e) { return setState(name, { error: e.message }); }
    await removeCloudData(from);
    log('bytte namn:', from, '->', name);
  }
  if (from) await updateDoc(snap.ref, { renamedFrom: deleteField() });

  const text = serializeTask({ schedule: t.schedule.trim(), enabled: !!t.enabled, mcp: t.mcp || [], prompt: t.prompt });
  if (await fs.readFile(taskFile(name), 'utf8').catch(() => null) !== text) {
    await fs.writeFile(taskFile(name), text);
    log('uppdaterade', name);
    scheduleSync();
  }
  await setState(name, { error: null });
  filesDirty.add(name);
}

async function removeTask(name) {
  if (!NAME_RE.test(name)) return;
  if (await exists(taskFile(name))) {
    await fs.unlink(taskFile(name));
    log('tog bort', name, '(loggar och filer finns kvar lokalt)');
    scheduleSync();
  }
  await removeCloudData(name);
}

async function removeCloudData(name) {
  const refs = [];
  for (const c of ['runs', 'files']) {
    const s = await getDocs(query(collection(db, c), where('task', '==', name)));
    refs.push(...s.docs.map(d => d.ref));
  }
  refs.push(doc(db, 'taskState', name));
  for (let i = 0; i < refs.length; i += 400) {
    const batch = writeBatch(db);
    refs.slice(i, i + 400).forEach(r => batch.delete(r));
    await batch.commit();
  }
  for (const k of [...runSigs.keys(), ...fileSigs.keys()]) {
    if (k.startsWith(`${name}__`)) { runSigs.delete(k); fileSigs.delete(k); }
  }
  stateSigs.delete(name);
}

let firstTasks = true;
async function handleTasks(snap) {
  if (firstTasks) {
    firstTasks = false;
    // Första gången: ladda upp lokala uppgifter som inte finns i molnet än
    const inCloud = new Set(snap.docs.map(d => d.id));
    for (const name of await localTaskNames()) {
      if (inCloud.has(name)) continue;
      const t = parseTask(await fs.readFile(taskFile(name), 'utf8'));
      await setDoc(doc(db, 'tasks', name), { ...t, updatedAt: serverTimestamp() });
      log('laddade upp lokal uppgift', name);
    }
  }
  // Tillägg och ändringar före borttagningar, så att namnbyten hinner flytta filerna
  const changes = snap.docChanges().sort((a, b) => (a.type === 'removed') - (b.type === 'removed'));
  for (const c of changes) {
    if (c.type === 'removed') await removeTask(c.doc.id);
    else await applyTask(c.doc);
  }
}

// ---------- körningar på begäran ----------

async function handleRequest(snap) {
  const { task } = snap.data();
  const reply = (s, error = null) => updateDoc(snap.ref, { status: s, error, handledAt: serverTimestamp() });
  if (!NAME_RE.test(task || '') || !await exists(taskFile(task))) return reply('rejected', 'uppgiften finns inte på Macen');
  if (!await startRun(task)) return reply('rejected', 'uppgiften körs redan');
  log('startade', task);
  await reply('started');
  setTimeout(scan, 2000);
}

// ---------- körningar och filer: lokalt -> molnet ----------

const runSigs = new Map();    // runs/<id>  -> signatur av det som laddats upp
const fileSigs = new Map();   // files/<id> -> signatur
const stateSigs = new Map();  // uppgift    -> signatur av running/lastRun
const filesDirty = new Set();

async function readLog(name, id) {
  const text = await fs.readFile(path.join(LOGS, name, `${id}.log`), 'utf8').catch(() => '');
  return text.length > MAX_LOG ? '… (början av loggen är bortklippt)\n' + text.slice(-MAX_LOG) : text;
}

async function syncFiles(name) {
  const files = (await listFiles(path.join(WORK, name))).slice(0, MAX_FILES);
  const keep = new Set();
  for (const f of files) {
    const id = `${name}__${b64url(f.path)}`;
    keep.add(id);
    const sig = `${f.modified}|${f.size}`;
    if (fileSigs.get(id) === sig) continue;
    let content = null, note = null;
    if (f.size > MAX_UPLOAD) note = 'för stor för att laddas upp';
    else {
      const buf = await fs.readFile(path.join(WORK, name, f.path));
      if (buf.includes(0)) note = 'binärfil, laddas inte upp';
      else content = buf.toString('utf8');
    }
    await setDoc(doc(db, 'files', id), { task: name, path: f.path, size: f.size, modified: f.modified, content, note });
    fileSigs.set(id, sig);
  }
  for (const id of [...fileSigs.keys()]) {
    if (id.startsWith(`${name}__`) && !keep.has(id)) {
      await deleteDoc(doc(db, 'files', id));
      fileSigs.delete(id);
    }
  }
}

let scanning = false;
async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    for (const name of await localTaskNames()) {
      const runs = await listRuns(name, RUN_KEEP);
      for (const r of runs) {
        const id = `${name}__${r.id}`;
        const logText = await readLog(name, r.id);
        const sig = `${r.exit}|${r.running}|${logText.length}`;
        if (runSigs.get(id) === sig) continue;
        await setDoc(doc(db, 'runs', id), {
          task: name, id: r.id, start: r.start, exit: r.exit, running: r.running, log: logText,
          updatedAt: serverTimestamp(),
        });
        runSigs.set(id, sig);
        if (!r.running) filesDirty.add(name);
      }
      const running = await isRunning(name);
      const lastRun = runs[0] || null;
      const sig = JSON.stringify({ running, lastRun });
      if (stateSigs.get(name) !== sig) {
        await setState(name, { running, lastRun });
        stateSigs.set(name, sig);
      }
    }
    for (const name of [...filesDirty]) {
      filesDirty.delete(name);
      await syncFiles(name);
    }
  } catch (e) {
    log('fel vid uppladdning:', e.message);
  } finally {
    scanning = false;
  }
}

// ---------- agentens status ----------

async function heartbeat() {
  try {
    await setDoc(doc(db, 'agent', 'status'), {
      ...await status(), mcp: await listMcp(), host: os.hostname(), lastSeen: serverTimestamp(),
    });
    // Städa bort hanterade körbegäranden äldre än en timme
    const old = await getDocs(query(collection(db, 'runRequests'), where('status', 'in', ['started', 'rejected'])));
    const cutoff = Date.now() - 3600_000;
    for (const d of old.docs) {
      if ((d.data().handledAt?.toMillis?.() ?? 0) < cutoff) await deleteDoc(d.ref);
    }
  } catch (e) {
    log('fel vid statusuppdatering:', e.message);
  }
}

// ---------- start ----------

// Hämta det som redan finns i molnet så att bara ändringar laddas upp
for (const d of (await getDocs(collection(db, 'runs'))).docs) {
  const r = d.data();
  runSigs.set(d.id, `${r.exit}|${r.running}|${(r.log || '').length}`);
}
for (const d of (await getDocs(collection(db, 'files'))).docs) {
  const f = d.data();
  fileSigs.set(d.id, `${f.modified}|${f.size}`);
}
for (const name of await localTaskNames()) filesDirty.add(name);

onSnapshot(collection(db, 'tasks'), snap => enqueue(() => handleTasks(snap)),
  e => log('fel i uppgiftslyssnare:', e.message));
onSnapshot(query(collection(db, 'runRequests'), where('status', '==', 'pending')), snap => {
  for (const c of snap.docChanges()) if (c.type === 'added') enqueue(() => handleRequest(c.doc));
}, e => log('fel i körlyssnare:', e.message));

await heartbeat();
setInterval(heartbeat, HEARTBEAT_MS);
setInterval(scan, SCAN_MS);
scan();
log('agenten körs');
