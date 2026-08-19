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
  delete: () => ({ __delete: true }),
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

// ═══ Gift card expiration ════════════════════════════════════════════════════
// Dates are built RELATIVE to the app's own _todayLocal() rather than hardcoded, so these
// assertions don't start failing on a particular calendar day.
const shift = d => ev(`(() => {
  const [y,m,dd] = _todayLocal().split('-').map(Number);
  const t = new Date(Date.UTC(y, m-1, dd + (${d})));
  return t.toISOString().slice(0,10);
})()`);
const today = ev('_todayLocal()');

ok(ev(`gcExpiryInfo({expires:'${shift(-3)}'}).state`) === 'expired', 'a past date reads as expired');
ok(ev(`gcExpiryInfo({expires:'${today}'}).state`) === 'soon',
  'a card expiring TODAY is still spendable, not expired', ev(`gcExpiryInfo({expires:'${today}'}).state`));
ok(ev(`gcExpiryInfo({expires:'${today}'}).label`) === 'expires today', 'today is labelled plainly');
ok(ev(`gcExpiryInfo({expires:'${shift(1)}'}).label`) === 'expires tomorrow', 'tomorrow is labelled plainly');
ok(ev(`gcExpiryInfo({expires:'${shift(10)}'}).state`) === 'soon', '10 days out is "soon"');
ok(ev(`gcExpiryInfo({expires:'${shift(200)}'}).state`) === 'ok', '200 days out is not urgent');
ok(ev(`gcExpiryInfo({expires:'${shift(-1)}'}).label`) === 'expired yesterday', 'yesterday reads naturally');
ok(ev('gcExpiryInfo({})') === null, 'a card with no expiry has no expiry info');
ok(ev("gcExpiryInfo({expires:''})") === null, 'an empty-string expiry is treated as absent');
ok(ev("gcExpiryInfo({expires:'not a date'})") === null, 'garbage in the expiry field is ignored, not thrown on');
ok(ev("gcExpiryInfo({expires:'2026-2-4'})") === null, 'an unpadded date is rejected rather than misread');

// Expired money must not be counted as available — the whole point of tracking expiry.
run('reset cards for expiry', `giftCards = [
  {id:'x1', label:'Live',    amount:40, expires:'${shift(60)}'},
  {id:'x2', label:'Soon',    amount:25, expires:'${shift(5)}'},
  {id:'x3', label:'Dead',    amount:99, expires:'${shift(-9)}'},
  {id:'x4', label:'Forever', amount:10}
]; giftCardSpends = []; renderGiftCards()`);
ok(!txt('#gc-total').includes('174'), 'expired balance is excluded from the headline total', txt('#gc-total'));
ok(txt('#gc-total').includes('75.00'), 'total counts only the $40 + $25 + $10 that are still usable', txt('#gc-total'));
ok(txt('#gc-total').includes('1 expired'), 'expired cards are called out separately', txt('#gc-total'));
ok($$('.gc-item').length === 4, 'the expired card is still listed, not hidden', String($$('.gc-item').length));
// Order: expired first (needs a decision), then soonest, undated last.
const gcOrder = $$('.gc-item').map(el => el.getAttribute('data-id'));
ok(JSON.stringify(gcOrder) === JSON.stringify(['x3', 'x2', 'x1', 'x4']),
  'cards sort expired → soonest → undated', gcOrder.join(','));
ok(txt('#gc-list').includes('9 days ago'), 'the expired card says how long ago', txt('#gc-list').slice(0, 200));
ok($$('.gc-exp-input').length === 4, 'every card exposes an expiry picker', String($$('.gc-exp-input').length));

// Editing an expiry in place.
run('set expiry', `setGiftCardExpiry('x4', '${shift(2)}')`);
ok(ev("giftCards.find(c=>c.id==='x4').expires") === shift(2), 'setting an expiry stores it');
run('clear expiry', "setGiftCardExpiry('x4', '')");
ok(ev("giftCards.find(c=>c.id==='x4')").expires === undefined,
  'clearing the field removes the key entirely (no empty-string second shape)',
  JSON.stringify(ev("giftCards.find(c=>c.id==='x4')")));
