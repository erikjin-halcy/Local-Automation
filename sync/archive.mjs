// Veckoarkiv: samlar det som Local-Automation och devctl har genererat under avslutade veckor,
// komprimerar det till ett arkiv i molnet och städar bort originalen.
//
//   gs://<bucket>/archive/<ÅÅÅÅ-Vvv>/<tid>.tar.gz   arkivet (en eller flera delar per vecka)
//   gs://<bucket>/archive/<ÅÅÅÅ-Vvv>/<tid>.json     manifest för delen (filer, öppna att göra-punkter)
//
// Det som arkiveras (bara genererade filer, aldrig sådant man skriver själv):
//   valvet Local Automation:  Dev-logg/ (devctl), Rapporter/ (uppgifter)
//   repot:                    work/<uppgift>/ och logs/<uppgift>/ från lokala körningar
//   Firestore:                files (rapporter i /work) och runs (körningar) för uppgifterna
//
// Ordning: arkivet laddas upp och kontrolleras (md5) innan något tas bort. Lokala filer flyttas
// till papperskorgen (valvets .trash/ och data/trash/), Firestore-dokumenten tas bort.
// I valvet skapas Arkiv/<vecka>.md som pekare med innehåll, öppna punkter och hur man hämtar tillbaka.
//
// Användning:
//   node sync/archive.mjs [run] [--dry-run]    arkivera alla avslutade veckor (måndagar 00:30 via install-archive.sh)
//   node sync/archive.mjs list                 visa arkiven i molnet
//   node sync/archive.mjs restore <vecka>      packa upp en vecka till valvet: Arkiv/<vecka>/
//   node sync/archive.mjs delete <vecka>… [--yes]          ta bort veckor permanent från molnet
//   node sync/archive.mjs delete --before <vecka> [--yes]  ta bort alla veckor före <vecka>

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { promisify } from 'node:util';
import { loadConfig } from './sync.mjs';

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const VAULT_KEY = 'Local-Automation';
const VAULT_DIRS = ['Dev-logg', 'Rapporter'];
const TEXT_RE = /\.(md|markdown|txt|log|csv)$/i;
const DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;
const WEEK_RE = /^\d{4}-V\d{2}$/;
const TODO_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+(.*)$/;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const md5b64 = buf => crypto.createHash('md5').update(buf).digest('base64');

// ---------- veckor (lokal tid, ISO 8601) ----------

const dayOf = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function weekStart(d) {
  const t = dayOf(d);
  t.setDate(t.getDate() - (t.getDay() + 6) % 7);
  return t;
}

export function isoWeek(d) {
  const t = dayOf(d);
  t.setDate(t.getDate() - (t.getDay() + 6) % 7 + 3);  // veckans torsdag avgör året
  const jan4 = new Date(t.getFullYear(), 0, 4);
  const week = 1 + Math.round(((t - weekStart(jan4)) / 864e5 - 3) / 7);
  return `${t.getFullYear()}-V${String(week).padStart(2, '0')}`;
}

// Datum i filnamnet (dagsplan-2026-10-30.md) går före ändringstiden
export function itemDate(name, fallback) {
  const m = DATE_RE.exec(path.basename(name));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(fallback);
}

// ---------- molnet ----------

