// Molnläge för webbappen: samma API som den lokala servern (/api/...), men
// läser och skriver Firestore. Agenten på Macen gör resten.
// Data hålls aktuell med realtidslyssnare, så sidans uppdatering var 4:e
// sekund läser från minnet och kostar inga extra läsningar.

if (window.CLOUD_MODE) {
  const V = '11.0.2';
  const [{ firebaseConfig }, { initializeApp }, A, F] = await Promise.all([
    import('./firebase-config.js'),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
  ]);

  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);

  const NAME_RE = /^[A-Za-z0-9_-]+$/;
  const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const store = { tasks: new Map(), state: new Map(), agent: null, runs: new Map(), files: new Map() };
  const subs = { runs: null, files: null };

  // Samma regler som install.sh --check
  function checkSchedule(s) {
    const p = (s || '').trim().split(/\s+/);
    const time = t => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t || '');
    switch (p[0]) {
      case 'every': {
        const m = (p[1] || '').match(/^(\d+)([smhSMH]?)$/);
        if (!m) return `ogiltigt intervall '${p[1] || ''}'`;
        const u = (m[2] || 's').toLowerCase();
        const secs = Number(m[1]) * (u === 'h' ? 3600 : u === 'm' ? 60 : 1);
        return secs >= 60 ? null : 'intervallet måste vara minst 60 sekunder';
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

  function validate(b) {
    if (typeof b.schedule !== 'string' || !b.schedule.trim()) return 'schema saknas';
    if (typeof b.prompt !== 'string' || !b.prompt.trim()) return 'prompt saknas';
    const err = checkSchedule(b.schedule);
    if (err) return err;
    const available = store.agent?.mcp || [];
    for (const m of b.mcp || []) {
      const s = available.find(x => x.name === m.name);
      if (!s) return `okänd MCP-server: ${m.name}`;
      if (!s.levels.includes(m.level)) return `${m.name} saknar nivån ${m.level}`;
    }
    return null;
  }

  const taskData = b => ({
    schedule: b.schedule.trim(),
    enabled: !!b.enabled,
    mcp: (b.mcp || []).map(m => ({ name: m.name, level: m.level })),
    prompt: b.prompt,
    updatedAt: F.serverTimestamp(),
  });

  function taskView(name) {
    const t = store.tasks.get(name);
    const s = store.state.get(name) || {};
    return {
      name, schedule: t.schedule, enabled: t.enabled, mcp: t.mcp || [], prompt: t.prompt,
      running: !!s.running, lastRun: s.lastRun || null, error: s.error || null,
    };
  }

  const agentOnline = () => {
    const ms = store.agent?.lastSeen?.toMillis?.();
    return !!ms && Date.now() - ms < 3 * 60_000;
  };

  // Prenumererar på körningar eller filer för en uppgift; bara en åt gången
  function subscribe(kind, name) {
    const cur = subs[kind];
    if (cur?.name === name) return cur.ready;
    cur?.unsub();
    const q = kind === 'runs'
      ? F.query(F.collection(db, 'runs'), F.where('task', '==', name), F.orderBy('start', 'desc'), F.limit(50))
      : F.query(F.collection(db, 'files'), F.where('task', '==', name));
    let resolve;
    const ready = new Promise(r => { resolve = r; });
    const unsub = F.onSnapshot(q, snap => {
      store[kind].set(name, snap.docs.map(d => d.data()));
      resolve();
    }, err => { console.error(err); resolve(); });
    subs[kind] = { name, unsub, ready };
    return ready;
  }

  async function requestRun(name) {
    if (!agentOnline()) throw new Error('Macen är offline, så uppgiften kan inte startas nu');
    const ref = await F.addDoc(F.collection(db, 'runRequests'), {
      task: name, status: 'pending', createdAt: F.serverTimestamp(),
    });
    // Vänta på att agenten svarar
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsub(); resolve({ started: true, pending: true }); }, 20_000);
      const unsub = F.onSnapshot(ref, d => {
        const r = d.data();
        if (!r || r.status === 'pending') return;
        clearTimeout(timer); unsub();
        r.status === 'started' ? resolve({ started: true }) : reject(new Error(r.error || 'nekades'));
      });
    });
  }

  async function cloudCall(method, url, body) {
    const u = new URL(url, location.origin);
    const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (parts[0] === 'status') {
      const a = store.agent || {};
      return {
        docker: !!a.docker, image: !!a.image, token: !!a.token,
        agentOnline: agentOnline(), lastSeen: a.lastSeen?.toDate?.().toISOString() || null,
      };
    }
    if (parts[0] === 'mcp') return store.agent?.mcp || [];
    if (parts[0] === 'check-schedule') {
      const err = checkSchedule(u.searchParams.get('s'));
      return { ok: !err, error: err };
    }
    if (parts[0] !== 'tasks') throw new Error('okänd adress');

    if (parts.length === 1) {
      if (method === 'GET') return [...store.tasks.keys()].sort().map(taskView);
      if (method === 'POST') {
        if (!NAME_RE.test(body.name || '')) throw new Error('namnet får bara innehålla A–Z, 0–9, - och _');
        if (store.tasks.has(body.name)) throw new Error(`uppgiften ${body.name} finns redan`);
        const err = validate(body);
        if (err) throw new Error(err);
        await F.setDoc(F.doc(db, 'tasks', body.name), taskData(body));
        return { task: { name: body.name } };
      }
    }

    const name = parts[1];
    if (!store.tasks.has(name)) throw new Error('uppgiften finns inte');

    if (parts.length === 2) {
      if (method === 'GET') return taskView(name);
      if (method === 'PUT') {
        const err = validate(body);
        if (err) throw new Error(err);
        const to = body.name || name;
        if (to === name) {
          await F.setDoc(F.doc(db, 'tasks', name), taskData(body));
        } else {
          if (!NAME_RE.test(to)) throw new Error('namnet får bara innehålla A–Z, 0–9, - och _');
          if (store.tasks.has(to)) throw new Error(`uppgiften ${to} finns redan`);
          if (store.state.get(name)?.running) throw new Error('kan inte byta namn medan uppgiften körs');
          // Atomärt, så att agenten ser namnbytet i en och samma ändring
          const batch = F.writeBatch(db);
          batch.set(F.doc(db, 'tasks', to), { ...taskData(body), renamedFrom: name });
          batch.delete(F.doc(db, 'tasks', name));
          await batch.commit();
        }
        return { task: { name: to } };
      }
      if (method === 'DELETE') {
        await F.deleteDoc(F.doc(db, 'tasks', name));
        return { deleted: name };
      }
    }

    if (parts[2] === 'run' && method === 'POST') return requestRun(name);

    if (parts[2] === 'runs') {
      await subscribe('runs', name);
      const runs = store.runs.get(name) || [];
      if (parts.length === 3) return runs.map(r => ({ id: r.id, start: r.start, exit: r.exit, running: r.running }));
      const r = runs.find(x => x.id === parts[3]);
      if (!r) throw new Error('körningen finns inte');
      return { id: r.id, log: r.log || '' };
    }

    if (parts[2] === 'files') {
      await subscribe('files', name);
      const files = (store.files.get(name) || []).slice().sort((a, b) => a.path.localeCompare(b.path));
      if (parts.length === 3) return files.map(f => ({ path: f.path, size: f.size, modified: f.modified }));
      const f = files.find(x => x.path === parts.slice(3).join('/'));
      if (!f) throw new Error('filen finns inte');
      if (f.content == null) throw new Error(`Filen visas inte: ${f.note || 'inget innehåll'}`);
      return f.content;
    }

    throw new Error('metoden stöds inte');
  }

  // ---------- inloggning ----------

  const overlay = document.createElement('div');
  overlay.className = 'login';
  const card = document.createElement('div');
  card.className = 'card';
  overlay.append(card);
  document.body.append(overlay);

  function showLogin(message) {
    const h = document.createElement('h2');
    h.textContent = 'Local Automation';
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = message || 'Logga in med ditt Google-konto för att hantera uppgifter.';
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Logga in med Google';
    btn.onclick = async () => {
      const provider = new A.GoogleAuthProvider();
      try { await A.signInWithPopup(auth, provider); }
      catch (e) {
        if (e.code === 'auth/popup-blocked') await A.signInWithRedirect(auth, provider);
        else showLogin(e.message);
      }
    };
    card.replaceChildren(h, p, btn);
    overlay.hidden = false;
  }

  let started = false;
  A.onAuthStateChanged(auth, async user => {
    if (!user) return showLogin();
    card.replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Ansluter…' }));

    const firsts = ['tasks', 'taskState', 'agent'].map(c => new Promise((resolve, reject) => {
      F.onSnapshot(F.collection(db, c), snap => {
        if (c === 'tasks') store.tasks = new Map(snap.docs.map(d => [d.id, d.data()]));
        else if (c === 'taskState') store.state = new Map(snap.docs.map(d => [d.id, d.data()]));
        else store.agent = snap.docs.find(d => d.id === 'status')?.data() || null;
        resolve();
      }, reject);
    }));
    try { await Promise.all(firsts); }
    catch {
      await A.signOut(auth);
      return showLogin(`${user.email} har inte åtkomst. Logga in med kontot som äger appen.`);
    }

    overlay.hidden = true;
    window.cloudCall = cloudCall;
    const out = document.createElement('button');
    out.textContent = 'Logga ut';
    out.onclick = () => A.signOut(auth).then(() => location.reload());
    document.querySelector('header').append(out);
    if (!started) { started = true; window.startApp(); }
  });
}
