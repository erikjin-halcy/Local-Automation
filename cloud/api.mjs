// Cloud Run-tjänst som webbappen anropar. Kontrollerar att anroparen är ägaren
// (Firebase ID-token från Google-inloggning) och:
//   POST /run  {task}  startar Cloud Run-jobbet för en uppgift
//   POST /sync         synkar Cloud Scheduler med uppgifterna i Firestore,
//                      hanterar namnbyten och städar bort borttagna uppgifter

import http from 'node:http';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { sendMail } from './mail.mjs';

const PROJECT = process.env.PROJECT;
const REGION = process.env.REGION;                   // jobbets region
const SCHEDULER_REGION = process.env.SCHEDULER_REGION;
const JOB = process.env.JOB;
const SCHEDULER_SA = process.env.SCHEDULER_SA;
const OWNER_EMAIL = process.env.OWNER_EMAIL;
const API_URL = process.env.API_URL;           // den här tjänstens adress, mottagare för körningens ID-token
const RUNNER_SA = process.env.RUNNER_SA;
const MAX_MAILS_PER_DAY = 5;
const ORIGINS = new Set([`https://${PROJECT}.web.app`, `https://${PROJECT}.firebaseapp.com`]);
const NAME_RE = /^[A-Za-z0-9_-]+$/;
const PREFIX = 'la-task-';

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const google = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

async function gapi(method, url, body) {
  const client = await google.getClient();
  const res = await client.request({ method, url, data: body, validateStatus: () => true });
  if (res.status >= 400) throw new Error(`${method} ${url.split('?')[0]}: ${res.status} ${res.data?.error?.message || ''}`);
  return res.data;
}

