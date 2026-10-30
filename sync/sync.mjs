// Synkar Apple Notes och Obsidian-valv mellan Macen och molnet (Cloud Storage).
//
//   gs://<bucket>/snapshot/notes/<konto>/<mapp>/<titel>.md   kopia av Notes (Macen skriver)
//   gs://<bucket>/snapshot/obsidian/<valv>/...               kopia av valven (Macen skriver)
//   gs://<bucket>/snapshot/meta.json                          när och vad som synkades
//   gs://<bucket>/outbox/<körning>.json                       ändringar som uppgifter gjort (runner skriver)
//
// Varje synk: 1) för in ändringar från outbox på Macen  2) exporterar Notes  3) laddar upp kopian.
// Ändringar från molnet skriver aldrig över något som ändrats på Macen sedan kopian togs –
// då sparas molnets version bredvid som en konfliktkopia (Obsidian) eller ny anteckning (Notes).
//
// Användning:
//   node sync/sync.mjs                    full synk (körs var 10:e minut av sync/install-sync.sh)
//   node sync/sync.mjs export-notes <dir> exportera Notes till en katalog (används av run.sh)

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const STAGE = path.join(DATA, 'notes-snapshot');
const BINARY = 'png|jpe?g|gif|webp|heic|svg|pdf|mp4|mov|mp3|m4a|wav|zip';
// Dolda filer (.obsidian, .trash …) och binärfiler synkas inte. GCS_EXCLUDE är samma regel för gcloud (Python-regex).
const SKIP_RE = new RegExp(`(^|/)\\.|\\.(${BINARY})$`, 'i');
const GCS_EXCLUDE = `(?i)(^|.*/)\\..*|.*\\.(${BINARY})$`;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const md5 = buf => crypto.createHash('md5').update(buf).digest('hex');

export async function loadConfig() {
  const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'sync.json'), 'utf8'));
  const project = JSON.parse(await fs.readFile(path.join(ROOT, '.firebaserc'), 'utf8')).projects.default;
  const home = p => p.replace(/^~(?=\/|$)/, os.homedir());
  return {
    project,
    bucket: cfg.bucket || `${project}-notes`,
    notes: cfg.notes !== false,
    vaults: Object.fromEntries(Object.entries(cfg.vaults || {}).map(([k, v]) => [k, home(v)])),
  };
}

// ---------- Notes ----------

async function notesExport() {
  const { stdout } = await exec('osascript', ['-l', 'JavaScript', path.join(import.meta.dirname, 'notes.js'), 'export'],
    { maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60_000 });
  return JSON.parse(stdout);
}