run('bad expiry', "setGiftCardExpiry('x4', 'whenever')");
ok(ev("giftCards.find(c=>c.id==='x4')").expires === undefined, 'an invalid expiry edit is refused');
// Adding a card with an expiry through the real form.
$('#gc-label').value = 'Coupon'; $('#gc-amount').value = '15'; $('#gc-expires').value = shift(20);
run('addGiftCard with expiry', 'addGiftCard()');
ok(ev("giftCards.some(c=>c.label==='Coupon'&&c.expires==='" + shift(20) + "')"), 'the add form persists the expiry');
ok($('#gc-expires').value === '', 'the expiry field clears after adding', $('#gc-expires').value);
$('#gc-label').value = 'NoExp'; $('#gc-amount').value = '5'; $('#gc-expires').value = '';
run('addGiftCard without expiry', 'addGiftCard()');
ok(ev("giftCards.find(c=>c.label==='NoExp')").expires === undefined,
  'leaving expiry blank stores no expiry key');

// ═══ Collapsible budget sections ═════════════════════════════════════════════
for (const key of ev('BUDGET_SECTIONS')) {
  ok(window.document.getElementById('bsec-body-' + key) !== null, `section body exists: ${key}`);
  ok(window.document.getElementById('bsec-chev-' + key) !== null, `section chevron exists: ${key}`);
}
ok(ev("BUDGET_SECTIONS.every(k => bsecIsOpen(k))"), 'every section defaults to open');
run('collapse cats', "toggleBudgetSection('cats')");
ok($('#bsec-body-cats').style.display === 'none', 'collapsing hides the body');
ok(txt('#bsec-chev-cats') === '▶', 'the chevron flips when collapsed', txt('#bsec-chev-cats'));
ok($('#bsec-card-cats').className.includes('bsec-collapsed'), 'the card gets the collapsed class');
run('re-render budget', 'renderBudget()');
ok($('#bsec-body-cats').style.display === 'none',
  'a collapsed section stays collapsed across a full renderBudget', $('#bsec-body-cats').style.display);
ok($('#bsec-body-tx').style.display !== 'none', 'sections left open stay open across a render');
// The regression that matters, and it is NOT the one above: renderBudget only rewrites the
// *children* of a section body, so an inline display:none survives on its own and that assertion
// passes even with the re-apply gutted (confirmed by mutation testing). The state that genuinely
// needs re-applying is a FRESH LOAD, where the body carries no inline style and "collapsed" exists
// only in localStorage. Clearing the inline style simulates that first render.
run('simulate a fresh load with bulk stored collapsed',
  "_lsSet('ow-bsec-bulk', '0'); document.getElementById('bsec-body-bulk').style.display = ''; renderBudget()");
ok($('#bsec-body-bulk').style.display === 'none',
  'a section stored as collapsed is applied on first render, not just on click',
  `display=${JSON.stringify($('#bsec-body-bulk').style.display)}`);
ok(txt('#bsec-chev-bulk') === '▶', 'the chevron matches stored state on first render', txt('#bsec-chev-bulk'));
run('restore bulk', "_lsSet('ow-bsec-bulk', '1'); renderBudget()");
ok($('#bsec-body-bulk').style.display !== 'none', 'and reopens when the stored state says open');
run('reopen cats', "toggleBudgetSection('cats')");
ok($('#bsec-body-cats').style.display !== 'none', 'toggling again reopens it');
ok(!$('#bsec-card-cats').className.includes('bsec-collapsed'), 'the collapsed class is removed again');
run('unknown section', "toggleBudgetSection('nope')");
ok(true, 'toggling an unknown section is a no-op rather than an error');
// Collapsing must not break the data underneath it — the tx list is still rendered, just hidden.
run('collapse tx', "toggleBudgetSection('tx'); renderBudget()");
ok($('#budget-transactions').innerHTML.length > 0,
  'a collapsed section still renders its content (so search totals stay correct)');
run('reopen tx', "toggleBudgetSection('tx')");
// The header must not swallow taps meant for the filters inside it.
ok($('#bsec-body-tx').contains($('#b-filter-cat')),
  'the category filter lives in the body, not the clickable header');
