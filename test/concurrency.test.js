/**
 * Two-client concurrency test.
 *
 * Loads index.html into TWO independent jsdom windows ("Amanda's phone" and "Aidan's laptop")
 * wired to ONE shared in-memory Firestore that mimics the real semantics:
 *   - set()                  replaces the document wholesale
 *   - update(arrayUnion)     appends, de-duplicating by deep equality
 *   - update(arrayRemove)    removes deep-equal entries
 *   - runTransaction()       read-modify-write against current server state
 *   - onSnapshot             fires on every other client after a write
 *
 * Snapshot delivery is deliberately controllable: real devices don't learn about each other's
 * writes instantly, and the interesting bugs happen in that window. `holdSnapshots()` lets a
 * client go stale, which is exactly the "we both had the page open" case.
 *
 * Run:  node test/concurrency.test.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  .replace(/<script[^>]*\bsrc=["'][^"']*["'][^>]*>\s*<\/script>/gi, '');

const clone = v => JSON.parse(JSON.stringify(v));
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── The shared "server" ─────────────────────────────────────────────────────
const server = {
  docs: new Map(),               // docId → data
  subs: [],                      // {docId, cb, client}
  writeLog: [],
  get(docId) { return this.docs.has(docId) ? clone(this.docs.get(docId)) : undefined; },
  _notify(docId, exceptClient) {
    for (const s of this.subs) {
      if (s.docId !== docId) continue;
      if (s.client.held) { s.client.pending.add(docId); continue; }
      s.cb({
        exists: this.docs.has(docId),
        id: docId,
        data: () => this.get(docId),
        metadata: { hasPendingWrites: s.client === exceptClient },
      });
    }
  },
  set(docId, data, client) {
    this.writeLog.push({ docId, op: 'set', client: client.name });
    this.docs.set(docId, clone(data));
    this._notify(docId, client);
  },
  update(docId, data, client) {
    const cur = this.docs.has(docId) ? clone(this.docs.get(docId)) : {};
    for (const [k, v] of Object.entries(data)) {
      if (v && v.__arrayUnion) {
        const arr = Array.isArray(cur[k]) ? cur[k] : [];
        for (const item of v.__arrayUnion) if (!arr.some(x => deepEq(x, item))) arr.push(clone(item));
        cur[k] = arr;
        this.writeLog.push({ docId, op: 'arrayUnion', n: v.__arrayUnion.length, client: client.name });
      } else if (v && v.__arrayRemove) {
        const arr = Array.isArray(cur[k]) ? cur[k] : [];
        cur[k] = arr.filter(x => !v.__arrayRemove.some(item => deepEq(x, item)));
        this.writeLog.push({ docId, op: 'arrayRemove', client: client.name });
      } else if (k.includes('.')) {
        // Dotted field path, e.g. update({'months.2026-01': ...}) — touches ONLY that key and
        // leaves its siblings alone. This is what makes concurrent writes to different keys of the
        // same map safe, so the stub has to model it faithfully.
        const segs = k.split('.');
        let node = cur;
        for (const seg of segs.slice(0, -1)) {
          if (typeof node[seg] !== 'object' || node[seg] === null) node[seg] = {};
          node = node[seg];
        }
        const leaf = segs[segs.length - 1];
        if (v && v.__delete) delete node[leaf];
        else node[leaf] = clone(v);
        this.writeLog.push({ docId, op: v && v.__delete ? 'deleteField' : 'updateField', path: k, client: client.name });
      } else if (v && v.__delete) {
        delete cur[k];
        this.writeLog.push({ docId, op: 'deleteField', path: k, client: client.name });
      } else {
        cur[k] = clone(v);
        this.writeLog.push({ docId, op: 'update', client: client.name });
      }
    }
    this.docs.set(docId, cur);
    this._notify(docId, client);
  },
};

// ── Build a client ──────────────────────────────────────────────────────────
const errors = [];
function makeClient(name) {
  const client = { name, held: false, pending: new Set() };
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(`[${name}] ${e.message || e}`));

  const docStub = docId => ({
    onSnapshot(next) {
      const cb = typeof next === 'function' ? next : next && next.next;
      server.subs.push({ docId, cb, client });
      // Deliver current state immediately, like Firestore does on attach.
      cb({ exists: server.docs.has(docId), id: docId, data: () => server.get(docId),
           metadata: { hasPendingWrites: false } });
      return () => {};
    },
    set(data) { server.set(docId, data, client); return Promise.resolve(); },
    update(data) { server.update(docId, data, client); return Promise.resolve(); },
    get() { return Promise.resolve({ exists: server.docs.has(docId), id: docId,
                                     data: () => server.get(docId) }); },
  });

  const firebase = {
    initializeApp: () => ({}), apps: [],
    auth: () => ({ onAuthStateChanged: () => {}, signOut: () => Promise.resolve(), currentUser: null }),
    firestore: () => ({
      collection: () => ({ doc: docStub }),
      // Real runTransaction reads the CURRENT server value, not the client's stale copy.
      // `get` returns a SYNCHRONOUS thenable rather than a real Promise so the app's
      // `t.get(ref).then(...)` body runs before this call returns, letting the test assert
      // straight afterwards. What's under test here is write SEMANTICS (does a write merge or
      // overwrite, and what does it contain) — not microtask ordering — so collapsing the async
      // hop keeps the test deterministic without changing what it proves.
      runTransaction: fn => {
        const syncThenable = value => ({ then: cb => syncThenable(cb(value)) });
        return Promise.resolve(fn({
          get: ref => syncThenable({ exists: true, data: () => server.get(ref.__id) }),
          set: (ref, data) => server.set(ref.__id, data, client),
        }));
      },
      enablePersistence: () => Promise.resolve(), settings: () => {},
    }),
  };
  firebase.firestore.FieldValue = {
    arrayUnion: (...v) => ({ __arrayUnion: v }),
    arrayRemove: (...v) => ({ __arrayRemove: v }),
    delete: () => ({ __delete: true }),
  };

  const dom = new JSDOM(HTML, { runScripts: 'outside-only', pretendToBeVisual: true,
    url: 'https://example.com/', virtualConsole: vc });
  const w = dom.window;
  w.firebase = firebase;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLInputElement.prototype.showPicker = function () {};
  if (!w.crypto) w.crypto = {};
  let n = 0;
  // Distinct per client, so a collision in generated ids is a real collision and not an artifact.
  w.crypto.randomUUID = () => `${name.slice(0, 4)}0000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  w.navigator.vibrate = () => {};

  const bodies = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(HTML)) !== null) bodies.push(m[1]);
  try {
    w.eval(bodies.join('\n;\n') + '\n;window.__ev = function (s) { return eval(s); };');
  } catch (err) { errors.push(`[${name}] page threw: ${err.message}`); }

  client.dom = dom;
  client.w = w;
  client.ev = e => w.__ev(e);
  client.call = e => { w.__ev(e); };
  // Stop receiving snapshots (simulates a page that's been open a while) / catch up again.
  client.holdSnapshots = () => { client.held = true; };
  client.resumeSnapshots = () => {
    client.held = false;
    const docs = [...client.pending];
    client.pending.clear();
    for (const docId of docs) {
      for (const s of server.subs) {
        if (s.client !== client || s.docId !== docId) continue;
        s.cb({ exists: server.docs.has(docId), id: docId, data: () => server.get(docId),
               metadata: { hasPendingWrites: false } });
      }
    }
  };
  return client;
}

// runTransaction needs the doc id; tag the ref the app passes in.
// (The app calls db.collection('state').doc('expenses') then uses that ref inside the txn.)
function patchTxnRefs(client) {
  client.call(`(function(){
    const orig = db.collection;
    db.collection = function (c) {
      const col = orig.call(db, c);
      const od = col.doc;
      col.doc = function (id) { const r = od.call(col, id); r.__id = id; return r; };
      return col;
    };
  })()`);
}

// ── Harness ─────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) pass++; else { fail++; failures.push({ name, detail }); }
}
function eqn(a, b, name, tol = 0.005) {
  ok(Math.abs(a - b) < tol, name, `expected ${b}, got ${a}`);
}

const YEAR = String(new Date().getFullYear());
const MONTH = String(new Date().getMonth() + 1).padStart(2, '0');

// Seed the server BEFORE clients attach so both start in sync.
server.docs.set('expenses', { items: [
  { id: 'seed1', date: `${YEAR}-${MONTH}-01`, month: 'Seed', person: 'Amanda', category: 'Groceries',
    description: 'Seed row', amount: 100, shared: true, splitPct: 56 },
] });
server.docs.set('recurring', { items: [
  { id: 'rec-a', person: 'Aidan',  category: 'Housing', description: 'Mortgage', amount: 1833, shared: false },
  { id: 'rec-b', person: 'Amanda', category: 'Housing', description: 'Mortgage', amount: 1833, shared: false },
  { id: 'rec-c', person: 'Aidan',  category: 'Utilities', description: 'Power',  amount: 140,  shared: true  },
] });
server.docs.set('giftCards', { items: [
  { id: 'gcT', label: 'Target', amount: 50 },
  { id: 'gcA', label: 'Amazon', amount: 40 },
], spends: [] });
server.docs.set('todos', { items: [
  { id: 't1', text: 'Existing todo', cat: 'todo', done: false },
] });
server.docs.set('todoCategories', { items: [{ id: 'todo', label: '📋 To-Do' }] });
server.docs.set('settledMonths', { months: {} });
server.docs.set('splitPct', { aidan: 56 });
server.docs.set('okdOverlaps', { pairs: [] });
// Real trips backing the conflict test — an empty trip list is itself a case worth covering, and
// it is (see the prune guard), but here we want the accept path exercised against real ids.
server.docs.set('trips', { items: [
  { id: 'tripA', dates: 'Aug 21–23', sortDate: `${YEAR}-${MONTH}-21`, label: 'Camping' },
  { id: 'tripB', dates: 'Aug 22',    sortDate: `${YEAR}-${MONTH}-22`, label: 'Night Market' },
  { id: 'tripC', dates: 'Sep 5–7',   sortDate: `${YEAR}-09-05`,       label: 'Cabin' },
  { id: 'tripD', dates: 'Sep 6',     sortDate: `${YEAR}-09-06`,       label: 'Wedding' },
] });

const amanda = makeClient('amanda');
const aidan  = makeClient('aidan');
for (const c of [amanda, aidan]) { patchTxnRefs(c); c.call('initFirestore()'); }

ok(errors.length === 0, 'both clients load cleanly', errors.join('; '));
eqn(amanda.ev('expenses.length'), 1, 'Amanda sees the seed expense');
eqn(aidan.ev('expenses.length'), 1, 'Aidan sees the seed expense');

// ═════════════════════════════════════════════════════════════════════════════
// 1. Both add a DIFFERENT expense at the same time (neither has seen the other's)
// ═════════════════════════════════════════════════════════════════════════════
amanda.holdSnapshots(); aidan.holdSnapshots();
amanda.call(`(function(){
  document.getElementById('b-date').value = '${YEAR}-${MONTH}-10';
  document.getElementById('b-category').value = 'Dining';
  document.getElementById('b-desc').value = 'Amanda lunch';
  document.getElementById('b-amount').value = '25';
  document.getElementById('b-person').value = 'Amanda';
  addExpense();
})()`);
aidan.call(`(function(){
  document.getElementById('b-date').value = '${YEAR}-${MONTH}-10';
  document.getElementById('b-category').value = 'Dining';
  document.getElementById('b-desc').value = 'Aidan coffee';
  document.getElementById('b-amount').value = '7';
  document.getElementById('b-person').value = 'Aidan';
  addExpense();
})()`);
amanda.resumeSnapshots(); aidan.resumeSnapshots();
const serverItems = () => (server.get('expenses') || {}).items || [];
const descs = serverItems().map(e => e.description);
ok(descs.includes('Amanda lunch') && descs.includes('Aidan coffee'),
  'simultaneous adds from both people BOTH survive', JSON.stringify(descs));
eqn(serverItems().length, 3, 'no expense was clobbered');

// ═════════════════════════════════════════════════════════════════════════════
// 2. Both click "Load This Month" for recurring at the same time
// ═════════════════════════════════════════════════════════════════════════════
amanda.holdSnapshots(); aidan.holdSnapshots();
amanda.call('loadRecurring()');
aidan.call('loadRecurring()');
amanda.resumeSnapshots(); aidan.resumeSnapshots();
const recRows = serverItems().filter(e => e.recurringId);
const recIds = recRows.map(e => e.id);
const dupRecIds = recIds.filter((v, i) => recIds.indexOf(v) !== i);
ok(dupRecIds.length === 0,
  'double "Load This Month" does not double-charge the month',
  `duplicate ids: ${JSON.stringify(dupRecIds)} (all rows: ${JSON.stringify(recIds)})`);
eqn(recRows.length, 3, 'exactly the three templates were loaded, once each');
// And the money is right — not doubled.
const recTotal = recRows.reduce((s, e) => s + e.amount, 0);
eqn(recTotal, 1833 + 1833 + 140, 'recurring total is charged once, not twice');

// ═════════════════════════════════════════════════════════════════════════════
// 3. Amanda edits an expense while Aidan's copy is stale
// ═════════════════════════════════════════════════════════════════════════════
// Aidan goes stale, Amanda edits the seed row's amount via the transaction path.
// The inline edit form only exists if the transaction list has painted.
for (const c of [amanda, aidan]) c.call("showPage('budget'); renderBudget()");
aidan.holdSnapshots();
amanda.call(`(function(){
  editExpense('seed1');
  if (!document.getElementById('txe-amt-seed1')) throw new Error('edit form did not open');
  document.getElementById('txe-amt-seed1').value = '175.50';
  saveExpenseEdit('seed1');
})()`);
const seedAfter = serverItems().find(e => e.id === 'seed1');
eqn(seedAfter ? seedAfter.amount : NaN, 175.50, "Amanda's edit reached the server");
eqn(serverItems().length, 6, "Amanda's edit did not drop the rows Aidan had added");
aidan.resumeSnapshots();
eqn(aidan.ev("expenses.find(e=>e.id==='seed1').amount"), 175.50, 'Aidan catches up to the edit');

// ═════════════════════════════════════════════════════════════════════════════
// 4. Gift cards — both log a spend on DIFFERENT cards simultaneously
// ═════════════════════════════════════════════════════════════════════════════
amanda.holdSnapshots(); aidan.holdSnapshots();
amanda.call("useGiftCard('gcT', 12)");
aidan.call("useGiftCard('gcA', 8)");
amanda.resumeSnapshots(); aidan.resumeSnapshots();
const gcDoc = () => server.get('giftCards') || {};
const spendsFor = id => (gcDoc().spends || []).filter(s => s.cardId === id);
const tSpent = spendsFor('gcT').reduce((s, r) => s + r.amount, 0);
const aSpent = spendsFor('gcA').reduce((s, r) => s + r.amount, 0);
ok(tSpent === 12 && aSpent === 8,
  'simultaneous gift-card spends on different cards BOTH survive',
  `Target logged ${tSpent} (expected 12), Amazon logged ${aSpent} (expected 8)`);

// 4b. Both log a spend on the SAME card simultaneously.
amanda.holdSnapshots(); aidan.holdSnapshots();
amanda.call("useGiftCard('gcT', 5)");
aidan.call("useGiftCard('gcT', 3)");
amanda.resumeSnapshots(); aidan.resumeSnapshots();
const tSpent2 = spendsFor('gcT').reduce((s, r) => s + r.amount, 0);
ok(tSpent2 === 20,
  'two spends on the SAME card at once are both recorded',
  `Target total spend is ${tSpent2}, expected 20 (12 + 5 + 3) — a lost spend means the card ` +
  `shows more money left than it really has`);

// ═════════════════════════════════════════════════════════════════════════════
// 5. To-dos — both add one at the same time
// ═════════════════════════════════════════════════════════════════════════════
// The per-category add input only exists once the to-do list has painted.
for (const c of [amanda, aidan]) c.call('renderTodos()');
amanda.holdSnapshots(); aidan.holdSnapshots();
amanda.call(`(function(){ document.getElementById('add-todo').value = 'Amanda task'; addTodo('todo'); })()`);
aidan.call(`(function(){ document.getElementById('add-todo').value = 'Aidan task'; addTodo('todo'); })()`);
amanda.resumeSnapshots(); aidan.resumeSnapshots();
const todoTexts = ((server.get('todos') || {}).items || []).map(t => t.text);
ok(todoTexts.includes('Amanda task') && todoTexts.includes('Aidan task'),
  'simultaneous to-do adds BOTH survive', JSON.stringify(todoTexts));

// 5b. Amanda checks one off while Aidan adds a new one (stale copies)
for (const c of [amanda, aidan]) c.call('renderTodos()');
amanda.holdSnapshots(); aidan.holdSnapshots();
amanda.call("(function(){ const t = todos.find(x=>x.text==='Amanda task'); t.done = true; saveTodos(); })()");
aidan.call(`(function(){ document.getElementById('add-todo').value = 'Aidan later'; addTodo('todo'); })()`);
amanda.resumeSnapshots(); aidan.resumeSnapshots();
const todos2 = (server.get('todos') || {}).items || [];
ok(todos2.some(t => t.text === 'Aidan later'),
  "Aidan's new to-do is not erased by Amanda's checkbox save",
  JSON.stringify(todos2.map(t => t.text)));
ok((todos2.find(t => t.text === 'Amanda task') || {}).done === true,
  "Amanda's completion is not erased by Aidan's add");

// 5c. EDIT vs EDIT on two different to-dos — the case the two tests above do NOT cover.
// Both of those pass with whole-array writes, because an ADD uses arrayUnion and merges on the
// server. Two *edits* have no such protection: each client rewrites the whole array from its own
// stale copy, and the second write wins outright. This is the gap saveTodoItem closes.
for (const c of [amanda, aidan]) c.call('renderTodos()');
const tid = (c, text) => c.ev(`(todos.find(t=>t.text===${JSON.stringify(text)})||{}).id`);
const aTaskId = tid(amanda, 'Amanda task');
const bTaskId = tid(amanda, 'Aidan task');
ok(!!aTaskId && !!bTaskId, 'both to-dos have ids to target', `${aTaskId} / ${bTaskId}`);
amanda.holdSnapshots(); aidan.holdSnapshots();
// Amanda renames hers; Aidan sets a priority on his. Neither sees the other's change.
amanda.call(`(function(){
  const t = todos.find(x => x.id === '${aTaskId}');
  t.text = 'Amanda RENAMED';
  saveTodoItem('${aTaskId}');
})()`);
aidan.call(`cycleTodoPriority('${bTaskId}')`);
amanda.resumeSnapshots(); aidan.resumeSnapshots();
const todos3 = (server.get('todos') || {}).items || [];
const aAfter = todos3.find(t => t.id === aTaskId) || {};
const bAfter = todos3.find(t => t.id === bTaskId) || {};
ok(aAfter.text === 'Amanda RENAMED',
  "Amanda's rename survives Aidan's simultaneous priority change",
  JSON.stringify(todos3.map(t => ({t: t.text, p: t.priority}))));
ok(!!bAfter.priority && bAfter.priority !== 'none',
  "Aidan's priority change survives Amanda's simultaneous rename",
  JSON.stringify(bAfter));
// And nothing else in the list was collateral damage.
ok(todos3.some(t => t.text === 'Aidan later'), 'an untouched to-do is still there after both edits');
ok((todos3.find(t => t.id === aTaskId) || {}).done === true,
  "Amanda's earlier completion is still set after the rename");

// 5d. Completing a RECURRING to-do while the partner edits another one. The recurring path writes
// three fields at once (done/due/lastDone), so a clobber here would silently un-schedule a chore.
for (const c of [amanda, aidan]) c.call('renderTodos()');
amanda.call(`(function(){
  todos.push({id:'rec-1', text:'Furnace filter', cat:'todo', done:false,
              due:'2020-01-01', repeat:{every:3, unit:'month'}});
  saveTodos();
})()`);
amanda.resumeSnapshots(); aidan.resumeSnapshots();
for (const c of [amanda, aidan]) c.call('renderTodos()');
amanda.holdSnapshots(); aidan.holdSnapshots();
amanda.call("toggleTodo('rec-1')");
aidan.call(`(function(){
  const t = todos.find(x => x.id === '${bTaskId}');
  t.text = 'Aidan RENAMED';
  saveTodoItem('${bTaskId}');
})()`);
amanda.resumeSnapshots(); aidan.resumeSnapshots();
const todos4 = (server.get('todos') || {}).items || [];
const rec = todos4.find(t => t.id === 'rec-1') || {};
ok(rec.due && rec.due > '2026-01-01' && rec.done === false,
  'a recurring completion survives a simultaneous edit to another to-do',
  JSON.stringify(rec));
ok(!!rec.lastDone, 'and its lastDone stamp survives too', JSON.stringify(rec));
ok((todos4.find(t => t.id === bTaskId) || {}).text === 'Aidan RENAMED',
  "and the partner's rename is not clobbered by the recurring write",
  JSON.stringify(todos4.map(t => t.text)));

// ═════════════════════════════════════════════════════════════════════════════
// 5e. Calendar events — both edit a DIFFERENT event at the same time
// ═════════════════════════════════════════════════════════════════════════════
for (const c of [amanda, aidan]) {
  c.call(`(function(){
    datedEvents = [
      {id:'ev-a', date:'2026-09-10', text:'Vet appointment', time:null, endTime:null},
      {id:'ev-b', date:'2026-09-11', text:'Dinner with folks', time:null, endTime:null}
    ];
    saveDatedEvents();
  })()`);
}
amanda.holdSnapshots(); aidan.holdSnapshots();
amanda.call(`(function(){
  const e = datedEvents.find(x => x.id === 'ev-a');
  e.text = 'Vet — both cats';
  e.repeat = 'year';
  saveDatedEvent('ev-a');
})()`);
aidan.call(`(function(){
  const e = datedEvents.find(x => x.id === 'ev-b');
  e.time = '18:30';
  saveDatedEvent('ev-b');
})()`);
amanda.resumeSnapshots(); aidan.resumeSnapshots();
const evs = (server.get('datedEvents') || {}).items || [];
const evA = evs.find(e => e.id === 'ev-a') || {};
const evB = evs.find(e => e.id === 'ev-b') || {};
ok(evA.text === 'Vet — both cats', "Amanda's event edit survives", JSON.stringify(evs));
ok(evA.repeat === 'year', 'including the yearly flag she set', JSON.stringify(evA));
ok(evB.time === '18:30', "Aidan's simultaneous edit to a different event also survives", JSON.stringify(evB));
eqn(evs.length, 2, 'no event was duplicated or lost');

// ═════════════════════════════════════════════════════════════════════════════
// 5f. The transaction itself fails. _txUpdateItems falls back to a whole-array write, which is
// correct when you're OFFLINE but catastrophic under CONTENTION: 'aborted' means the server was
// reached and another writer won, so overwriting with our whole local array destroys exactly the
// edit the transaction existed to protect. Two different failure codes, two different behaviours.
// ═════════════════════════════════════════════════════════════════════════════
// The fake transaction rejects SYNCHRONOUSLY (a thenable whose .catch runs its callback right
// away), so the whole retry chain resolves inside the call and needs no microtask draining —
// this file is CommonJS and has no top-level await.
const txProbe = (code) => {
  amanda.call(`(function(){
    todos = [{id:'tx1', text:'mine', done:false}, {id:'tx2', text:'partner-owns-this', done:false}];
    window.__txTries = 0; window.__wholeWrites = 0;
    window.__realTx = db.runTransaction;
    window.__realCollection = db.collection;
    db.runTransaction = function(){
      window.__txTries++;
      return { catch: function(cb){ return cb({code: ${JSON.stringify(code)}}); } };
    };
    db.collection = function(){ return { doc: function(){ return {
      set: function(){ window.__wholeWrites++; return Promise.resolve(); },
      get: function(){ return Promise.resolve({exists:true, data:function(){ return {items: todos}; }}); }
    }; } }; };
    saveTodoItem('tx1');
    db.runTransaction = window.__realTx; db.collection = window.__realCollection;
    return window.__txTries + ':' + window.__wholeWrites;
  })()`);
  return {
    tries:  amanda.ev('window.__txTries'),
    writes: amanda.ev('window.__wholeWrites'),
  };
};

const contention = txProbe('aborted');
ok(contention.tries > 1, 'a contended transaction is retried rather than abandoned', `tries=${contention.tries}`);
ok(contention.writes === 0,
  "and never falls back to a whole-array write, which would erase the partner's edit",
  `whole-array writes=${contention.writes}`);

const offline = txProbe('unavailable');
ok(offline.tries === 1, 'an offline failure is not retried (pointless while disconnected)', `tries=${offline.tries}`);
ok(offline.writes === 1,
  'but it DOES fall back to the whole-array write the app has always done',
  `whole-array writes=${offline.writes}`);

// ═════════════════════════════════════════════════════════════════════════════
// 6. Settled months — both settle a DIFFERENT month at the same time
// ═════════════════════════════════════════════════════════════════════════════
amanda.holdSnapshots(); aidan.holdSnapshots();
amanda.call(`toggleMonthSettled('${YEAR}-01', 100, -100)`);
aidan.call(`toggleMonthSettled('${YEAR}-02', 200, 200)`);
amanda.resumeSnapshots(); aidan.resumeSnapshots();
const months = (server.get('settledMonths') || {}).months || {};
ok(months[`${YEAR}-01`] != null && months[`${YEAR}-02`] != null,
  'settling two different months at once keeps both',
  JSON.stringify(months));

// ═════════════════════════════════════════════════════════════════════════════
// 7. Deleting an expense on one client while the other has it open for edit
// ═════════════════════════════════════════════════════════════════════════════
const victim = serverItems().find(e => e.description === 'Aidan coffee');
amanda.call(`editExpense('${victim.id}')`);          // Amanda opens the row
aidan.call(`deleteExpense('${victim.id}')`);          // Aidan deletes it
amanda.call(`(function(){
  const el = document.getElementById('txe-amt-${victim.id}');
  if (el) { el.value = '9.99'; saveExpenseEdit('${victim.id}'); }
})()`);
const resurrected = serverItems().filter(e => e.id === victim.id);
ok(resurrected.length === 0,
  'editing a row the partner deleted does not resurrect it',
  `${resurrected.length} copies present: ${JSON.stringify(resurrected)}`);

// ═════════════════════════════════════════════════════════════════════════════
// 8. Accepted date conflicts — both accept a different conflict at once
// ═════════════════════════════════════════════════════════════════════════════
// Go through the real okOverlap() path (which is what the button calls) rather than poking the Set
// directly — the merge behaviour lives in how okOverlap tells saveOkdOverlaps what changed.
amanda.call("_overlapPairs = [['tripA','tripB']]");
aidan.call("_overlapPairs = [['tripC','tripD']]");
amanda.holdSnapshots(); aidan.holdSnapshots();
amanda.call("okOverlap('tripA')");
aidan.call("okOverlap('tripC')");
amanda.resumeSnapshots(); aidan.resumeSnapshots();
const pairs = (server.get('okdOverlaps') || {}).pairs || [];
ok(pairs.includes('tripA|tripB') && pairs.includes('tripC|tripD'),
  'accepting two different conflicts at once keeps both', JSON.stringify(pairs));

// ═════════════════════════════════════════════════════════════════════════════
// 9. Accepted conflicts must survive a render that happens before trips have loaded
// ═════════════════════════════════════════════════════════════════════════════
// Firestore snapshots arrive in arbitrary order, so renderDates can run with okdOverlaps populated
// and `trips` still empty. Pruning then would erase every accepted conflict permanently.
amanda.call("trips = []; renderDates()");
const survived = (server.get('okdOverlaps') || {}).pairs || [];
ok(survived.includes('tripA|tripB'),
  'a render with trips not yet loaded does NOT erase accepted conflicts',
  JSON.stringify(survived));

// ═════════════════════════════════════════════════════════════════════════════
ok(errors.length === 0, 'no runtime errors during concurrency exercise', errors.join('; '));

console.log('');
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('');
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.detail || ''}`);
  console.log('');
  amanda.dom.window.close(); aidan.dom.window.close();
  process.exit(1);
}
console.log('  Two-client concurrency behaves.\n');
amanda.dom.window.close(); aidan.dom.window.close();
process.exit(0);
