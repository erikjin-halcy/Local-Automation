// Molnläget för det lokala gränssnittet: samma /api som server.mjs, men uppgifter,
// körningar och filer läses och skrivs i Firestore, precis som ui/public/cloud.js gör i
// molnwebbappen. Behörigheten kommer från gcloud-inloggningen på Macen (projektets
// ägare), och Cloud Run-API:t anropas med gclouds ID-token. Inga beroenden.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, NAME_RE, ENV_PATH } from './lib.mjs';

const PROJECT = JSON.parse(await fs.readFile(path.join(ROOT, '.firebaserc'), 'utf8')).projects.default;
const API_URL = (await fs.readFile(path.join(ROOT, 'ui', 'public', 'cloud-config.js'), 'utf8')).match(/apiUrl = '([^']+)'/)?.[1];
const DOCS = `projects/${PROJECT}/databases/(default)/documents`;
const BASE = `https://firestore.googleapis.com/v1/${DOCS}`;
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// "- [ ] text" eller "1. [x] text": prefix, bock, avslut, text (samma som i server.mjs)
const TODO_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)[ xX](\]\s+)(.*)$/;

const err = (code, message) => Object.assign(new Error(message), { code });

// ---------- gcloud-token ----------
// Hämtas i förväg och förnyas i bakgrunden, så att devctl:s korta timeout räcker

const tokens = {};
function gcloudToken(kind) {
  const t = tokens[kind];
  if (t?.value && Date.now() - t.at < 40 * 60_000) return t.value;
  if (t?.pending) return t.pending;
  const pending = new Promise((resolve, reject) => {
    // launchd ger en kort PATH; gcloud ligger i Homebrew
    execFile('gcloud', ['auth', `print-${kind}-token`], { timeout: 30_000, env: { ...process.env, PATH: ENV_PATH } }, (e, out) => {
      tokens[kind] = { at: Date.now() };
      if (e) return reject(err(502, `gcloud: ${e.message.split('\n')[0]}. Kör "gcloud auth login".`));
      tokens[kind].value = out.trim();
      resolve(out.trim());
    });
  });
  tokens[kind] = { ...t, pending };
  return pending;
}
const warm = () => Promise.all([gcloudToken('access'), gcloudToken('identity')]).catch(e => console.error(e.message));
warm();
setInterval(() => { for (const k in tokens) tokens[k].at = 0; warm(); }, 30 * 60_000).unref();

// ---------- Firestore REST ----------

function decode(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  return null;
}
const fromFields = f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, decode(v)]));

function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  return { mapValue: { fields: toFields(v) } };
}
const toFields = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, encode(v)]));

async function fs_(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await gcloudToken('access')}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) throw err(res.status === 409 || res.status === 400 ? 409 : 502, `Firestore: ${data.error?.message || res.status}`);
  return data;
}

async function getDoc(p) {
  const d = await fs_('GET', `${BASE}/${p}`);
  return d && { ...fromFields(d.fields || {}), _updateTime: d.updateTime };
}

async function listDocs(col) {
  const out = [];
  let token = '';
  do {
    const d = await fs_('GET', `${BASE}/${col}?pageSize=300${token ? `&pageToken=${token}` : ''}`);
    for (const doc of d?.documents || []) out.push({ id: doc.name.split('/').pop(), ...fromFields(doc.fields || {}) });
    token = d?.nextPageToken || '';
  } while (token);
  return out;
}

async function query(col, task, { fields, orderBy, limit } = {}) {
  const q = {
    from: [{ collectionId: col }],
    where: { fieldFilter: { field: { fieldPath: 'task' }, op: 'EQUAL', value: { stringValue: task } } },
    ...(fields && { select: { fields: fields.map(f => ({ fieldPath: f })) } }),
    ...(orderBy && { orderBy: [{ field: { fieldPath: orderBy }, direction: 'DESCENDING' }] }),
    ...(limit && { limit }),
  };
  const rows = await fs_('POST', `${BASE}:runQuery`, { structuredQuery: q });
  return rows.filter(r => r.document).map(r => fromFields(r.document.fields || {}));
}

// writes: [{ set: [sökväg, data, { mustNotExist, updateTime, mask }] } | { del: sökväg }]
async function commit(writes) {
  await fs_('POST', `${BASE}:commit`, {
    writes: writes.map(w => {
      if (w.del) return { delete: `${DOCS}/${w.del}` };
      const [p, data, o = {}] = w.set;
      const { updatedAt, ...rest } = data;
      return {
        update: { name: `${DOCS}/${p}`, fields: toFields(rest) },
        ...(o.mask && { updateMask: { fieldPaths: o.mask } }),
        ...(o.mustNotExist && { currentDocument: { exists: false } }),
        ...(o.updateTime && { currentDocument: { updateTime: o.updateTime } }),
        ...(updatedAt && { updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }] }),
      };
    }),
  });
  cache.clear();
}

