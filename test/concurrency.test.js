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

const HTML = fs.readFileSync(process.env.OW_HTML || path.join(__dirname, '..', 'index.html'), 'utf8')
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
      // Every key is a field PATH. 'months.2026-01' or 'plan._pinnedTodos' touch ONLY that leaf and
      // leave siblings alone, and array transforms work on nested paths too — exactly what real
      // Firestore does. Concurrent writes to different keys of one map are only safe because of
      // this, so the stub has to model it faithfully.
      const segs = k.split('.');
      let node = cur;
      for (const seg of segs.slice(0, -1)) {
        if (typeof node[seg] !== 'object' || node[seg] === null) node[seg] = {};
        node = node[seg];
      }
      const leaf = segs[segs.length - 1];
      if (v && v.__arrayUnion) {
        const arr = Array.isArray(node[leaf]) ? node[leaf] : [];
        for (const item of v.__arrayUnion) if (!arr.some(x => deepEq(x, item))) arr.push(clone(item));
        node[leaf] = arr;
        this.writeLog.push({ docId, op: 'arrayUnion', path: k, n: v.__arrayUnion.length, client: client.name });
      } else if (v && v.__arrayRemove) {
        const arr = Array.isArray(node[leaf]) ? node[leaf] : [];
        node[leaf] = arr.filter(x => !v.__arrayRemove.some(item => deepEq(x, item)));
        this.writeLog.push({ docId, op: 'arrayRemove', path: k, client: client.name });
      } else if (v && v.__delete) {
        delete node[leaf];
        this.writeLog.push({ docId, op: 'deleteField', path: k, client: client.name });
      } else {
        node[leaf] = clone(v);
        this.writeLog.push({ docId, op: segs.length > 1 ? 'updateField' : 'update', path: k, client: client.name });
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
    // Real update() rejects on a missing document; code must handle that by creating it.
    update(data) {
      if (!server.docs.has(docId)) return Promise.reject(Object.assign(new Error('No document to update'), { code: 'not-found' }));
      server.update(docId, data, client); return Promise.resolve();
    },
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
          // {merge:true} is a FIELD-level write: fields not named in `data` are left alone. Without
          // modelling that, a transaction writing only {items} to the giftCards doc would appear to
          // erase `spends` — a failure the real database would never produce. server.update() has
          // exactly merge semantics for plain values, so route through it.
          set: (ref, data, opts) => (opts && opts.merge)
            ? server.update(ref.__id, data, client)
            : server.set(ref.__id, data, client),
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
  w.scrollTo = function () {};
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
// 5g. Whole-document writes that were still left over after the first pass. Each of these used to
// overwrite an entire array (or, for giftCards, an entire two-array document) with the local copy.
// ═════════════════════════════════════════════════════════════════════════════

// Deleting a gift card while the partner logs a redemption on a DIFFERENT card. The delete has to
// take the card AND its own spends, and nothing else.
amanda.holdSnapshots(); aidan.holdSnapshots();
// Aidan writes FIRST, then Amanda acts on her now-stale copy. That ordering is what makes a
// whole-document write destructive — reverse it and even the buggy version passes.
aidan.call("useGiftCard('gcA', 5)");
amanda.call("deleteGiftCard('gcT')");
amanda.resumeSnapshots(); aidan.resumeSnapshots();
const gcAfter = server.get('giftCards') || {};
ok(!(gcAfter.items || []).some(c => c.id === 'gcT'), 'the deleted gift card is gone',
  JSON.stringify(gcAfter.items));
ok((gcAfter.items || []).some(c => c.id === 'gcA'), "the partner's card is untouched",
  JSON.stringify(gcAfter.items));
ok(!(gcAfter.spends || []).some(s => s.cardId === 'gcT'),
  "the deleted card's spends go with it — no dangling redemptions",
  JSON.stringify(gcAfter.spends));
ok((gcAfter.spends || []).some(s => s.cardId === 'gcA' && s.amount === 5),
  'the redemption logged on the other card at the same moment SURVIVES the delete',
  JSON.stringify(gcAfter.spends));

// Setting an expiry writes only {items}; `spends` must survive because it is a merge, not a set.
const spendsBefore = ((server.get('giftCards') || {}).spends || []).length;
amanda.call("setGiftCardExpiry('gcA', '2027-01-15')");
const gcExp = server.get('giftCards') || {};
ok((gcExp.items || []).find(c => c.id === 'gcA') && (gcExp.items || []).find(c => c.id === 'gcA').expires === '2027-01-15',
  'the expiry lands on the card', JSON.stringify(gcExp.items));
ok((gcExp.spends || []).length === spendsBefore,
  'and writing it does not drop the spends array alongside it',
  ((gcExp.spends || []).length) + ' spends, expected ' + spendsBefore);

// Offline: transactions are unavailable, so setGiftCardExpiry falls back to a whole-document
// set(). That write is NOT a merge, so it has to carry `spends` too — otherwise editing an expiry
// with no signal would silently erase every redemption ever logged.
amanda.call(`(function(){
  window.__realTx = db.runTransaction;
  db.runTransaction = function(){
    return { catch: function(cb){ return cb({code: 'unavailable'}); } };
  };
  setGiftCardExpiry('gcA', '2028-03-01');
  db.runTransaction = window.__realTx;
})()`);
const gcOff = server.get('giftCards') || {};
ok((gcOff.items || []).find(c => c.id === 'gcA') && (gcOff.items || []).find(c => c.id === 'gcA').expires === '2028-03-01',
  'an expiry set while offline still lands', JSON.stringify(gcOff.items));
ok((gcOff.spends || []).some(s => s.cardId === 'gcA'),
  'and the offline fallback write does NOT wipe the redemption history',
  JSON.stringify(gcOff.spends));

// Recurring templates: delete one while the partner edits another. These are monthly bills.
amanda.holdSnapshots(); aidan.holdSnapshots();
aidan.call(`(function(){
  const r = recurringItems.find(x => x.id === 'rec-a');
  r.amount = 1900;
  saveRecurringItem('rec-a');
})()`);
amanda.call("deleteRecurring('rec-c')");   // stale client writes last — see note above
amanda.resumeSnapshots(); aidan.resumeSnapshots();
const recAfter = ((server.get('recurring') || {}).items) || [];
ok(!recAfter.some(r => r.id === 'rec-c'), 'the deleted template is gone', JSON.stringify(recAfter));
ok(recAfter.find(r => r.id === 'rec-a') && recAfter.find(r => r.id === 'rec-a').amount === 1900,
  "the partner's simultaneous edit to a different template survives",
  JSON.stringify(recAfter.find(r => r.id === 'rec-a')));
ok(recAfter.length === 2, 'no template was duplicated or lost', recAfter.length + ' present');

// Clearing completed to-dos while the partner adds a new one.
// Seed both clients explicitly — scenario 5f above replaced Amanda's local todos array.
for (const c of [amanda, aidan]) {
  c.call(`(function(){
    todos = [{id:'tc-done', text:'Finished thing', cat:'todo', done:true}];
    saveTodos();
  })()`);
}
amanda.holdSnapshots(); aidan.holdSnapshots();
aidan.call(`(function(){
  const el = document.getElementById('add-todo');
  if (!el) throw new Error('no add-todo input');
  el.value = 'Aidan new task';
  addTodo('todo');
})()`);
amanda.call('clearCompletedTodos()');   // stale client writes last — see note above
amanda.resumeSnapshots(); aidan.resumeSnapshots();
const todosAfter = ((server.get('todos') || {}).items) || [];
ok(!todosAfter.some(t => t.id === 'tc-done'), 'the completed to-do was cleared',
  JSON.stringify(todosAfter.map(t => t.text)));
ok(todosAfter.some(t => t.text === 'Aidan new task'),
  'the to-do the partner added while the done pile was being cleared SURVIVES',
  JSON.stringify(todosAfter.map(t => t.text)));

// Deleting a calendar event while the partner creates a different one.
for (const c of [amanda, aidan]) {
  c.call(`(function(){
    datedEvents = [{id:'ev-del', date:'2026-09-20', text:'Old thing', time:null, endTime:null}];
    saveDatedEvents();
  })()`);
}
amanda.holdSnapshots(); aidan.holdSnapshots();
aidan.call(`(function(){
  const e = {id:'ev-new', date:'2026-09-21', text:'Aidan new event', time:null, endTime:null};
  datedEvents.push(e);
  _addDatedEvent(e);
})()`);
amanda.call("removeEvent('ev-del')");   // stale client writes last — see note above
amanda.resumeSnapshots(); aidan.resumeSnapshots();
const evAfter = ((server.get('datedEvents') || {}).items) || [];
ok(!evAfter.some(e => e.id === 'ev-del'), 'the deleted event is gone', JSON.stringify(evAfter));
ok(evAfter.some(e => e.id === 'ev-new'),
  'the event the partner created at the same moment is NOT erased by the delete',
  JSON.stringify(evAfter));

// ═════════════════════════════════════════════════════════════════════════════
// 5h. The SAME races with the roles reversed. A whole-array write only destroys what is already on
// the server, so each ordering catches a different call site: 5g catches the deleter, 5h catches
// the adder/editor. Both are needed — with only one ordering, half these conversions could be
// reverted and the suite would stay green.
// ═════════════════════════════════════════════════════════════════════════════

// Amanda deletes a template first; Aidan then edits a DIFFERENT one from a stale copy.
// If his edit wrote the whole array, it would resurrect the template she just deleted.
for (const c of [amanda, aidan]) {
  c.call(`(function(){
    recurringItems = [
      {id:'rm-1', person:'Aidan',  category:'Utilities', description:'Water', amount:60, shared:true},
      {id:'rm-2', person:'Amanda', category:'Subscriptions', description:'Spotify', amount:12, shared:true}
    ];
    saveRecurring();
  })()`);
}
amanda.holdSnapshots(); aidan.holdSnapshots();
amanda.call("deleteRecurring('rm-1')");
aidan.call(`(function(){
  renderRecurring();
  editRecurring('rm-2');
  const amt = document.getElementById('rece-amt-rm-2');
  if (!amt) throw new Error('recurring edit row did not render');
  amt.value = '15';
  saveRecurringEdit('rm-2');
})()`);
amanda.resumeSnapshots(); aidan.resumeSnapshots();
const recMirror = ((server.get('recurring') || {}).items) || [];
ok(!recMirror.some(r => r.id === 'rm-1'),
  "editing a template does not resurrect one the partner deleted a moment earlier",
  JSON.stringify(recMirror));
ok(recMirror.find(r => r.id === 'rm-2') && recMirror.find(r => r.id === 'rm-2').amount === 15,
  'and the edit itself still lands', JSON.stringify(recMirror));

// Amanda deletes an event first; Aidan then creates one from a stale copy.
for (const c of [amanda, aidan]) {
  c.call(`(function(){
    datedEvents = [{id:'em-gone', date:'2026-10-01', text:'Cancelled thing', time:null, endTime:null}];
    saveDatedEvents();
  })()`);
}
amanda.holdSnapshots(); aidan.holdSnapshots();
amanda.call("removeEvent('em-gone')");
aidan.call(`(function(){
  const e = {id:'em-fresh', date:'2026-10-02', text:'Brand new', time:null, endTime:null};
  datedEvents.push(e);
  _addDatedEvent(e);
})()`);
amanda.resumeSnapshots(); aidan.resumeSnapshots();
const evMirror = ((server.get('datedEvents') || {}).items) || [];
ok(!evMirror.some(e => e.id === 'em-gone'),
  'creating an event does not resurrect one the partner just deleted',
  JSON.stringify(evMirror));
ok(evMirror.some(e => e.id === 'em-fresh'), 'and the new event is there',
  JSON.stringify(evMirror));

// Amanda clears the done pile first; Aidan then completes a to-do from a stale copy.
for (const c of [amanda, aidan]) {
  c.call(`(function(){
    todos = [
      {id:'tm-done', text:'Already finished', cat:'todo', done:true},
      {id:'tm-open', text:'Still open', cat:'todo', done:false}
    ];
    saveTodos();
  })()`);
}
amanda.holdSnapshots(); aidan.holdSnapshots();
amanda.call('clearCompletedTodos()');
aidan.call(`(function(){
  const t = todos.find(x => x.id === 'tm-open');
  t.text = 'Still open (renamed)';
  saveTodoItem('tm-open');
})()`);
amanda.resumeSnapshots(); aidan.resumeSnapshots();
const todosMirror = ((server.get('todos') || {}).items) || [];
ok(!todosMirror.some(t => t.id === 'tm-done'),
  'renaming a to-do does not resurrect the completed pile the partner just cleared',
  JSON.stringify(todosMirror.map(t => t.text)));
ok(todosMirror.find(t => t.id === 'tm-open') && todosMirror.find(t => t.id === 'tm-open').text === 'Still open (renamed)',
  'and the rename lands', JSON.stringify(todosMirror.map(t => t.text)));

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
// 10. Races found by the Nov 2026 health check — each on a FRESH server + two fresh clients
// ═════════════════════════════════════════════════════════════════════════════
// Every race runs in BOTH orderings: a stale whole-array write only destroys what is already on
// the server, so one ordering passes even when the code is broken. Each drives the real entry
// point (editTodo, setEditHeart, addTodoSection...), not the save helper underneath.
const _raceClients = [];
function fresh(seed) {
  server.docs.clear(); server.subs.length = 0; server.writeLog.length = 0;
  for (const [k, v] of Object.entries(seed)) server.docs.set(k, clone(v));
  const a = makeClient('amanda'), b = makeClient('aidan');
  for (const c of [a, b]) { patchTxnRefs(c); c.call('initFirestore()'); }
  _raceClients.push(a, b);
  return [a, b];
}
const raceSeed = {
  todos: { items: [{ id: 't1', text: 'Old text', cat: 'todo', done: false },
                   { id: 't2', text: 'Second', cat: 'todo', done: false }] },
  todoCategories: { items: [{ id: 'todo', label: 'To-Do' }] },
  logistics: { items: [{ id: 'log-1', text: 'Old logistics' }] },
  bucket: { items: [{ id: 'bkt-1', text: 'Old bucket' }] },
  trips: { items: [
    { id: 'rtA', dates: 'Dec 1',  sortDate: `${Number(YEAR) + 1}-12-01`, label: 'A 🏕' },
    { id: 'rtB', dates: 'Dec 9',  sortDate: `${Number(YEAR) + 1}-12-09`, label: 'B 🏕' },
    { id: 'rtC', dates: 'Dec 20', sortDate: `${Number(YEAR) + 1}-12-20`, label: 'C 🏕' } ] },
  entries: { items: [{ id: 'e1', week: 'w', date: `${YEAR}-01-05`, hearts: 0 }] },
  weekplan: { plan: { _weekKey: '2099-01-05', _pinnedTodos: ['t1'] } },
  budgetTargets: { targets: { Fun: 50 } },
  datedEvents: { items: [] }, expenses: { items: [] }, recurring: { items: [] },
  giftCards: { items: [], spends: [] }, mood: {}, countdowns: { items: [] },
  settledMonths: { months: {} }, okdOverlaps: { pairs: [] }, splitPct: { aidan: 56 },
};
const S = d => server.get(d);

// Edit inputs hold the object captured when they opened; a partner snapshot swaps the array.
{
  const [a, b] = fresh(raceSeed);
  b.call("showPage('todos'); renderTodos()");
  a.call("showPage('todos'); renderTodos(); editTodo('t1')");
  b.call("document.getElementById('add-todo').value = 'Aidan new'; addTodo('todo')");
  a.call("(function(){ const i = document.querySelector('.todo-edit-input'); i.value = 'Amanda edited'; i.dispatchEvent(new Event('blur')); })()");
  const items = S('todos').items;
  ok(items.find(x => x.id === 't1').text === 'Amanda edited' && items.some(x => x.text === 'Aidan new'),
    'editing a to-do while the partner adds one keeps both', JSON.stringify(items.map(x => x.text)));
}
{
  const [a, b] = fresh(raceSeed);
  b.call("showPage('dates'); renderDates()");
  a.call("showPage('dates'); renderDates(); editListItem('log-1')");
  b.call("document.getElementById('new-logistics').value = 'Aidan item'; addListItem('logistics')");
  a.call("(function(){ const i = document.querySelector('#list-item-log-1 input'); i.value = 'Amanda edited'; i.dispatchEvent(new Event('blur')); })()");
  const items = S('logistics').items;
  ok(items.find(x => x.id === 'log-1').text === 'Amanda edited' && items.some(x => x.text === 'Aidan item'),
    'editing a logistics item while the partner adds one keeps both', JSON.stringify(items.map(x => x.text)));
}
for (const order of ['aidanFirst', 'amandaFirst']) {
  // Week plan: Amanda is typing (her snapshot is held back) while Aidan saves.
  const [a, b] = fresh(raceSeed);
  for (const c of [a, b]) c.call("showPage('dates'); renderPlan()");
  const focusA = "document.querySelector('#plan-meals input[oninput*=\"mon\"]').focus()";
  const amandaSave = () => a.call(`(function(){ ${focusA}; updateMeal('mon','dinner','Tacos'); clearTimeout(_planDebounce); savePlan(); })()`);
  const aidanSave  = () => b.call("updateMeal('sat','lunch','Pho'); clearTimeout(_planDebounce); savePlan()");
  if (order === 'aidanFirst') { a.call(focusA); aidanSave(); amandaSave(); } else { amandaSave(); aidanSave(); }
  const p = S('weekplan').plan;
  ok(p.mon?.meals?.dinner === 'Tacos' && p.sat?.meals?.lunch === 'Pho' && p._pinnedTodos?.includes('t1'),
    `week plan: both partners' meals survive (${order})`, JSON.stringify(p));
}
for (const order of ['amandaFirst', 'aidanFirst']) {
  // Pins are a set: two people pinning different to-dos at once both stick.
  const [a, b] = fresh(raceSeed);
  a.holdSnapshots(); b.holdSnapshots();
  const pa = () => a.call("weekPlan._pinnedTodos = [...(weekPlan._pinnedTodos||[]), 't2']; savePlan()");
  const pb = () => b.call("weekPlan._pinnedTodos = []; savePlan()");   // Aidan unpins t1
  if (order === 'amandaFirst') { pa(); pb(); } else { pb(); pa(); }
  a.resumeSnapshots(); b.resumeSnapshots();
  const pins = S('weekplan').plan._pinnedTodos;
  ok(JSON.stringify(pins) === '["t2"]', `week plan: a pin and an unpin at once both apply (${order})`, JSON.stringify(pins));
}
{
  // Clearing the week still clears it — the diff has to send deletes, not just sets.
  const [a] = fresh({ ...raceSeed, weekplan: { plan: { _weekKey: '2099-01-05', _pinnedTodos: ['t1'], mon: { meals: { dinner: 'Tacos' } }, notes: 'hi' } } });
  a.call("weekPlan = { _pinnedTodos: weekPlan._pinnedTodos || [], _weekKey: '2099-01-12' }; savePlan()");
  const p = S('weekplan').plan;
  ok(!p.mon && !p.notes && p._weekKey === '2099-01-12' && p._pinnedTodos.includes('t1'),
    'week plan: clearing the week removes meals and notes but keeps pins', JSON.stringify(p));
}
{
  // Pins must survive a render that happens before the to-dos snapshot arrives.
  const [a] = fresh(raceSeed);
  a.call("todos = []; _todosLoaded = false; showPage('dates'); renderPlan()");
  const p = S('weekplan').plan._pinnedTodos;
  ok(Array.isArray(p) && p.includes('t1'), 'pinned to-dos survive a render before to-dos load', JSON.stringify(p));
  a.call("_todosLoaded = true; todos = todos.filter(t => t.id !== 't1'); renderPlan()");
  ok(!(S('weekplan').plan._pinnedTodos || []).includes('t1'), '…but a pin whose to-do really was deleted is still cleaned up',
    JSON.stringify(S('weekplan').plan._pinnedTodos));
}
for (const order of ['amandaFirst', 'aidanFirst']) {
  const [a, b] = fresh(raceSeed);
  a.holdSnapshots(); b.holdSnapshots();
  const ea = () => a.call("_currentTripId = 'rtA'; saveTripField('notes', 'Amanda notes'); saveTrips({immediate:true})");
  const eb = () => b.call("_currentTripId = 'rtB'; saveTripField('notes', 'Aidan notes'); saveTrips({immediate:true})");
  if (order === 'amandaFirst') { ea(); eb(); } else { eb(); ea(); }
  a.resumeSnapshots(); b.resumeSnapshots();
  const it = S('trips').items;
  ok(it.find(t => t.id === 'rtA').notes === 'Amanda notes' && it.find(t => t.id === 'rtB').notes === 'Aidan notes',
    `trips: edits to two different trips both survive (${order})`, JSON.stringify(it.map(t => [t.id, t.notes])));
}
for (const order of ['addFirst', 'deleteFirst']) {
  const [a, b] = fresh(raceSeed);
  b.call("showPage('dates'); renderDates()");
  a.holdSnapshots(); b.holdSnapshots();
  const add = () => b.call("document.getElementById('new-trip-dates').value = 'Jan 5, 2099'; document.getElementById('new-trip-name').value = 'Ski'; addTrip()");
  const del = () => a.call("deleteTrip('rtC')");
  if (order === 'addFirst') { add(); del(); } else { del(); add(); }
  a.resumeSnapshots(); b.resumeSnapshots();
  const it = S('trips').items;
  ok(it.some(t => /Ski/.test(t.label)) && !it.some(t => t.id === 'rtC'),
    `trips: the partner's new trip survives a delete (${order})`, JSON.stringify(it.map(t => t.label)));
}
{
  // Undo of a delete puts the trip back without erasing anything else.
  const [a, b] = fresh(raceSeed);
  a.call("showPage('dates'); renderDates(); deleteTrip('rtC')");
  ok(!S('trips').items.some(t => t.id === 'rtC'), 'deleting a trip removes it');
  b.call("_currentTripId = 'rtA'; saveTripField('notes', 'Aidan during undo'); saveTrips({immediate:true})");
  a.call("_doUndo()");   // the toast button is an inline onclick, which jsdom outside-only never compiles
  const it = S('trips').items;
  ok(it.some(t => t.id === 'rtC') && it.find(t => t.id === 'rtA').notes === 'Aidan during undo',
    "undoing a trip delete restores it and keeps the partner's edit", JSON.stringify(it.map(t => [t.id, t.notes])));
}
for (const order of ['amandaFirst', 'aidanFirst']) {
  const [a, b] = fresh(raceSeed);
  a.holdSnapshots(); b.holdSnapshots();
  const ra = () => a.call("setEditHeart('e1', 4, 'amanda')");
  const rb = () => b.call("setEditHeart('e1', 5, 'aidan')");
  if (order === 'amandaFirst') { ra(); rb(); } else { rb(); ra(); }
  a.resumeSnapshots(); b.resumeSnapshots();
  const e = S('entries').items[0];
  ok(e.heartsAmanda === 4 && e.heartsAidan === 5 && e.hearts === a.ev('_avgHearts(4, 5)'),
    `history: both partners' hearts survive and the average uses both (${order})`, JSON.stringify(e));
}
for (const order of ['amandaFirst', 'aidanFirst']) {
  const [a, b] = fresh(raceSeed);
  for (const c of [a, b]) c.call("showPage('todos'); renderTodos()");
  a.holdSnapshots(); b.holdSnapshots();
  const sa = () => a.call("document.getElementById('new-section-name').value = 'Amanda sec'; addTodoSection()");
  const sb = () => b.call("document.getElementById('new-section-name').value = 'Aidan sec'; addTodoSection()");
  if (order === 'amandaFirst') { sa(); sb(); } else { sb(); sa(); }
  a.resumeSnapshots(); b.resumeSnapshots();
  const l = S('todoCategories').items.map(c => c.label);
  ok(l.includes('Amanda sec') && l.includes('Aidan sec'), `to-do sections: two new sections both survive (${order})`, JSON.stringify(l));
}
for (const order of ['amandaFirst', 'aidanFirst']) {
  const [a, b] = fresh(raceSeed);
  a.holdSnapshots(); b.holdSnapshots();
  const sa = () => a.call("setBudgetTarget('Dining', '300')");
  const sb = () => b.call("setBudgetTarget('Groceries', '600')");
  if (order === 'amandaFirst') { sa(); sb(); } else { sb(); sa(); }
  a.resumeSnapshots(); b.resumeSnapshots();
  const t = S('budgetTargets').targets;
  ok(t.Dining === 300 && t.Groceries === 600 && t.Fun === 50, `budget targets: both categories survive (${order})`, JSON.stringify(t));
}
{
  const [a] = fresh(raceSeed);
  a.call("setBudgetTarget('Fun', '')");
  ok(!('Fun' in S('budgetTargets').targets), 'budget targets: clearing a target really deletes it', JSON.stringify(S('budgetTargets').targets));
}
{
  // A doc that doesn't exist yet: update() fails with not-found and the code must create it.
  const seed = { ...raceSeed }; delete seed.todoCategories;
  const [a] = fresh(seed);
  a.call("showPage('todos'); renderTodos(); document.getElementById('new-section-name').value = 'Brand new'; addTodoSection()");
  const cats = (S('todoCategories') || {}).items || [];
  ok(cats.some(c => c.label === 'Brand new'), 'adding a section when the sections doc is missing creates it', JSON.stringify(cats));
}
// Chores: ticks are single dotted keys, edits merge by id, and the doc is created on first use.
const choreSeed = { ...raceSeed, chores: { items: [
  { id: 'chA', text: 'Cat litter', who: 'amanda', rule: { freq: 'weekly', days: ['wed'] } },
  { id: 'chB', text: 'Vacuum',     who: 'aidan',  rule: { freq: 'weekly', days: ['tue'] } } ], done: {} } };
for (const order of ['amandaFirst', 'aidanFirst']) {
  const [a, b] = fresh(choreSeed);
  a.holdSnapshots(); b.holdSnapshots();
  const ta = () => a.call("toggleChore('chA', '2026-11-25')");
  const tb = () => b.call("toggleChore('chB', '2026-11-24')");
  if (order === 'amandaFirst') { ta(); tb(); } else { tb(); ta(); }
  a.resumeSnapshots(); b.resumeSnapshots();
  const d = S('chores').done || {};
  ok(d.chA_20261125 && d.chB_20261124, `chores: both partners' ticks survive (${order})`, JSON.stringify(d));
}
for (const order of ['tickFirst', 'editFirst']) {
  const [a, b] = fresh(choreSeed);
  a.holdSnapshots(); b.holdSnapshots();
  const tick = () => b.call("toggleChore('chA', '2026-11-25')");
  const edit = () => a.call("chores.find(c => c.id === 'chB').text = 'Vacuum + mop'; _saveChore('chB')");
  if (order === 'tickFirst') { tick(); edit(); } else { edit(); tick(); }
  a.resumeSnapshots(); b.resumeSnapshots();
  const doc = S('chores');
  ok(doc.done && doc.done.chA_20261125 && doc.items.find(c => c.id === 'chB').text === 'Vacuum + mop' && doc.items.length === 2,
    `chores: a tick and an edit at once both survive (${order})`, JSON.stringify(doc));
}
for (const order of ['addFirst', 'deleteFirst']) {
  const [a, b] = fresh(choreSeed);
  a.holdSnapshots(); b.holdSnapshots();
  const add = () => b.call("_addChores([{ id: 'chC', text: 'Water plants', who: 'aidan', rule: { freq: 'weekly', days: ['thu'] } }])");
  const del = () => a.call("chores = chores.filter(c => c.id !== 'chA'); _txUpdateDoc('chores', data => ({ items: (data.items || []).filter(x => x && x.id !== 'chA') }), _chDocFallback)");
  if (order === 'addFirst') { add(); del(); } else { del(); add(); }
  a.resumeSnapshots(); b.resumeSnapshots();
  const ids = S('chores').items.map(c => c.id);
  ok(ids.includes('chC') && !ids.includes('chA') && ids.includes('chB'), `chores: a new chore survives a delete (${order})`, JSON.stringify(ids));
}
(async () => {
{
  const seed = { ...raceSeed }; delete seed.chores;
  const [a, b] = fresh(seed);
  a.call("showPage('todos'); renderTodos(); loadChoreTemplate()");
  // update() on a missing doc rejects; the create happens in that rejection handler, a tick later.
  // (Unlike sections, nothing pre-creates the chores doc on attach, so this really hits not-found.)
  ok(server.writeLog.length === 0 || !S('chores'), 'precondition: the first write did NOT find a chores doc');
  await new Promise(r => setTimeout(r, 0));
  ok(((S('chores') || {}).items || []).length === 20, 'loading the plan creates the chores doc on first use', JSON.stringify(S('chores')).slice(0, 120));
  ok(b.ev('chores.length') === 20, "the partner's app receives the plan");
  b.call("toggleChore(chores[0].id, '2026-11-23')");
  await new Promise(r => setTimeout(r, 0));
  ok(a.ev('Object.keys(choreDone).length') === 1, "a tick on one phone shows up on the other");
}
for (const c of _raceClients) c.dom.window.close();

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
})();