const runUrl = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}:run`;
const runBody = task => ({ overrides: { containerOverrides: [{ env: [{ name: 'TASK', value: task }] }] } });
// Morgonmejlet körs av samma jobb med MODE=digest (cloud/digest.mjs); FORCE skickar även när det är avstängt
const digestBody = (force = false) => ({ overrides: { containerOverrides: [{ env: [
  { name: 'MODE', value: 'digest' }, ...(force ? [{ name: 'FORCE', value: '1' }] : []),
] }] } });
const DIGEST_JOB = 'la-digest';
// Veckoarkivet (cloud/archive.mjs) arkiverar Firestore-rapporter från avslutade veckor, måndagar 00:30
const ARCHIVE_JOB = 'la-archive';
const ARCHIVE_SCHEDULE = '30 0 * * 1';
const archiveBody = { overrides: { containerOverrides: [{ env: [{ name: 'MODE', value: 'archive' }] }] } };
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------- schema -> cron (samma format som install.sh) ----------

const WEEKDAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function toCron(s) {
  const p = (s || '').trim().split(/\s+/);
  const time = t => {
    const m = (t || '').match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!m) throw new Error(`ogiltig tid '${t || ''}'`);
    return `${Number(m[2])} ${Number(m[1])}`;
  };
  switch (p[0]) {
    case 'every': {
      const m = (p[1] || '').match(/^(\d+)([smhSMH]?)$/);
      if (!m) throw new Error(`ogiltigt intervall '${p[1] || ''}'`);
      const u = (m[2] || 's').toLowerCase();
      const secs = Number(m[1]) * (u === 'h' ? 3600 : u === 'm' ? 60 : 1);
      if (secs < 60) throw new Error('intervallet måste vara minst 60 sekunder');
      const mins = Math.round(secs / 60);
      if (mins < 60) return `*/${mins} * * * *`;
      const hours = Math.round(mins / 60);
      if (hours < 24) return `0 */${hours} * * *`;
      return `0 0 */${Math.round(hours / 24)} * *`;
    }
    case 'daily': return `${time(p[1])} * * *`;
    case 'weekdays': return `${time(p[1])} * * 1-5`;
    case 'weekly': {
      const days = (p[1] || '').split(',').map(d => {
        if (!(d in WEEKDAY)) throw new Error(`ogiltig veckodag '${d}'`);
        return WEEKDAY[d];
      });
      return `${time(p[2])} * * ${days.join(',')}`;
    }
    default: throw new Error(`okänt schema '${s}'`);
  }
}

// ---------- synk ----------

async function moveTaskData(from, to) {
  const batch = db.batch();
  for (const c of ['runs', 'files']) {
    for (const d of (await db.collection(c).where('task', '==', from).get()).docs) {
      batch.set(db.doc(`${c}/${to}__${d.id.slice(from.length + 2)}`), { ...d.data(), task: to });
      batch.delete(d.ref);
    }
  }
  const st = await db.doc(`taskState/${from}`).get();
  if (st.exists) { batch.set(db.doc(`taskState/${to}`), st.data(), { merge: true }); batch.delete(st.ref); }
  await batch.commit();
}

async function removeTaskData(name) {
  const refs = [db.doc(`taskState/${name}`)];
  for (const c of ['runs', 'files']) refs.push(...(await db.collection(c).where('task', '==', name).get()).docs.map(d => d.ref));
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    refs.slice(i, i + 400).forEach(r => batch.delete(r));
    await batch.commit();
  }
}

async function sync() {
  const tasks = new Map((await db.collection('tasks').get()).docs.map(d => [d.id, d]));
  const profile = (await db.doc('profile/me').get()).data() || {};
  const timeZone = profile.timezone || 'Etc/UTC';
  const done = [];

  // Namnbyten: flytta körningar, filer och status till det nya namnet
  for (const [name, d] of tasks) {
    const from = d.data().renamedFrom;
    if (from && NAME_RE.test(from) && from !== name) await moveTaskData(from, name);
    if (from) await d.ref.update({ renamedFrom: FieldValue.delete() });
  }

  // Data för uppgifter som har tagits bort
  const known = new Set((await db.collection('taskState').get()).docs.map(d => d.id));
  for (const name of known) if (!tasks.has(name)) { await removeTaskData(name); done.push(`tog bort ${name}`); }

  const base = `https://cloudscheduler.googleapis.com/v1/projects/${PROJECT}/locations/${SCHEDULER_REGION}/jobs`;
  const schedulerJob = (id, description, schedule, body) => ({
    name: `projects/${PROJECT}/locations/${SCHEDULER_REGION}/jobs/${id}`,
    description, schedule, timeZone,
    attemptDeadline: '60s',
    httpTarget: {
      uri: runUrl, httpMethod: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(body)).toString('base64'),
      oauthToken: { serviceAccountEmail: SCHEDULER_SA, scope: 'https://www.googleapis.com/auth/cloud-platform' },
    },
  });
  const existing = new Map(((await gapi('GET', `${base}?pageSize=500`)).jobs || [])
    .filter(j => j.name.split('/').pop().startsWith(PREFIX))
    .map(j => [j.name.split('/').pop().slice(PREFIX.length), j]));

  for (const [name, d] of tasks) {
    const t = d.data();
    if (!NAME_RE.test(name) || !t.enabled) continue;
    let schedule;
    try { schedule = toCron(t.schedule); }
    catch (e) { await db.doc(`taskState/${name}`).set({ error: e.message }, { merge: true }); continue; }
    const job = schedulerJob(`${PREFIX}${name}`, `Local Automation: ${name} (${t.schedule})`, schedule, runBody(name));
    const cur = existing.get(name);
    if (!cur) { await gapi('POST', base, job); done.push(`schemalade ${name}: ${schedule}`); }
    else if (cur.schedule !== schedule || cur.timeZone !== timeZone || cur.httpTarget?.uri !== runUrl) {
      await gapi('PATCH', `${base}/${PREFIX}${name}`, job);
      done.push(`uppdaterade ${name}: ${schedule}`);
    }
    await db.doc(`taskState/${name}`).set({ error: null }, { merge: true });
    existing.delete(name);
  }
  for (const name of existing.keys()) { await gapi('DELETE', `${base}/${PREFIX}${name}`); done.push(`tog bort schema ${name}`); }

  // Morgonmejlet: ett eget schema när det är påslaget i profilen
  const d = profile.digest || {};
  const cur = (await gapi('GET', `${base}?pageSize=500`)).jobs?.find(j => j.name.endsWith(`/${DIGEST_JOB}`));
  if (d.enabled && TIME_RE.test(d.time || '')) {
    const schedule = toCron(`daily ${d.time}`);
    const job = schedulerJob(DIGEST_JOB, `Local Automation: morgonmejl (${d.time})`, schedule, digestBody());
    if (!cur) { await gapi('POST', base, job); done.push(`schemalade morgonmejl: ${schedule}`); }
    else if (cur.schedule !== schedule || cur.timeZone !== timeZone || cur.httpTarget?.uri !== runUrl) {
      await gapi('PATCH', `${base}/${DIGEST_JOB}`, job);
      done.push(`uppdaterade morgonmejl: ${schedule}`);
    }
  } else if (cur) { await gapi('DELETE', `${base}/${DIGEST_JOB}`); done.push('tog bort morgonmejlet'); }

  // Veckoarkivet: alltid på
  const arch = (await gapi('GET', `${base}?pageSize=500`)).jobs?.find(j => j.name.endsWith(`/${ARCHIVE_JOB}`));
  const archJob = schedulerJob(ARCHIVE_JOB, 'Local Automation: veckoarkiv (måndagar 00:30)', ARCHIVE_SCHEDULE, archiveBody);
  if (!arch) { await gapi('POST', base, archJob); done.push(`schemalade veckoarkivet: ${ARCHIVE_SCHEDULE}`); }
  else if (arch.schedule !== ARCHIVE_SCHEDULE || arch.timeZone !== timeZone || arch.httpTarget?.uri !== runUrl) {
    await gapi('PATCH', `${base}/${ARCHIVE_JOB}`, archJob);
    done.push(`uppdaterade veckoarkivet: ${ARCHIVE_SCHEDULE}`);
  }
  return done;
}

