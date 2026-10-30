// Apple Notes via JXA. Körs av sync/sync.mjs:
//   osascript -l JavaScript sync/notes.js export            -> JSON med alla anteckningar
//   osascript -l JavaScript sync/notes.js apply <fil.json>  -> utför ändringar, skriver resultat som JSON
// Lösenordsskyddade anteckningar och papperskorgen hoppas över.

const SKIP_FOLDERS = ['Recently Deleted', 'Nyligen raderade'];

function folderPath(note) {
  const parts = [];
  let c = note.container();
  for (let i = 0; i < 10 && c; i++) {
    if (String(c.id()).includes('ICAccount')) break;
    parts.unshift(c.name());
    try { c = c.container(); } catch (e) { break; }
  }
  return parts;
}

function accountOf(note) {
  let c = note.container();
  for (let i = 0; i < 10 && c; i++) {
    if (String(c.id()).includes('ICAccount')) return c.name();
    try { c = c.container(); } catch (e) { break; }
  }
  return 'Okänt konto';
}

function exportAll(Notes) {
  const out = [];
  for (const acc of Notes.accounts()) {
    const notes = acc.notes;
    const ids = notes.id();
    if (!ids.length) continue;
    const names = notes.name(), texts = notes.plaintext(), mods = notes.modificationDate(),
      created = notes.creationDate(), locked = notes.passwordProtected();
    for (let i = 0; i < ids.length; i++) {
      if (locked[i]) continue;
      const n = notes[i];
      const folder = folderPath(n);
      if (folder.some(f => SKIP_FOLDERS.includes(f))) continue;
      out.push({
        id: ids[i], account: acc.name(), folder, title: names[i], text: texts[i],
        created: created[i].toISOString(), modified: mods[i].toISOString(),
        attachments: n.attachments.length,
      });
    }
  }
  return out;
}

function findFolder(Notes, account, path) {
  const acc = Notes.accounts().find(a => a.name() === account) || Notes.accounts().find(a => a.name() === 'iCloud') || Notes.defaultAccount();
  let container = acc;
  for (const name of path.length ? path : ['Notes']) {
    let f = container.folders().find(x => x.name() === name);
    if (!f) {
      f = Notes.Folder({ name });
      container.folders.push(f);
      f = container.folders().find(x => x.name() === name);
    }
    container = f;
  }
  return container;
}

function apply(Notes, changes) {
  const results = [];
  for (const c of changes) {
    try {
      if (c.op === 'update') {
        Notes.notes.byId(c.id).body = c.html;
        results.push({ ok: true, ref: c.ref, id: c.id });
      } else if (c.op === 'create') {
        const folder = findFolder(Notes, c.account, c.folder || []);
        const note = Notes.Note({ body: c.html });
        folder.notes.push(note);
        results.push({ ok: true, ref: c.ref });
      }
    } catch (e) {
      results.push({ ok: false, ref: c.ref, error: String(e) });
    }
  }
  return results;
}

function run(argv) {
  const Notes = Application('Notes');
  if (argv[0] === 'export') return JSON.stringify(exportAll(Notes));
  if (argv[0] === 'apply') {
    ObjC.import('Foundation');
    const text = $.NSString.stringWithContentsOfFileEncodingError(argv[1], $.NSUTF8StringEncoding, null);
    if (text.isNil()) throw new Error('kan inte läsa ' + argv[1]);
    const changes = JSON.parse(text.js);
    return JSON.stringify(apply(Notes, changes));
  }
  throw new Error('användning: notes.js export | apply <fil.json>');
}
