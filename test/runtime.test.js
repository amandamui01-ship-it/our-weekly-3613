/**
 * Runtime smoke test: actually LOADS index.html in jsdom, executes every inline script, stubs
 * Firebase, pushes realistic data through the listeners, and drives the new UI.
 *
 * This is the test that catches what parse-check can't: temporal-dead-zone errors, missing
 * globals (a helper that only existed as a local in another function), bad DOM ids, and render
 * functions that throw on real data.
 *
 * Run:  node test/runtime.test.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// ── Collect every error the page produces ────────────────────────────────────
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.message || e)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

// ── Firebase stub ───────────────────────────────────────────────────────────
const listeners = new Map();   // docId → callback
const writes = [];             // {docId, op, data}

const makeSnap = (docId, data) => ({
  exists: data !== undefined,
  id: docId,
  data: () => data,
  metadata: { hasPendingWrites: false },
});

const docStub = docId => ({
  onSnapshot(next) {
    listeners.set(docId, typeof next === 'function' ? next : next && next.next);
    return () => listeners.delete(docId);
  },
  set(data)    { writes.push({ docId, op: 'set', data });    return Promise.resolve(); },
  update(data) { writes.push({ docId, op: 'update', data }); return Promise.resolve(); },
  get()        { return Promise.resolve(makeSnap(docId, undefined)); },
});

const firebaseStub = {
  initializeApp: () => ({}),
  apps: [],
  auth: () => ({
    onAuthStateChanged: () => {},
    signInWithEmailAndPassword: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
    currentUser: null,
  }),
  firestore: () => ({
    collection: () => ({ doc: docStub }),
    runTransaction: fn => Promise.resolve(fn({
      get: () => Promise.resolve(makeSnap('tx', { items: [] })),
      set: () => {},
    })),
    enablePersistence: () => Promise.resolve(),
    settings: () => {},
    waitForPendingWrites: () => Promise.resolve(),
    enableNetwork: () => Promise.resolve(),
    disableNetwork: () => Promise.resolve(),
  }),
};
firebaseStub.firestore.FieldValue = {
  arrayUnion: (...v) => ({ __arrayUnion: v }),
  arrayRemove: (...v) => ({ __arrayRemove: v }),
};

// Strip external <script src> tags (the firebase CDN) — we inject the stub instead.
const html = HTML.replace(/<script[^>]*\bsrc=["'][^"']*["'][^>]*>\s*<\/script>/gi, '');

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'https://amandamui01-ship-it.github.io/our-weekly-3613/',
  virtualConsole: vc,
});
const { window } = dom;
window.firebase = firebaseStub;
window.HTMLElement.prototype.scrollIntoView = function () {};
window.HTMLInputElement.prototype.showPicker = function () {};
if (!window.crypto) window.crypto = {};
let _uidn = 0;
window.crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++_uidn).padStart(12, '0')}`;
window.navigator.vibrate = () => {};

// Execute the inline scripts. They are concatenated and run as ONE script so they share a single
// top-level lexical scope, the way separate <script> blocks do on the real page. A trailing shim
// installs window.__ev: a *direct* eval inside a function whose scope chain includes that
// top-level scope, which is the only way to read/write `let`/`const` app state (splitPct,
// giftCards, expenses...) from outside. `window.splitPct` would just be undefined.
const bodies = [];
const scriptRe = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = scriptRe.exec(html)) !== null) bodies.push(m[1]);
const nScripts = bodies.length;
const SHIM = ';window.__ev = function (__src) { return eval(__src); };';
try {
  window.eval(bodies.join('\n;\n') + '\n' + SHIM);
} catch (err) {
  const where = (err.stack || '').split('\n').slice(1, 4).join('\n      ');
  errors.push(`page script threw: ${err.message}\n      ${where}`);
}

// If the page itself failed to load, nothing below can run — report and stop immediately rather
// than cascading into a hundred confusing "not a function" errors.
if (typeof window.__ev !== 'function') {
  console.log('\n  ✗ The page failed to execute — no assertions could run.\n');
  for (const e of errors) console.log('  ' + e + '\n');
  process.exit(1);
}

const ev   = expr => window.__ev(expr);
const call = expr => { window.__ev(expr); };

// ── Test harness ────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) pass++;
  else { fail++; failures.push({ name, detail }); }
}
function run(name, expr) {
  try { call(expr); pass++; }
  catch (err) { fail++; failures.push({ name, detail: `${err.message}\n      ${(err.stack || '').split('\n')[1] || ''}` }); }
}

ok(errors.length === 0, 'page loads with no script errors', errors.join('\n      '));

// ── The globals the new features depend on must actually exist ───────────────
// (fmtMoney is the one that bit during development: `fmt` was a local inside renderBudget.)
for (const name of ['splitShares', 'shareFor', 'calcOwes', 'splitLabel', 'splitTitle', 'fmtMoney',
                    'round2', 'effectiveSplitPct', 'txSplitPct', 'renderGiftCards', 'addGiftCard',
                    'useGiftCard', 'undoGiftCardUse', 'deleteGiftCard', 'toggleGiftCardsDone',
                    'gcRemaining', 'gcSpent', 'gcIsDone', 'setSplitPct', 'renderSplitModePicker',
                    'renderSplitPreview', 'okOverlap', 'unOkOverlap', 'isOverlapOkd',
                    'pickTodoDue', '_dueInfo', 'tripEmoji', '_todosDueOn', '_rebuildTodoDueIndex',
                    '_MONTH_NAMES_SHORT', 'INCOME_CATS', 'splitPct', 'giftCards', 'okdOverlaps']) {
  ok(ev(`typeof ${name}`) !== 'undefined', `exists at runtime: ${name}`, 'is undefined');
}

// ── Boot the listeners the way the app does after sign-in ───────────────────
run('initFirestore() runs', 'initFirestore()');
ok(listeners.size > 0, 'firestore listeners registered', `got ${listeners.size}`);

function push(docId, data) {
  const cb = listeners.get(docId);
  if (!cb) { fail++; failures.push({ name: `listener for "${docId}"`, detail: 'never registered' }); return; }
  try { cb(makeSnap(docId, data)); pass++; }
  catch (err) { fail++; failures.push({ name: `push ${docId}`, detail: err.message }); }
}

const TODAY = new Date().toISOString().slice(0, 10);
const YEAR = TODAY.slice(0, 4);

push('expenses', { items: [
  { id: 'e1', date: `${YEAR}-08-02`, month: 'August', person: 'Amanda', category: 'Groceries', description: 'Woodmans',     amount: 210.00,  shared: true,  splitPct: 56 },
  { id: 'e2', date: `${YEAR}-08-05`, month: 'August', person: 'Aidan',  category: 'Dining',    description: 'Sushi',        amount: 90.00,   shared: true,  splitPct: 56 },
  { id: 'e3', date: `${YEAR}-08-07`, month: 'August', person: 'Amanda', category: 'Income',    description: 'Poshmark',     amount: 640.00,  shared: false, splitPct: 56 },
  { id: 'e4', date: `${YEAR}-08-09`, month: 'August', person: 'Amanda', category: 'Income',    description: 'Joint refund', amount: 400.00,  shared: true,  splitPct: 56 },
  { id: 'e5', date: `${YEAR}-03-01`, month: 'March',  person: 'Amanda', category: 'Housing',   description: 'Mortgage',     amount: 1833.00, shared: true },   // legacy, unstamped
  { id: 'e6', date: `${YEAR}-08-11`, month: 'August', person: 'Aidan',  category: 'Shopping',  description: 'Return',       amount: -25.00,  shared: true,  splitPct: 56 },
] });
push('splitPct', { aidan: 56 });
push('giftCards', { items: [
  { id: 'gc1', label: 'Target',    amount: 25, redemptions: [{ id: 'r1', date: `${YEAR}-08-01`, amount: 12.34 }] },
  { id: 'gc2', label: 'Amazon',    amount: 50, redemptions: [] },
  { id: 'gc3', label: 'Starbucks', amount: 10, redemptions: [{ id: 'r2', date: `${YEAR}-08-03`, amount: 10 }] },  // used up
] });
push('todos', { items: [
  { id: 't1', text: 'Book campsite',    cat: 'todo', done: false, due: `${YEAR}-08-25` },
  { id: 't2', text: 'Renew passport',   cat: 'todo', done: false, due: `${YEAR}-01-05`, priority: 'critical' },  // overdue
  { id: 't3', text: 'No deadline here', cat: 'todo', done: false },
  { id: 't4', text: 'Already done',     cat: 'todo', done: true,  due: `${YEAR}-08-02` },
] });
push('todoCategories', { items: [{ id: 'todo', label: '📋 To-Do' }] });
push('trips', { items: [
  { id: 'trip-a', dates: 'Aug 21–23',      sortDate: `${YEAR}-08-21`, label: 'Peninsula State Park Camping' },
  { id: 'trip-b', dates: 'Aug 22',         sortDate: `${YEAR}-08-22`, label: 'Night Market' },              // overlaps trip-a
  { id: 'trip-c', dates: 'Feb 14, 2027',   label: 'Gracie Abrams (Nashville!)' },                           // text-dated, no sortDate
  { id: 'trip-d', dates: 'Oct 24 – Nov 8', sortDate: `${YEAR}-10-24`, label: 'JAPAN' },
] });
push('okdOverlaps', { pairs: [] });
push('weekplan', { mon: {}, tue: {}, wed: {}, thu: {}, fri: {}, sat: {}, sun: {} });
push('datedEvents', { items: [{ id: 'ev1', date: `${YEAR}-08-20`, text: 'Dentist' }] });

// ── Render every page the changes touch ─────────────────────────────────────
run('renderBudget()',           'renderBudget()');
run('renderGiftCards()',        'renderGiftCards()');
run('renderTodos()',            'renderTodos()');
run('renderDates()',            'renderDates()');
run('renderCalendar()',         'renderCalendar()');
run('openBudgetSettings()',     'openBudgetSettings()');
run('renderSplitModePicker()',  'renderSplitModePicker()');

const $  = sel => window.document.querySelector(sel);
const $$ = sel => [...window.document.querySelectorAll(sel)];
const txt = sel => (($(sel) || {}).textContent || '').replace(/\s+/g, ' ').trim();

// ═══ Split ═══════════════════════════════════════════════════════════════════
ok(ev('splitPct') === 56, 'splitPct listener applied', String(ev('splitPct')));

// Hand calculation for August:
//   e1  Amanda paid 210.00 @56 → Aidan owes 117.60          → Aidan -117.60
//   e2  Aidan  paid  90.00 @56 → Amanda owes 39.60          → Aidan  +39.60
//   e4  Amanda RECEIVED 400 shared income, split evenly     → Aidan +200.00 (she owes him 200)
//   e6  Aidan  paid -25.00 @56 (a refund) → Amanda's share is -11.00, i.e. Aidan owes her 11
//                                                            → Aidan  -11.00
//   net Aidan = -117.60 + 39.60 + 200.00 - 11.00 = +111.00
const augTx   = ev('expenses').filter(e => e.date.startsWith(`${YEAR}-08`));
const calcOwes = ev('calcOwes');
const augOwes = calcOwes(augTx);
ok(Math.abs(augOwes.Aidan - 111.00) < 0.005,
  'August settlement matches the hand calculation (+111.00 to Aidan)', `got ${augOwes.Aidan}`);
ok(Math.abs(augOwes.Aidan + augOwes.Amanda) < 1e-9,
  'settlement is exactly equal-and-opposite', JSON.stringify(augOwes));

// Solo resale income must be invisible to the settlement.
const noResale = calcOwes(augTx.filter(e => e.description !== 'Poshmark'));
ok(noResale.Aidan === augOwes.Aidan,
  'removing the solo resale income changes nothing', `${noResale.Aidan} vs ${augOwes.Aidan}`);

// The add-expense label must show the active ratio, not a stale hardcoded 50/50.
ok(txt('#b-shared-text').includes('56/44'), 'add-expense label shows the active ratio', txt('#b-shared-text'));
// The settings preview must be generated from the real math.
ok(txt('#split-mode-preview').includes('$56.00') && txt('#split-mode-preview').includes('$44.00'),
  'settings preview shows a worked $100 example', txt('#split-mode-preview'));
// Per-row badges reflect each row's OWN ratio: the legacy March row stays 50/50.
ok(ev("splitLabel(effectiveSplitPct(expenses.find(e=>e.id==='e5')))") === '50/50',
  'legacy unstamped row still reads 50/50', ev("splitLabel(effectiveSplitPct(expenses.find(e=>e.id==='e5')))"));
ok(ev("splitLabel(effectiveSplitPct(expenses.find(e=>e.id==='e1')))") === '56/44',
  'stamped row reads 56/44');
ok(ev("splitLabel(effectiveSplitPct(expenses.find(e=>e.id==='e4')))") === '50/50',
  'shared income row reads 50/50 even under 56/44 mode');

// Changing the mode must not rewrite stamped rows or past settlements.
const beforePcts = JSON.stringify(ev('expenses').map(e => e.splitPct));
run('setSplitPct(50)', 'setSplitPct(50)');
ok(JSON.stringify(ev('expenses').map(e => e.splitPct)) === beforePcts,
  'changing the mode leaves existing expenses stamped as they were',
  `${beforePcts} → ${JSON.stringify(ev('expenses').map(e => e.splitPct))}`);
ok(ev('calcOwes')(augTx).Aidan === augOwes.Aidan,
  'changing the mode does not change a past settlement', String(ev('calcOwes')(augTx).Aidan));
run('setSplitPct(56) back', 'setSplitPct(56)');
run('setSplitPct("abc") rejected', "setSplitPct('abc')");
ok(ev('splitPct') === 56, 'invalid split input leaves the mode unchanged', String(ev('splitPct')));
run('setSplitPct(null) rejected', 'setSplitPct(null)');
ok(ev('splitPct') === 56, 'null split input leaves the mode unchanged', String(ev('splitPct')));

// ═══ Gift cards ══════════════════════════════════════════════════════════════
ok($$('.gc-item').length === 2, 'used-up card is separated from active ones', `${$$('.gc-item').length} active`);
ok(txt('#gc-total').includes('62.66'), 'total = $12.66 + $50.00 = $62.66', txt('#gc-total'));
ok(txt('#gc-list').includes('Target'), 'card labels render', txt('#gc-list').slice(0, 80));
ok(txt('#gc-spent-wrap').includes('Used up (1)'), 'used-up section counts 1', txt('#gc-spent-wrap'));

const gc2 = () => ev("gcRemaining(giftCards.find(c=>c.id==='gc2'))");
run('useGiftCard partial', "useGiftCard('gc2', 20)");
ok(Math.abs(gc2() - 30) < 0.005, 'logging $20 on a $50 card leaves $30', String(gc2()));
const beforeOver = gc2();
run('useGiftCard overspend', "useGiftCard('gc2', 999)");
ok(gc2() === beforeOver, 'overspending a gift card is refused', String(gc2()));
run('undoGiftCardUse', "undoGiftCardUse('gc2')");
ok(Math.abs(gc2() - 50) < 0.005, 'undo restores the balance', String(gc2()));

const nCards = ev('giftCards.length');
$('#gc-label').value = ''; $('#gc-amount').value = '';
run('addGiftCard with no input', 'addGiftCard()');
ok(ev('giftCards.length') === nCards, 'empty gift card is refused', `${ev('giftCards.length')} vs ${nCards}`);
$('#gc-label').value = 'REI'; $('#gc-amount').value = '75';
run('addGiftCard valid', 'addGiftCard()');
ok(ev('giftCards.length') === nCards + 1, 'valid gift card is added', String(ev('giftCards.length')));
ok(ev("giftCards.some(c=>c.label==='REI'&&c.amount===75)"), 'new card has the right values');
// Penny-level: three odd partial spends must leave an exact balance.
run('add odd card', "giftCards.push({id:'gcx',label:'Odd',amount:20,redemptions:[]})");
run('spend 3.33', "useGiftCard('gcx', 3.33)");
run('spend 6.67', "useGiftCard('gcx', 6.67)");
run('spend 10.00', "useGiftCard('gcx', 10)");
ok(ev("gcIsDone(giftCards.find(c=>c.id==='gcx'))"), '3.33 + 6.67 + 10.00 exactly empties a $20 card',
  String(ev("gcRemaining(giftCards.find(c=>c.id==='gcx'))")));

// ═══ To-do deadlines ═════════════════════════════════════════════════════════
run('re-render todos', 'renderTodos()');
ok($$('.todo-due').length >= 2, 'due badges render', String($$('.todo-due').length));
ok(txt('#todos-container').includes('late'), 'overdue to-do is labelled late');
ok($$('.todo-item.todo-overdue').length === 1, 'exactly the overdue item gets the stripe', String($$('.todo-item.todo-overdue').length));
ok($$('.todo-due-add').length >= 1, 'undated to-do offers an add-deadline button');
const doneRow = window.document.getElementById('todo-t4');
ok(doneRow && !doneRow.className.includes('todo-overdue'), 'completed to-do is never overdue', doneRow && doneRow.className);
ok(ev(`_dueInfo('${TODAY}').label`) === 'today', '_dueInfo(today) says today', ev(`_dueInfo('${TODAY}').label`));
ok(ev("_dueInfo('not-a-date')") === null, '_dueInfo rejects junk');
ok(ev('_dueInfo(undefined)') === null, '_dueInfo rejects undefined');
ok(ev("_dueInfo('2020-01-01').cls") === 'due-late', '_dueInfo flags an old date as late');
// Overdue + critical sorts to the top of its category.
ok(txt('.todo-items').indexOf('Renew passport') < txt('.todo-items').indexOf('Book campsite'),
  'overdue critical item sorts above a future one');
run('pickTodoDue opens', "pickTodoDue('t1')");
ok(!!$('.todo-due-input'), 'date input appears in the row');
run('renderTodos after picker', 'renderTodos()');

run('rebuild due index', '_rebuildTodoDueIndex()');
ok(ev(`_todosDueOn('${YEAR}-08-25').length`) === 1, 'due index finds the campsite to-do', String(ev(`_todosDueOn('${YEAR}-08-25').length`)));
ok(ev(`_todosDueOn('${YEAR}-12-31').length`) === 0, 'due index is empty for a free day');
// The chip must actually be in the calendar DOM for a due date in the shown month.
run('show due month', `_calMonth='${YEAR}-08'; renderCalendar()`);
ok($$('.cal-todo').length >= 1, 'to-do chips render on the calendar grid', String($$('.cal-todo').length));
ok($$('.cal-todo.cal-todo-done').length >= 1, 'a completed due to-do renders struck through');

// ═══ Conflicts ═══════════════════════════════════════════════════════════════
run('renderDates for conflicts', 'renderDates()');
ok($$('.overlap-dismiss').length >= 1, 'conflicting trips offer a "That’s fine" button', String($$('.overlap-dismiss').length));
run('okOverlap', "okOverlap('trip-a')");
ok(ev('okdOverlaps.size') >= 1, 'accepting a conflict records the pair', String(ev('okdOverlaps.size')));
run('renderDates after ok', 'renderDates()');
ok($$('.overlap-dismiss').length === 0, 'accepted conflict is no longer red', `${$$('.overlap-dismiss').length} still red`);
ok($$('.overlap-okd').length >= 1, 'accepted conflict shows a reversible note', String($$('.overlap-okd').length));
run('unOkOverlap', "unOkOverlap('trip-a')");
run('renderDates after un-ok', 'renderDates()');
ok($$('.overlap-dismiss').length >= 1, 'un-accepting brings the flag back', String($$('.overlap-dismiss').length));
ok(ev("isOverlapOkd('x','y')") === false, 'an unrelated pair is not pre-accepted');
// Accepting is pair-keyed, so it must survive a re-render and be shared-state (a plain array).
run('re-accept', "okOverlap('trip-a')");
ok(Array.isArray(ev('[...okdOverlaps]')), 'accepted conflicts serialize as an array for Firestore');

// ═══ Year filter (the 2027-in-2026 bug) ══════════════════════════════════════
run('set year to current', `_setDatesYear(${Number(YEAR)})`);
const gridText = txt('#trip-grid');
ok(!gridText.includes('Gracie Abrams'), `a 2027 text-dated trip must NOT show under ${YEAR}`, gridText.slice(0, 200));
ok(gridText.includes('JAPAN'), 'current-year trips still show');
run('set year to 2027', '_setDatesYear(2027)');
ok(txt('#trip-grid').includes('Gracie Abrams'), 'the 2027 trip shows under 2027', txt('#trip-grid').slice(0, 160));
run('set year back', `_setDatesYear(${Number(YEAR)})`);

// ═══ Emoji ═══════════════════════════════════════════════════════════════════
ok(ev("tripEmoji('Sarah\\'s Bachelorette')") === '👯', 'bachelorette no longer steals 🍺');
ok(ev("tripEmoji('Brewers game')") !== '✨', 'expanded table covers a Brewers game');

// ═══ Export ══════════════════════════════════════════════════════════════════
run('export payload is JSON-safe',
  "JSON.stringify({splitPct, giftCards, okdOverlaps:[...okdOverlaps], todos, trips})");
ok(ev("JSON.stringify({okdOverlaps:[...okdOverlaps]})").includes('trip-'),
  'accepted conflicts survive serialization');

// ── No errors accumulated during any of that ────────────────────────────────
ok(errors.length === 0, 'no runtime errors across the whole exercise', errors.join('\n      '));

// ═════════════════════════════════════════════════════════════════════════════
console.log('');
console.log(`  ${pass} passed, ${fail} failed   (${nScripts} inline scripts executed, ${listeners.size} listeners)`);
if (fail) {
  console.log('');
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.detail || ''}`);
  console.log('');
  process.exit(1);
}
console.log('  Page loads and all new UI works against real data.\n');
// The app installs intervals (the Japan countdown ticker, autosave debounces) which keep jsdom's
// event loop alive forever. Tear the window down and exit explicitly.
dom.window.close();
process.exit(0);