function cloud(cfg) {
  const gcloud = async (...args) => (await exec('gcloud', ['--project', cfg.project, '--quiet', ...args],
    { maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60_000 })).stdout;
  const base = `https://firestore.googleapis.com/v1/projects/${cfg.project}/databases/(default)/documents`;
  let token = null;
  const fsApi = async (url, opts = {}) => {
    token ??= (await gcloud('auth', 'print-access-token')).trim();
    const res = await fetch(url.startsWith('http') ? url : `${base}/${url}`, { ...opts, headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw Object.assign(new Error(`Firestore ${res.status}: ${(await res.text()).slice(0, 300)}`), { status: res.status });
    return res.json();
  };
  return { gcloud, fsApi, bucket: `gs://${cfg.bucket}/archive` };
}

const value = v => v == null ? null : 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue)
  : 'booleanValue' in v ? v.booleanValue : 'timestampValue' in v ? v.timestampValue : null;

async function listDocs(fsApi, collection) {
  const out = [];
  let page = '';
  do {
    const r = await fsApi(`${collection}?pageSize=300${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
    for (const d of r.documents || []) {
      out.push({ name: d.name, updateTime: d.updateTime, ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, value(v)])) });
    }
    page = r.nextPageToken || '';
  } while (page);
  return out;
}

async function lsArchive(c) {
  try {
    const out = await c.gcloud('storage', 'ls', '-l', `${c.bucket}/**`);
    return out.split('\n').map(l => l.match(/^\s*(\d+)\s+(\S+)\s+(gs:\/\/\S+)$/)).filter(Boolean)
      .map(([, size, time, url]) => ({ size: +size, time, url, week: url.split('/').at(-2), file: url.split('/').at(-1) }))
      .filter(o => WEEK_RE.test(o.week));
  } catch (e) {
    if (/matched no objects|not found/i.test(e.stderr || '')) return [];
    throw e;
  }
}

// ---------- vad som ska arkiveras ----------

async function walk(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

async function localItems(vault) {
  const items = [];
  const add = async (full, base, prefix, trash) => {
    const st = await fs.stat(full);
    const rel = path.relative(base, full);
    items.push({ kind: 'local', full, trash: path.join(trash, rel), path: `${prefix}/${rel}`, date: itemDate(rel, st.mtime) });
  };
  if (vault) for (const dir of VAULT_DIRS) {
    for (const f of await walk(path.join(vault, dir))) await add(f, vault, `obsidian/${VAULT_KEY}`, path.join(vault, '.trash', 'Arkiv'));
  }
  for (const f of await walk(path.join(ROOT, 'work'))) {
    if (TEXT_RE.test(f)) await add(f, ROOT, 'lokal', path.join(DATA, 'trash'));
  }
  // Bara loggar för körningar (ÅÅÅÅ-MM-DD_HHMMSS.log), inte tjänsternas egna loggar
  for (const f of await walk(path.join(ROOT, 'logs'))) {
    if (/^\d{4}-\d{2}-\d{2}_\d{6}\.log$/.test(path.basename(f))) await add(f, ROOT, 'lokal', path.join(DATA, 'trash'));
  }
  return items;
}

async function cloudItems(fsApi) {
  const running = new Set((await listDocs(fsApi, 'taskState')).filter(s => s.running).map(s => s.name.split('/').at(-1)));
  const items = [];
  for (const f of await listDocs(fsApi, 'files')) {
    // Pågående uppgifter och filer utan innehåll (binära, för stora) lämnas kvar
    if (running.has(f.task) || f.content == null || !TEXT_RE.test(f.path)) continue;
    items.push({ kind: 'doc', doc: f.name, updateTime: f.updateTime, path: `molnet/files/${f.task}/${f.path}`,
      content: f.content, date: itemDate(f.path, f.modified) });
  }
  for (const r of await listDocs(fsApi, 'runs')) {
    if (running.has(r.task) || r.running) continue;
    items.push({ kind: 'doc', doc: r.name, updateTime: r.updateTime, path: `molnet/runs/${r.task}/${r.id}.log`,
      content: r.log || '', exit: r.exit, date: itemDate(r.id, r.start) });
  }
  return items;
}

// ---------- pekaranteckningar i valvet ----------

const kb = n => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`;

async function writeWeekNote(vault, week, manifests, deleted = null) {
  if (!vault) return;
  const files = manifests.flatMap(m => m.files);
  const open = files.filter(f => f.todos?.length);
  const groups = Object.groupBy(files, f => f.path.split('/').slice(0, 3).join('/'));
  const lines = [
    '---', 'tags: [arkiv]', `vecka: ${week}`, `filer: ${files.length}`,
    `status: ${deleted ? `borttagen ${deleted}` : 'i molnet'}`, '---',
    `# Arkiv ${week}`, '',
    deleted
      ? `> [!warning] Arkivet togs bort permanent från molnet ${deleted}. Listan nedan visar vad det innehöll.`
      : `Genererade filer från veckan ${manifests[0]?.period || ''}, arkiverade till \`${manifests.map(m => m.object).join('`, `')}\`.`,
    '',
  ];
  if (!deleted) lines.push('```bash', `node sync/archive.mjs restore ${week}   # packa upp till Arkiv/${week}/`,
    `node sync/archive.mjs delete ${week}    # ta bort permanent från molnet`, '```', '');
  if (open.length) {
    lines.push('## Öppet när veckan arkiverades');
    for (const f of open) lines.push(`- **${f.path.split('/').slice(2).join('/')}**`, ...f.todos.map(t => `  - [ ] ${t}`));
    lines.push('');
  }
  lines.push('## Innehåll');
  for (const [group, list] of Object.entries(groups)) {
    lines.push(`### ${group}`, ...list.map(f => `- ${f.path.split('/').slice(3).join('/') || f.path} (${kb(f.size)})`), '');
  }
  await fs.mkdir(path.join(vault, 'Arkiv'), { recursive: true });
  await fs.writeFile(path.join(vault, 'Arkiv', `${week}.md`), lines.join('\n'));
}

async function writeIndex(vault, c) {
  if (!vault) return;
  const weeks = Object.groupBy((await lsArchive(c)).filter(o => o.file.endsWith('.tar.gz')), o => o.week);
  const rows = Object.entries(weeks).sort(([a], [b]) => b.localeCompare(a))
    .map(([w, parts]) => `| [[${w}]] | ${parts.length} | ${kb(parts.reduce((s, p) => s + p.size, 0))} |`);
  await fs.mkdir(path.join(vault, 'Arkiv'), { recursive: true });
  await fs.writeFile(path.join(vault, 'Arkiv', 'Arkiv.md'), [
    '---', 'tags: [arkiv, moc]', '---', '# Arkiv', '',
    'Veckoarkiv med det Local-Automation och devctl har genererat (rapporter, dagsplaner, dev-logg, körningar).',
    'Skapas varje måndag 00:30 av `sync/archive.mjs`. Den här sidan skrivs om automatiskt.', '',
    '| Vecka | Delar | Storlek (komprimerat) |', '|---|---|---|', ...(rows.length ? rows : ['| – | | |']), '',
    '```bash', 'node sync/archive.mjs list', 'node sync/archive.mjs restore <vecka>',
    'node sync/archive.mjs delete <vecka>          # permanent', 'node sync/archive.mjs delete --before <vecka>', '```', '',
  ].join('\n'));
}

// ---------- kommandon ----------

async function withLock(fn) {
  // Samma lås som sync.mjs, så att arkivet inte flyttar filer mitt i en synk
  const lock = path.join(DATA, '.sync.lock');
  await fs.mkdir(DATA, { recursive: true });
  for (let i = 0; ; i++) {
    try { await fs.mkdir(lock); break; } catch {
      const age = Date.now() - (await fs.stat(lock).then(s => s.mtimeMs, () => Date.now()));
      if (age > 30 * 60_000) { await fs.rm(lock, { recursive: true, force: true }); continue; }
      if (i >= 30) throw new Error('synken håller låset, försök igen senare');
      await new Promise(r => setTimeout(r, 10_000));
    }
  }
  try { return await fn(); } finally { await fs.rm(lock, { recursive: true, force: true }); }
}

async function archive(cfg, c, vault, dryRun) {
  // ARCHIVE_NOW (t.ex. 2026-11-02) låtsas att det är en annan dag, för att provköra med --dry-run
  const cutoff = weekStart(process.env.ARCHIVE_NOW ? new Date(process.env.ARCHIVE_NOW) : new Date());
  const items = [...await localItems(vault), ...await cloudItems(c.fsApi)].filter(i => i.date < cutoff);
  const weeks = Object.groupBy(items, i => isoWeek(i.date));
  if (!items.length) { log('inget att arkivera'); return; }

  for (const [week, list] of Object.entries(weeks).sort()) {
    log(`${week}: ${list.length} filer${dryRun ? ' (provkörning)' : ''}`);
    if (dryRun) { for (const i of list) log(`  ${i.path}`); continue; }

    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), `la-archive-${week}-`));
    try {
      const files = [];
      for (const i of list) {
        const buf = i.kind === 'local' ? await fs.readFile(i.full) : Buffer.from(i.content);
        const text = buf.toString('utf8');
        await fs.mkdir(path.dirname(path.join(stage, 'filer', i.path)), { recursive: true });
        await fs.writeFile(path.join(stage, 'filer', i.path), buf);
        files.push({ path: i.path, size: buf.length, date: i.date.toISOString().slice(0, 10), ...(i.exit != null && { exit: i.exit }),
          todos: /\.(md|markdown)$/i.test(i.path) ? text.split('\n').map(l => TODO_RE.exec(l)?.[1]).filter(Boolean) : [] });
      }
      const start = weekStart(list[0].date), end = new Date(start); end.setDate(end.getDate() + 6);
      const object = `${c.bucket}/${week}/${stamp}.tar.gz`;
      const manifest = { week, period: `${start.toLocaleDateString('sv-SE')}–${end.toLocaleDateString('sv-SE')}`,
        createdAt: new Date().toISOString(), object, files };
      await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));

      const tgz = `${stage}.tar.gz`;
      await exec('tar', ['-czf', tgz, '-C', stage, '.']);
      await c.gcloud('storage', 'cp', tgz, object);
      await c.gcloud('storage', 'cp', path.join(stage, 'manifest.json'), object.replace(/\.tar\.gz$/, '.json'));
      // Kontrollera uppladdningen innan något tas bort
      const remote = JSON.parse(await c.gcloud('storage', 'objects', 'describe', object, '--format=json'));
      const local = md5b64(await fs.readFile(tgz));
      await fs.rm(tgz, { force: true });
      if (remote.md5_hash !== local) throw new Error(`${week}: kontrollsumman stämmer inte (${remote.md5_hash} ≠ ${local}), inget tas bort`);
      log(`  uppladdat och kontrollerat: ${object}`);

      let moved = 0, removed = 0, kept = 0;
      for (const i of list) {
        if (i.kind === 'local') {
          await fs.mkdir(path.dirname(i.trash), { recursive: true });
          await fs.rename(i.full, i.trash);
          moved++;
        } else {
          // Bara om dokumentet inte ändrats sedan det lästes (t.ex. en bock i webbappen)
          try { await c.fsApi(`${i.doc.split('/documents/')[1]}?currentDocument.updateTime=${encodeURIComponent(i.updateTime)}`, { method: 'DELETE' }); removed++; }
          catch (e) { if (e.status === 400 || e.status === 409 || e.status === 412) kept++; else throw e; }
        }
      }
      log(`  ${moved} lokala filer till papperskorgen, ${removed} borttagna i Firestore${kept ? `, ${kept} ändrade under tiden och kvar till nästa vecka` : ''}`);
      await writeWeekNote(vault, week, await weekManifests(c, week));
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }
  if (!dryRun) await writeIndex(vault, c);
}

async function weekManifests(c, week) {
  const parts = (await lsArchive(c)).filter(o => o.week === week && o.file.endsWith('.json'));
  return Promise.all(parts.map(async p => JSON.parse(await c.gcloud('storage', 'cat', p.url))));
}

async function list(c) {
  const weeks = Object.groupBy((await lsArchive(c)).filter(o => o.file.endsWith('.tar.gz')), o => o.week);
  if (!Object.keys(weeks).length) return console.log('inga arkiv i molnet');
  for (const [w, parts] of Object.entries(weeks).sort()) {
    console.log(`${w}  ${parts.length} del${parts.length > 1 ? 'ar' : ''}  ${kb(parts.reduce((s, p) => s + p.size, 0))}`);
  }
}

async function restore(c, vault, week) {
  if (!WEEK_RE.test(week || '')) throw new Error('ange en vecka, t.ex. 2026-V44');
  const parts = (await lsArchive(c)).filter(o => o.week === week && o.file.endsWith('.tar.gz'));
  if (!parts.length) throw new Error(`inget arkiv för ${week}`);
  const dest = vault ? path.join(vault, 'Arkiv', week) : path.join(ROOT, 'arkiv', week);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'la-restore-'));
  try {
    for (const p of parts) {
      const tgz = path.join(tmp, p.file);
      await c.gcloud('storage', 'cp', p.url, tgz);
      const out = path.join(tmp, p.file.replace(/\.tar\.gz$/, ''));
      await fs.mkdir(out);
      await exec('tar', ['-xzf', tgz, '-C', out]);
      await fs.cp(path.join(out, 'filer'), dest, { recursive: true });
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  console.log(`${week} uppackat i ${dest}`);
}

async function remove(c, vault, args, yes) {
  const all = await lsArchive(c);
  const known = [...new Set(all.map(o => o.week))].sort();
  const bi = args.indexOf('--before');
  const weeks = bi >= 0 ? known.filter(w => w < args[bi + 1]) : args.filter(a => WEEK_RE.test(a));
  if (bi >= 0 && !WEEK_RE.test(args[bi + 1] || '')) throw new Error('--before behöver en vecka, t.ex. 2026-V40');
  const missing = weeks.filter(w => !known.includes(w));
  if (missing.length) throw new Error(`finns inte i molnet: ${missing.join(', ')}`);
  if (!weeks.length) throw new Error('ange vilka veckor som ska tas bort (se list)');

  const size = all.filter(o => weeks.includes(o.week)).reduce((s, o) => s + o.size, 0);
  console.log(`Tar bort permanent från molnet: ${weeks.join(', ')} (${kb(size)}). Det går inte att ångra.`);
  if (!yes) {
    if (!process.stdin.isTTY) throw new Error('lägg till --yes för att ta bort utan fråga');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Skriv "ta bort" för att bekräfta: ')).trim();
    rl.close();
    if (answer !== 'ta bort') return console.log('avbrutet, inget togs bort');
  }
  const today = new Date().toLocaleDateString('sv-SE');
  for (const w of weeks) {
    const manifests = await weekManifests(c, w);
    await c.gcloud('storage', 'rm', `${c.bucket}/${w}/**`);
    await writeWeekNote(vault, w, manifests, today);
    console.log(`${w} borttagen`);
  }
  await writeIndex(vault, c);
}

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  const flag = f => { const i = args.indexOf(f); if (i >= 0) args.splice(i, 1); return i >= 0; };
  const dryRun = flag('--dry-run'), yes = flag('--yes');
  const [cmd = 'run', ...rest] = args;
  try {
    const cfg = await loadConfig();
    const c = cloud(cfg);
    const vault = cfg.vaults[VAULT_KEY] || null;
    if (cmd === 'run') await withLock(() => archive(cfg, c, vault, dryRun));
    else if (cmd === 'list') await list(c);
    else if (cmd === 'restore') await restore(c, vault, rest[0]);
    else if (cmd === 'delete') await withLock(() => remove(c, vault, rest, yes));
    else throw new Error(`okänt kommando ${cmd}`);
  } catch (e) {
    log('fel:', e.stderr || e.message);
    process.exit(1);
  }
}