async function run(task) {
  if (!NAME_RE.test(task || '')) throw Object.assign(new Error('ogiltigt namn'), { code: 400 });
  if (!(await db.doc(`tasks/${task}`).get()).exists) throw Object.assign(new Error('uppgiften finns inte'), { code: 404 });
  const s = (await db.doc(`taskState/${task}`).get()).data() || {};
  if (s.running && Date.now() - (s.lockedAt?.toMillis?.() ?? 0) < 40 * 60_000) {
    throw Object.assign(new Error('uppgiften körs redan'), { code: 409 });
  }
  await gapi('POST', runUrl, runBody(task));
  return { started: true };
}

// ---------- HTTP ----------

// gcloud:s egen OAuth-klient; används när cloud/deploy.sh synkar med
// `gcloud auth print-identity-token` som ägaren
const GCLOUD_CLIENT_ID = '32555940559.apps.googleusercontent.com';
const oauth = new OAuth2Client();

async function owner(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return false;
  try {
    const t = await getAuth().verifyIdToken(token);
    return t.email === OWNER_EMAIL && t.email_verified && t.firebase?.sign_in_provider === 'google.com';
  } catch { /* inte en Firebase-token */ }
  try {
    const t = (await oauth.verifyIdToken({ idToken: token, audience: GCLOUD_CLIENT_ID })).getPayload();
    return t.email === OWNER_EMAIL && t.email_verified === true;
  } catch { return false; }
}

// Körningen i Cloud Run (servicekontot la-runner) med ett ID-token från metadataservern
async function runner(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token || !API_URL || !RUNNER_SA) return false;
  try {
    const t = (await oauth.verifyIdToken({ idToken: token, audience: API_URL })).getPayload();
    return t.email === RUNNER_SA && t.email_verified === true;
  } catch { return false; }
}

// Skickar dagens morgonmejl till ägaren. Mottagaren är alltid OWNER_EMAIL, så även
// om någon annan än körningen lyckas anropa detta kan mejlet bara gå till ägaren.
async function sendDigest(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw Object.assign(new Error('ogiltigt datum'), { code: 400 });
  const ref = db.doc(`digests/${date}`);
  const d = await db.runTransaction(async tx => {
    const d = (await tx.get(ref)).data();
    if (!d || d.status !== 'ready' || typeof d.markdown !== 'string') throw Object.assign(new Error('inget mejl att skicka'), { code: 409 });
    if ((d.mails || 0) >= MAX_MAILS_PER_DAY) throw Object.assign(new Error('för många mejl i dag'), { code: 429 });
    tx.update(ref, { status: 'sending', mails: (d.mails || 0) + 1 });
    return d;
  });
  try {
    await sendMail(OWNER_EMAIL, String(d.subject || 'Morgonmejl').slice(0, 200), d.markdown.slice(0, 200_000));
    await ref.update({ status: 'sent', sentAt: FieldValue.serverTimestamp(), error: null });
  } catch (e) {
    await ref.update({ status: 'error', error: e.message });
    throw e;
  }
  return { sent: true };
}

async function readJson(req) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 10_000) throw new Error('för stor förfrågan'); }
  return JSON.parse(raw || '{}');
}

http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const headers = { 'Content-Type': 'application/json; charset=utf-8', Vary: 'Origin' };
  if (ORIGINS.has(origin)) {
    Object.assign(headers, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    });
  }
  const send = (code, body) => { res.writeHead(code, headers); res.end(JSON.stringify(body)); };
  try {
    if (req.method === 'OPTIONS') return send(204, {});
    if (req.method !== 'POST') return send(405, { error: 'metoden stöds inte' });
    if (req.url === '/digest/send') {
      if (!await runner(req)) return send(403, { error: 'inte behörig' });
      return send(200, await sendDigest((await readJson(req)).date));
    }
    if (!await owner(req)) return send(403, { error: 'inte behörig' });
    if (req.url === '/run') return send(202, await run((await readJson(req)).task));
    if (req.url === '/sync') return send(200, { done: await sync() });
    if (req.url === '/digest') { await gapi('POST', runUrl, digestBody(true)); return send(202, { started: true }); }
    send(404, { error: 'okänd adress' });
  } catch (e) {
    console.error(e);
    send(e.code || 500, { error: e.message });
  }
}).listen(Number(process.env.PORT || 8080));