ok($('#bsec-body-tx').contains($('#b-search')), 'the search box lives in the body, not the header');

// ═══ Recurring to-dos ════════════════════════════════════════════════════════
// Month arithmetic is where this kind of feature rots. Every one of these is a date that naive
// Date math gets wrong.
const nd = (from, every, unit) => ev(`nextDueFrom('${from}', {every:${every}, unit:'${unit}'})`);
ok(nd('2026-03-20', 3, 'month') === '2026-06-20', 'plain 3-month step', nd('2026-03-20', 3, 'month'));
ok(nd('2026-01-31', 1, 'month') === '2026-02-28', 'Jan 31 + 1mo clamps to Feb 28, not Mar 3', nd('2026-01-31', 1, 'month'));
ok(nd('2028-01-31', 1, 'month') === '2028-02-29', 'Jan 31 + 1mo lands on Feb 29 in a leap year', nd('2028-01-31', 1, 'month'));
ok(nd('2026-05-31', 1, 'month') === '2026-06-30', 'May 31 + 1mo clamps to Jun 30', nd('2026-05-31', 1, 'month'));
ok(nd('2026-08-31', 6, 'month') === '2027-02-28', '6 months from Aug 31 crosses the year and clamps', nd('2026-08-31', 6, 'month'));
ok(nd('2026-11-15', 3, 'month') === '2027-02-15', 'a 3-month step crosses into the next year', nd('2026-11-15', 3, 'month'));
ok(nd('2026-12-31', 1, 'month') === '2027-01-31', 'Dec 31 + 1mo is Jan 31 of the next year', nd('2026-12-31', 1, 'month'));
ok(nd('2028-02-29', 1, 'year') === '2029-02-28', 'Feb 29 + 1 year clamps to Feb 28', nd('2028-02-29', 1, 'year'));
ok(nd('2026-03-08', 1, 'week') === '2026-03-15', 'a weekly step crosses the US DST change intact', nd('2026-03-08', 1, 'week'));
ok(nd('2026-11-01', 1, 'week') === '2026-11-08', 'a weekly step crosses the fall DST change intact', nd('2026-11-01', 1, 'week'));
ok(nd('2026-02-26', 1, 'week') === '2026-03-05', 'a weekly step crosses a month end', nd('2026-02-26', 1, 'week'));
ok(nd('2026-12-28', 2, 'week') === '2027-01-11', 'a 2-week step crosses the new year', nd('2026-12-28', 2, 'week'));
ok(nd('2026-08-19', 1, 'year') === '2027-08-19', 'a yearly step', nd('2026-08-19', 1, 'year'));
// Bad rules must yield null, never a wrong date.
ok(ev("nextDueFrom('2026-03-20', null)") === null, 'no repeat rule yields no next date');
ok(ev("nextDueFrom('2026-03-20', {every:0, unit:'month'})") === null, 'a zero interval is rejected');
ok(ev("nextDueFrom('2026-03-20', {every:-3, unit:'month'})") === null, 'a negative interval is rejected');
ok(ev("nextDueFrom('2026-03-20', {every:1.5, unit:'month'})") === null, 'a fractional interval is rejected');
ok(ev("nextDueFrom('2026-03-20', {every:2, unit:'fortnight'})") === null, 'an unknown unit is rejected');
ok(ev("nextDueFrom('not-a-date', {every:1, unit:'month'})") === null, 'a bad start date yields null');
ok(ev("nextDueFrom('2026-03-20', {every:99999, unit:'day'})") === null, 'an absurd interval is rejected');

// Completion advances from TODAY, not from the old due date — Amanda's choice, and the whole point.
run('add a recurring todo', `todos.push({id:'r1', text:'Furnace filter', cat:'todo', done:false,
  due:'2020-01-01', repeat:{every:3, unit:'month'}}); renderTodos()`);