async function notesApply(changes) {
  const tmp = path.join(os.tmpdir(), `la-notes-${process.pid}.json`);
  await fs.writeFile(tmp, JSON.stringify(changes), { mode: 0o600 });
  try {
    const { stdout } = await exec('osascript', ['-l', 'JavaScript', path.join(import.meta.dirname, 'notes.js'), 'apply', tmp],
      { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 });
    return JSON.parse(stdout);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

const clean = s => String(s || '').replace(/[\/\\:*?"<>|\n\r\t]+/g, '-').replace(/^[.\s]+/, '').trim().slice(0, 100);

export function renderNote(n) {
  return `---\nid: ${n.id}\naccount: ${n.account}\nfolder: ${n.folder.join('/')}\ncreated: ${n.created}\n` +
    `modified: ${n.modified}\nattachments: ${n.attachments}\n---\n${String(n.text).replace(/\r\n?/g, '\n')}\n`;
}

// Stabila filnamn: <konto>/<mapp>/<titel>.md, dubbletter får (2), (3) … i skapandeordning
export function notePaths(notes) {
  const used = new Set();
  const out = new Map();
  for (const n of [...notes].sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id))) {
    const dir = [clean(n.account) || 'Konto', ...n.folder.map(f => clean(f) || 'Mapp')].join('/');
    const base = clean(n.title) || 'Namnlös';
    let name = `${base}.md`;
    for (let i = 2; used.has(`${dir}/${name}`.toLowerCase()); i++) name = `${base} (${i}).md`;
    used.add(`${dir}/${name}`.toLowerCase());
    out.set(n.id, `${dir}/${name}`);
  }
  return out;
}

function parseNoteFile(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };
  const meta = Object.fromEntries(m[1].split('\n').map(l => l.match(/^(\w+):\s?(.*)$/)).filter(Boolean).map(x => [x[1], x[2]]));
  return { meta, body: m[2] };
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const toHtml = body => body.replace(/\s+$/, '').split('\n').map(l => `<div>${esc(l) || '<br>'}</div>`).join('');

export async function writeNotesDir(dir, notes) {
  const paths = notePaths(notes);
  const keep = new Set();
  for (const n of notes) {
    const rel = paths.get(n.id);
    const full = path.join(dir, rel);
    keep.add(full);
    const content = renderNote(n);
    const old = await fs.readFile(full, 'utf8').catch(() => null);
    if (old !== content) {
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
    }
    const t = new Date(n.modified);
    await fs.utimes(full, t, t);
  }
  for (const f of await walk(dir)) if (!keep.has(f)) await fs.rm(f);
  return paths;
}

async function walk(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

// ---------- molnet ----------

function gcloudFor(cfg) {
  return async (...args) => (await exec('gcloud', ['--project', cfg.project, '--quiet', ...args],
    { maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 })).stdout;
}

async function listOutbox(gcloud, bucket) {
  try {
    return (await gcloud('storage', 'ls', `gs://${bucket}/outbox/`)).split('\n').filter(l => l.endsWith('.json')).sort();
  } catch (e) {
    if (/matched no objects|not found/i.test(e.stderr || '')) return [];
    throw e;
  }
}

// ---------- tillämpa ändringar från molnet ----------

const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');

async function applyObsidian(cfg, c) {
  const [vault, ...rest] = c.path.split('/');
  const root = cfg.vaults[vault];
  if (!root) return `okänt valv ${vault}`;
  const rel = rest.join('/');
  const target = path.resolve(root, rel);
  if (!target.startsWith(root + path.sep) || SKIP_RE.test(rel)) return `ogiltig sökväg ${c.path}`;
  const local = await fs.readFile(target).then(md5, () => null);

  if (c.op === 'delete') {
    if (local === null) return null;
    if (local !== c.baseMd5) return `${c.path} ändrad på Macen, tas inte bort`;
    const trash = path.join(root, '.trash', rel);
    await fs.mkdir(path.dirname(trash), { recursive: true });
    await fs.rename(target, trash);
    return `flyttade ${c.path} till .trash`;
  }
  let dest = target;
  if (local !== null && local !== c.baseMd5 && local !== md5(Buffer.from(c.content))) {
    const ext = path.extname(target);
    dest = target.slice(0, target.length - ext.length) + ` (konflikt Local Automation ${stamp()})${ext}`;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, c.content);
  return `${dest === target ? 'skrev' : 'konflikt, sparade kopia'} ${path.relative(root, dest)} i ${vault}`;
}

function planNote(c, current, currentPaths, ref) {
  if (c.op === 'delete') return { msg: `ignorerar borttagning av anteckning ${c.path}` };
  const { meta, body } = parseNoteFile(c.content);
  if (!body.trim()) return { msg: `tom anteckning ${c.path}, hoppar över` };
  const parts = c.path.split('/');
  const account = meta.account || parts[0];
  const folder = meta.folder != null ? meta.folder.split('/').filter(Boolean) : parts.slice(1, -1);
  const cur = meta.id && current.get(meta.id);
  if (cur) {
    if (cur.attachments > 0 || md5(Buffer.from(renderNote(cur))) !== c.baseMd5) {
      const lines = body.split('\n');
      lines[0] = `${lines[0]} (Local Automation ${stamp()})`;
      return { change: { ref, op: 'create', account: cur.account, folder: cur.folder, html: toHtml(lines.join('\n')) },
        msg: `${currentPaths.get(meta.id)}: ${cur.attachments > 0 ? 'har bilagor' : 'ändrad på Macen'}, skapar ny anteckning` };
    }
    return { change: { ref, op: 'update', id: cur.id, html: toHtml(body) }, msg: `uppdaterar ${currentPaths.get(meta.id)}` };
  }
  return { change: { ref, op: 'create', account, folder, html: toHtml(body) }, msg: `skapar anteckning i ${account}/${folder.join('/')}` };
}

// ---------- huvudprogram ----------

async function sync() {
  const cfg = await loadConfig();
  const gcloud = gcloudFor(cfg);
  const lock = path.join(DATA, '.sync.lock');
  await fs.mkdir(DATA, { recursive: true });
  try { await fs.mkdir(lock); } catch {
    const age = Date.now() - (await fs.stat(lock)).mtimeMs;
    if (age < 30 * 60_000) { log('en synk körs redan'); return; }
    await fs.rm(lock, { recursive: true, force: true }); await fs.mkdir(lock);
  }
  try {
    let notes = cfg.notes ? await notesExport() : [];
    let current = new Map(notes.map(n => [n.id, n]));
    let currentPaths = notePaths(notes);
    log(`Notes: ${notes.length} anteckningar`);

    // 1. ändringar från uppgifter i molnet
    let notesChanged = false;
    for (const url of await listOutbox(gcloud, cfg.bucket)) {
      const box = JSON.parse(await gcloud('storage', 'cat', url));
      log(`outbox ${path.basename(url)}: ${box.changes.length} ändringar från ${box.task}`);
      const noteChanges = [];
      for (const [i, c] of box.changes.entries()) {
        if (c.area === 'obsidian') { const m = await applyObsidian(cfg, c); if (m) log('  obsidian:', m); }
        else if (c.area === 'notes' && cfg.notes) {
          const p = planNote(c, current, currentPaths, i);
          log('  notes:', p.msg);
          if (p.change) noteChanges.push(p.change);
        }
      }
      if (noteChanges.length) {
        for (const r of await notesApply(noteChanges)) if (!r.ok) log('  notes: fel:', r.error);
        notesChanged = true;
      }
      await gcloud('storage', 'rm', url);
    }
    if (notesChanged) {
      notes = await notesExport();
      current = new Map(notes.map(n => [n.id, n]));
    }

    // 2. ladda upp kopian
    const rsync = (src, dst, extra = []) => gcloud('storage', 'rsync', src, dst, '--recursive',
      '--delete-unmatched-destination-objects', ...extra);
    if (cfg.notes) {
      if (!notes.length && (await walk(STAGE)).length) throw new Error('Notes-exporten blev tom; laddar inte upp (skulle radera kopian i molnet)');
      await writeNotesDir(STAGE, notes);
      await rsync(STAGE, `gs://${cfg.bucket}/snapshot/notes`);
    }
    for (const [name, dir] of Object.entries(cfg.vaults)) {
      try { await fs.access(dir); } catch { log(`valvet ${name} finns inte: ${dir}`); continue; }
      await rsync(dir, `gs://${cfg.bucket}/snapshot/obsidian/${name}`, ['--exclude', GCS_EXCLUDE]);
      log(`Obsidian: ${name} uppladdat`);
    }
    const meta = path.join(DATA, 'sync-meta.json');
    await fs.writeFile(meta, JSON.stringify({
      syncedAt: new Date().toISOString(), notes: cfg.notes ? notes.length : null, vaults: Object.keys(cfg.vaults),
    }));
    await gcloud('storage', 'cp', meta, `gs://${cfg.bucket}/snapshot/meta.json`);
    log('klar');
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] === import.meta.filename) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'export-notes') {
      if (!arg) throw new Error('användning: sync.mjs export-notes <katalog>');
      const notes = await notesExport();
      await writeNotesDir(path.resolve(arg), notes);
      console.log(`${notes.length} anteckningar exporterade till ${arg}`);
    } else {
      await sync();
    }
  } catch (e) {
    log('fel:', e.stderr || e.message);
    process.exit(1);
  }
}