// Cache för det som läses ofta. Firestore ligger i Stockholm och svarar på ~1 s, medan
// devctl väntar högst 0,8 s; därför svarar vi med senast hämtade värde och hämtar nytt
// i bakgrunden när det är äldre än ms. Ändringar via commit() tömmer cachen.
const cache = new Map();
function cached(key, fn, ms = 3000) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ms) return c.value;
  if (c?.pending) return c.last !== undefined ? Promise.resolve(c.last) : c.pending;
  const pending = fn();
  const entry = { at: c?.at ?? 0, value: c?.value, last: c?.last, pending };
  cache.set(key, entry);
  pending.then(v => { if (cache.get(key) === entry) cache.set(key, { at: Date.now(), value: pending, last: v }); },
    () => { if (cache.get(key) === entry) cache.set(key, { ...entry, pending: null }); });
  return entry.last !== undefined ? Promise.resolve(entry.last) : pending;
}

// ---------- Cloud Run-API:t ----------

async function api(p, body) {
  if (!API_URL) throw err(500, 'API-adressen saknas i ui/public/cloud-config.js');
  const res = await fetch(API_URL + p, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await gcloudToken('identity')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw err(res.status, data.error || res.statusText);
  return data;
}

async function sync() {
  try { await api('/sync'); }
  catch (e) { throw err(502, `Sparat, men schemat kunde inte uppdateras: ${e.message}`); }
}

// ---------- uppgifter ----------

// Samma regler som install.sh --check och cloud.js
function checkSchedule(s) {
  const p = (s || '').trim().split(/\s+/);
  const time = t => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t || '');
  switch (p[0]) {
    case 'every': {
      const m = (p[1] || '').match(/^(\d+)([smhSMH]?)$/);
      if (!m) return `ogiltigt intervall '${p[1] || ''}'`;
      const u = (m[2] || 's').toLowerCase();
      return Number(m[1]) * (u === 'h' ? 3600 : u === 'm' ? 60 : 1) >= 60 ? null : 'intervallet måste vara minst 60 sekunder';
    }
    case 'daily':
    case 'weekdays':
      return time(p[1]) ? null : `ogiltig tid '${p[1] || ''}'`;
    case 'weekly':
      if (!time(p[2])) return `ogiltig tid '${p[2] || ''}'`;
      for (const d of (p[1] || '').split(',')) if (!WEEKDAYS.includes(d)) return `ogiltig veckodag '${d}'`;
      return null;
    default:
      return `okänt schema '${s}'`;
  }
}

const agent = () => cached('agent', () => getDoc('agent/status').then(a => a || {}));

async function validate(b) {
  if (typeof b.schedule !== 'string' || !b.schedule.trim()) return 'schema saknas';
  if (typeof b.prompt !== 'string' || !b.prompt.trim()) return 'prompt saknas';
  const e = checkSchedule(b.schedule);
  if (e) return e;
  const available = (await agent()).mcp || [];
  for (const m of b.mcp || []) {
    const s = available.find(x => x.name === m?.name);
    if (!s) return `okänd MCP-server: ${m?.name}`;
    if (!s.levels.includes(m.level)) return `${m.name} saknar nivån ${m.level}`;
  }
  return null;
}

const taskData = b => ({
  schedule: b.schedule.trim(),
  enabled: !!b.enabled,
  digest: !!b.digest,
  mcp: (b.mcp || []).map(m => ({ name: m.name, level: m.level })),
  prompt: b.prompt,
  updatedAt: true,
});

async function listTasks() {
  return cached('tasks', async () => {
    const [tasks, states] = await Promise.all([listDocs('tasks'), listDocs('taskState')]);
    const state = new Map(states.map(s => [s.id, s]));
    return tasks.sort((a, b) => a.id.localeCompare(b.id)).map(t => taskView(t, state.get(t.id)));
  });
}

const taskView = (t, s = {}) => ({
  name: t.id, schedule: t.schedule, enabled: !!t.enabled, digest: !!t.digest, mcp: t.mcp || [], prompt: t.prompt,
  running: !!s.running, lastRun: s.lastRun || null, error: s.error || null,
});

// Samma dokument-id som cloud/runner.mjs: <uppgift>__<base64url(sökväg)>
const fileId = (name, rel) => `${name}__${Buffer.from(rel).toString('base64url')}`;

// ---------- /api ----------