ok(txt('#todo-r1').includes('🔁'), 'a recurring to-do shows a repeat chip', txt('#todo-r1'));
ok(txt('#todo-r1').includes('3mo'), 'the chip shows the interval', txt('#todo-r1'));
const expectedNext = ev("nextDueFrom(_todayLocal(), {every:3, unit:'month'})");
run('complete the recurring todo', "toggleTodo('r1')");
const r1 = () => ev("todos.find(t=>t.id==='r1')");
ok(r1().done === false, 'completing a recurring to-do does NOT file it away as done', String(r1().done));
ok(r1().due === expectedNext,
  'the next due date is 3 months from TODAY, not from the long-past due date',
  `${r1().due} vs ${expectedNext}`);
ok(r1().lastDone === today, 'completion is stamped so the chip can show when it was last done', r1().lastDone);
ok(!ev("todos.filter(t=>t.done).some(t=>t.id==='r1')"), 'it never appears in the Completed list');
// Doing it late must not create a backlog: the new date is always in the future.
ok(ev("_dueInfo(todos.find(t=>t.id==='r1').due).days") > 0,
  'after completion the task is never already overdue',
  String(ev("_dueInfo(todos.find(t=>t.id==='r1').due).days")));
// A second completion rolls forward again from that day, not cumulatively from the stored due date.
run('complete again', "toggleTodo('r1')");
ok(r1().due === expectedNext, 'completing twice in one day does not double-advance the schedule', r1().due);

// A repeat set on a to-do with no deadline gets one, or it could never come due.
run('repeat with no date', `todos.push({id:'r2', text:'Water softener salt', cat:'todo', done:false}); renderTodos()`);
run('open picker', "pickTodoDue('r2')");
run('choose monthly', `(() => {
  const sel = document.querySelector('#todo-r2 .todo-repeat-sel');
  sel.value = '1:month';
  sel.onchange();
})()`);
const r2 = () => ev("todos.find(t=>t.id==='r2')");
ok(ev("_isRepeat(todos.find(t=>t.id==='r2').repeat)"), 'the repeat rule is stored', JSON.stringify(r2().repeat));
ok(r2().due === today, 'a repeat with no deadline is anchored to today rather than left inert', r2().due);
// Clearing the deadline must clear the rule too — a repeat with no date is a setting that does nothing.
run('reopen picker', "pickTodoDue('r2')");
run('clear the date', "document.querySelector('#todo-r2 .todo-due-clear').onclick({stopPropagation(){}})");
ok(r2().due === undefined, 'clearing removes the deadline', String(r2().due));
ok(r2().repeat === undefined, 'clearing the deadline also clears the repeat', JSON.stringify(r2().repeat));
// A non-repeating to-do must still behave exactly as before. NOTE: these two are deliberately NOT
// rendered first. A normal completion animates (650ms burst + 350ms collapse) and only writes
// `done` in the trailing callback, so with a row in the DOM there is nothing to assert
// synchronously. With no element, toggleTodo takes its own no-animation path — same logic, testable.
run('add a plain todo (unrendered)', `todos.push({id:'r3', text:'One off', cat:'todo', done:false})`);
run('complete the plain todo', "toggleTodo('r3')");
ok(ev("todos.find(t=>t.id==='r3').done") === true, 'a normal to-do still completes normally',
  String(ev("todos.find(t=>t.id==='r3').done")));
// A corrupt rule must not strand the task — it should fall through to an ordinary completion.
run('add a corrupt-rule todo (unrendered)', `todos.push({id:'r4', text:'Broken rule', cat:'todo', done:false,
  due:'2026-01-01', repeat:{every:0, unit:'month'}})`);
run('complete corrupt', "toggleTodo('r4')");
ok(ev("todos.find(t=>t.id==='r4').done") === true,
  'a to-do with a corrupt repeat rule completes normally instead of getting stuck',
  String(ev("todos.find(t=>t.id==='r4').done")));
// The repeat chip renders for a done item too, so a recurring task reads as recurring everywhere.
run('render with r4 done', 'renderTodos()');
// Clean up: these fixtures would otherwise change the overdue counts asserted further down.
run('remove repeat fixtures', "todos = todos.filter(t => !['r1','r2','r3','r4'].includes(t.id)); renderTodos()");

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