export async function cloudApi(method, parts, url, body) {
  if (parts[0] === 'status') {
    const a = await agent();
    return { mode: a.mode || 'cloud', docker: !!a.docker, image: !!a.image, token: !!a.token, agentOnline: true, lastSeen: null };
  }
  if (parts[0] === 'mcp') return (await agent()).mcp || [];
  if (parts[0] === 'check-schedule') {
    const e = checkSchedule(url.searchParams.get('s'));
    return { ok: !e, error: e };
  }
  if (parts[0] === 'profile') {
    if (method === 'GET') {
      const { _updateTime, updatedAt, ...profile } = (await getDoc('profile/me')) || {};
      return { profile, detected: (await agent()).detected || null };
    }
    if (method !== 'PUT') throw err(405, 'metoden stöds inte');
    const str = v => (typeof v === 'string' ? v.trim() : '');
    await commit([{ set: ['profile/me', {
      name: str(body.name),
      emails: (body.emails || []).map(str).filter(Boolean).slice(0, 10),
      slack: { id: str(body.slack?.id), name: str(body.slack?.name), workspace: str(body.slack?.workspace) },
      github: str(body.github),
      timezone: str(body.timezone),
      notes: str(body.notes).slice(0, 4000),
      digest: { enabled: !!body.digest?.enabled, time: TIME_RE.test(body.digest?.time || '') ? body.digest.time : '07:30' },
      updatedAt: true,
    }] }]);
    await sync();
    return { ok: true };
  }
  if (parts[0] === 'digest' && method === 'POST') return api('/digest');
  if (parts[0] !== 'tasks') throw err(404, 'okänd adress');

  if (parts.length === 1) {
    if (method === 'GET') return listTasks();
    if (method === 'POST') {
      if (!NAME_RE.test(body.name || '')) throw err(400, 'namnet får bara innehålla A–Z, 0–9, - och _');
      const e = await validate(body);
      if (e) throw err(400, e);
      await commit([{ set: [`tasks/${body.name}`, taskData(body), { mustNotExist: true }] }])
        .catch(() => { throw err(409, `uppgiften ${body.name} finns redan`); });
      await sync();
      return { task: { name: body.name } };
    }
  }

  const name = parts[1];
  if (!NAME_RE.test(name || '')) throw err(400, 'ogiltigt namn');
  const task = await getDoc(`tasks/${name}`);
  if (!task) throw err(404, 'uppgiften finns inte');

  if (parts.length === 2) {
    if (method === 'GET') return taskView({ id: name, ...task }, (await getDoc(`taskState/${name}`)) || {});
    if (method === 'PUT') {
      const e = await validate(body);
      if (e) throw err(400, e);
      const to = body.name || name;
      if (to === name) await commit([{ set: [`tasks/${name}`, taskData(body)] }]);
      else {
        if (!NAME_RE.test(to)) throw err(400, 'namnet får bara innehålla A–Z, 0–9, - och _');
        if ((await getDoc(`taskState/${name}`))?.running) throw err(409, 'kan inte byta namn medan uppgiften körs');
        // Atomärt; api.mjs flyttar körningar och filer när den ser renamedFrom
        await commit([
          { set: [`tasks/${to}`, { ...taskData(body), renamedFrom: name }, { mustNotExist: true }] },
          { del: `tasks/${name}` },
        ]).catch(() => { throw err(409, `uppgiften ${to} finns redan`); });
      }
      await sync();
      return { task: { name: to } };
    }
    if (method === 'DELETE') {
      await commit([{ del: `tasks/${name}` }]);
      await sync();
      return { deleted: name };
    }
  }

  if (parts[2] === 'run' && method === 'POST') return api('/run', { task: name });

  if (parts[2] === 'runs' && method === 'GET') {
    if (parts.length === 3) return query('runs', name, { fields: ['id', 'start', 'exit', 'running'], orderBy: 'start', limit: 50 });
    const r = await getDoc(`runs/${name}__${parts[3]}`);
    if (!r) throw err(404, 'körningen finns inte');
    return { id: r.id, log: r.log || '' };
  }

  if (parts[2] === 'files') {
    const rel = parts.slice(3).join('/');
    if (method === 'PATCH' && rel) {
      // Bockar av en punkt i en checklista; bara om filen inte har ändrats sedan den lästes
      if (!/\.(md|markdown)$/i.test(rel)) throw err(400, 'ogiltig sökväg');
      const f = await getDoc(`files/${fileId(name, rel)}`);
      if (typeof f?.content !== 'string') throw err(404, 'filen finns inte');
      const lines = f.content.split('\n');
      const todo = Number.isInteger(body.line) ? TODO_RE.exec(lines[body.line] ?? '') : null;
      if (!todo || todo[3] !== body.text) throw err(409, 'filen har ändrats, ladda om sidan');
      lines[body.line] = todo[1] + (body.checked ? 'x' : ' ') + todo[2] + todo[3];
      await commit([{ set: [`files/${fileId(name, rel)}`, { content: lines.join('\n') }, { mask: ['content'], updateTime: f._updateTime }] }])
        .catch(() => { throw err(409, 'filen har ändrats, ladda om sidan'); });
      return { line: body.line, checked: !!body.checked };
    }
    if (method !== 'GET') throw err(405, 'metoden stöds inte');
    if (!rel) {
      const files = await query('files', name, { fields: ['path', 'size', 'modified'] });
      return files.sort((a, b) => a.path.localeCompare(b.path));
    }
    const f = await getDoc(`files/${fileId(name, rel)}`);
    if (!f) throw err(404, 'filen finns inte');
    if (f.content == null) throw err(404, `Filen visas inte: ${f.note || 'inget innehåll'}`);
    return { __text: f.content };
  }

  throw err(405, 'metoden stöds inte');
}
listTasks().catch(() => {});
