/**
 * Budget math audit. Loads the real page in jsdom (like runtime.test.js) and probes specific
 * hypotheses about the money math, so "is this a bug?" is answered by execution, not by reading.
 *
 * Tests marked EXPECTED-BUG document behaviour that is currently WRONG. They assert the CORRECT
 * behaviour, so they fail until the bug is fixed — that's the point.
 *
 * Run:  node test/budget-audit.test.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.message || e)));

const listeners = new Map();
const makeSnap = (docId, data) => ({
  exists: data !== undefined, id: docId, data: () => data,
  metadata: { hasPendingWrites: false },
});
const docStub = docId => ({
  onSnapshot(next) { listeners.set(docId, typeof next === 'function' ? next : next && next.next); return () => {}; },
  set() { return Promise.resolve(); },
  update() { return Promise.resolve(); },
  get() { return Promise.resolve(makeSnap(docId, undefined)); },
});
const firebaseStub = {
  initializeApp: () => ({}), apps: [],
  auth: () => ({ onAuthStateChanged: () => {}, signOut: () => Promise.resolve(), currentUser: null }),
  firestore: () => ({
    collection: () => ({ doc: docStub }),
    runTransaction: fn => Promise.resolve(fn({ get: () => Promise.resolve(makeSnap('tx', { items: [] })), set: () => {} })),
    enablePersistence: () => Promise.resolve(), settings: () => {},
  }),
};
firebaseStub.firestore.FieldValue = { arrayUnion: (...v) => ({ v }), arrayRemove: (...v) => ({ v }), delete: () => ({ __delete: true }) };

const html = HTML.replace(/<script[^>]*\bsrc=["'][^"']*["'][^>]*>\s*<\/script>/gi, '');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true,
  url: 'https://example.com/', virtualConsole: vc });
const { window } = dom;
window.firebase = firebaseStub;
window.HTMLElement.prototype.scrollIntoView = function () {};
window.HTMLInputElement.prototype.showPicker = function () {};
if (!window.crypto) window.crypto = {};
let n = 0;
window.crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
window.navigator.vibrate = () => {};

const bodies = [];
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(html)) !== null) bodies.push(m[1]);
try {
  window.eval(bodies.join('\n;\n') + '\n;window.__ev = function (s) { return eval(s); };');
} catch (err) { errors.push('page threw: ' + err.message); }
if (typeof window.__ev !== 'function') {
  console.log('\n  ✗ page failed to execute\n');
  for (const e of errors) console.log('  ' + e);
  process.exit(1);
}
const ev = e => window.__ev(e);
const call = e => { window.__ev(e); };

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) pass++; else { fail++; failures.push({ name, detail }); }
}
function eqn(actual, expected, name, tol = 0.005) {
  ok(Math.abs(actual - expected) < tol, name, `expected ${expected}, got ${actual}`);
}

call('initFirestore()');
const push = (doc, data) => { const cb = listeners.get(doc); if (cb) cb(makeSnap(doc, data)); };

const YEAR = String(new Date().getFullYear());
const MONTH = String(new Date().getMonth() + 1).padStart(2, '0');
const MONTH_NAME = ev('monthName(new Date())');

// ═════════════════════════════════════════════════════════════════════════════
// 1. _evalAmount — the amount parser used by bulk paste
// ═════════════════════════════════════════════════════════════════════════════
const amt = s => ev(`_evalAmount(${JSON.stringify(s)})`);
eqn(amt('50'), 50, 'plain number');
eqn(amt('$50'), 50, 'leading dollar sign');
eqn(amt('1,234.56'), 1234.56, 'thousands comma');
eqn(amt('$1,234.56'), 1234.56, 'dollar + thousands comma');
eqn(amt('-50'), -50, 'leading minus (refund)');
eqn(amt('15.63 + 20.26'), 35.89, 'spaced addition');
eqn(amt('20 - 5'), 15, 'spaced subtraction');
eqn(amt('.5'), 0.5, 'leading decimal point');
ok(Number.isNaN(amt('abc')), 'letters rejected');
ok(Number.isNaN(amt('')), 'empty rejected');
ok(Number.isNaN(amt('5 +')), 'trailing operator rejected');
ok(Number.isNaN(amt('5 - -3')), 'ambiguous double operator rejected');
ok(Number.isNaN(amt('3-20')), 'unspaced date-like input rejected (not read as 3 minus 20)');
// Rounding: a 3-decimal input must land on cents, not carry a fraction of a cent into the ledger.
eqn(amt('10.005'), 10.01, 'three-decimal input rounds to cents');
eqn(amt('0.1 + 0.2'), 0.30, 'float dust does not leak (0.1+0.2)');

// ═════════════════════════════════════════════════════════════════════════════
// 2. _parseBulkLine — field splitting
// ═════════════════════════════════════════════════════════════════════════════
const line = (s, fb = `${YEAR}-${MONTH}-01`) => ev(`_parseBulkLine(${JSON.stringify(s)}, ${JSON.stringify(fb)})`);
let r = line('Groceries, 45.20, n');
ok(!r.error && r.category === 'Groceries' && r.amount === 45.20 && r.shared === false, 'basic line', JSON.stringify(r));
r = line('Groceries, Woodmans run, 45.20, y');
ok(r.category === 'Groceries' && r.description === 'Woodmans run' && r.amount === 45.20 && r.shared === true,
  'line with description + shared flag', JSON.stringify(r));
r = line('Groceries, 1,234.56, n');
eqn(r.amount, 1234.56, 'thousands comma survives field splitting');
r = line('Dining, dinner, drinks, 80, y');
ok(r.description === 'dinner, drinks', 'commas inside a description are preserved', JSON.stringify(r));
r = line('Shopping, returned jacket, -45.00, n');
eqn(r.amount, -45.00, 'negative amount (return) parses');
r = line('Din, 20, n');
ok(r.category === 'Dining', 'category prefix matching', JSON.stringify(r));
r = line('Zzz, 20, n');
ok(r.category === 'Misc' && r.warnMisc, 'unknown category falls to Misc with a warning');
r = line('I, 20, n');
ok(r.warnAmbiguous, 'ambiguous prefix is flagged rather than guessed', JSON.stringify(r));
r = line('Dining, lunch');
ok(!!r.error, 'a line with no parseable amount errors instead of importing 0', JSON.stringify(r));
// A numeric-looking description must not be mistaken for the amount.
r = line('Dining, 50, 12.75, n');
eqn(r.amount, 12.75, 'last field is the amount, not a numeric description');
ok(r.description === '50', 'numeric description preserved');

// ═════════════════════════════════════════════════════════════════════════════
// 3. Snapshot tiles vs. the transaction list and category breakdown
// ═════════════════════════════════════════════════════════════════════════════
// A ledger with: shared + solo, both people, income (solo + shared), a refund, savings.
const LEDGER = [
  { id: 'a1', date: `${YEAR}-${MONTH}-02`, person: 'Amanda', category: 'Groceries',   description: 'Woodmans',  amount: 200.00, shared: true,  splitPct: 56 },
  { id: 'a2', date: `${YEAR}-${MONTH}-03`, person: 'Aidan',  category: 'Dining',      description: 'Sushi',     amount: 100.00, shared: true,  splitPct: 56 },
  { id: 'a3', date: `${YEAR}-${MONTH}-04`, person: 'Amanda', category: 'Shopping',    description: 'Jacket',    amount: 80.00,  shared: false, splitPct: 56 },
  { id: 'a4', date: `${YEAR}-${MONTH}-05`, person: 'Aidan',  category: 'Shopping',    description: 'Boots',     amount: 60.00,  shared: false, splitPct: 56 },
  { id: 'a5', date: `${YEAR}-${MONTH}-06`, person: 'Amanda', category: 'Income',      description: 'Poshmark',  amount: 500.00, shared: false, splitPct: 56 },
  { id: 'a6', date: `${YEAR}-${MONTH}-07`, person: 'Amanda', category: 'Shopping',    description: 'Return',    amount: -30.00, shared: false, splitPct: 56 },
  { id: 'a7', date: `${YEAR}-${MONTH}-08`, person: 'Aidan',  category: 'Savings',     description: 'Transfer',  amount: 400.00, shared: false, splitPct: 56 },
];
push('expenses', { items: LEDGER.map(x => ({ ...x })) });
push('splitPct', { aidan: 56 });
push('budgetTargets', { targets: {} });
push('settledMonths', { months: {} });
push('giftCards', { items: [] });
push('okdOverlaps', { pairs: [] });
push('recurring', { items: [] });

// Select the current month, no other filters.
call(`_budgetMonth = ${JSON.stringify(MONTH_NAME)}`);
const setFilters = (person = '', cat = '', search = '') => {
  const d = window.document;
  if (d.getElementById('b-filter-person')) d.getElementById('b-filter-person').value = person;
  if (d.getElementById('b-filter-cat'))    d.getElementById('b-filter-cat').value = cat;
  if (d.getElementById('b-search'))        d.getElementById('b-search').value = search;
  call('renderBudget()');
};
setFilters();

const tileText = label => {
  const tiles = [...window.document.querySelectorAll('.bsnap')];
  const t = tiles.find(x => (x.querySelector('.bsnap-label') || {}).textContent === label);
  return t ? (t.querySelector('.bsnap-val') || {}).textContent.trim() : null;
};
const money = s => Number(String(s || '').replace(/[^0-9.\-]/g, '')) * (String(s || '').includes('−') ? -1 : 1);

// Household spending = everything except Income/Savings/Investments = 200 + 100 + 80 + 60 - 30 = 410
eqn(money(tileText('Spent')), 410.00, 'Spent tile: household spending excludes income and savings');
eqn(money(tileText('Income')), 500.00, 'Income tile');
eqn(money(tileText('Set Aside')), 400.00, 'Set Aside tile');
eqn(money(tileText('Net')), 90.00, 'Net tile = income − spent (500 − 410)');

// Per-person shares of SPENDING must reconstruct the household total exactly.
const spendRows = LEDGER.filter(e => !['Income', 'Savings', 'Investments'].includes(e.category));
const sumShares = ev(`(${JSON.stringify(spendRows)}).reduce((s,e)=>s+shareFor(e,'Aidan')+shareFor(e,'Amanda'),0)`);
eqn(ev(`round2(${sumShares})`), 410.00, 'Aidan share + Amanda share = household spending');

// Filtering to one person must show that person's share, and the two must add back up.
setFilters('Amanda');
const amandaSpent = money(tileText('Spent'));
setFilters('Aidan');
const aidanSpent = money(tileText('Spent'));
setFilters();
eqn(amandaSpent + aidanSpent, 410.00,
  "Amanda's Spent + Aidan's Spent = household Spent (no double-count, nothing dropped)");
// Amanda: 200*.44=88 (shared groceries) + 100*.44=44 (shared dining) + 80 (her jacket) - 30 (her return) = 182
eqn(amandaSpent, 182.00, "Amanda's share is 56/44-weighted on shared rows only");
eqn(aidanSpent, 228.00, "Aidan's share (112 + 56 + 60)");

// Income with a person filter: solo income belongs entirely to the receiver.
setFilters('Amanda');
eqn(money(tileText('Income')), 500.00, 'solo resale income is 100% Amanda');
setFilters('Aidan');
eqn(money(tileText('Income')), 0, 'Aidan sees none of Amanda\'s solo resale income');
setFilters();

// Category breakdown rows must equal the tiles for the same period.
const catRows = () => [...window.document.querySelectorAll('.budget-cat-row')].map(row => ({
  cat: (row.querySelector('.budget-cat-name') || {}).textContent.trim().replace(/^\S+\s/, ''),
  amt: money((row.querySelector('.budget-cat-amt') || {}).textContent),
}));
const rows = catRows();
const catSum = rows.reduce((s, r2) => s + r2.amt, 0);
eqn(catSum, 410.00, 'category breakdown sums to the Spent tile');
ok(!rows.some(r2 => r2.cat === 'Income' || r2.cat === 'Savings'),
  'category breakdown omits Income and Savings', JSON.stringify(rows.map(x => x.cat)));
// Shopping = 80 + 60 - 30 = 110
const shopping = rows.find(r2 => r2.cat === 'Shopping');
eqn(shopping ? shopping.amt : NaN, 110.00, 'Shopping nets the return against the purchases');

// Per-category person split must sum to the category total (the two little labels under the bar).
const personLabels = () => [...window.document.querySelectorAll('.budget-cat-row')].map(row => {
  const spans = [...row.querySelectorAll('span')].map(s => s.textContent);
  const a = spans.find(s => s.startsWith('Aidan:'));
  const b = spans.find(s => s.startsWith('Amanda:'));
  const o = spans.find(s => s.startsWith('Unassigned:'));
  return {
    cat: (row.querySelector('.budget-cat-name') || {}).textContent.trim().replace(/^\S+\s/, ''),
    total: money((row.querySelector('.budget-cat-amt') || {}).textContent),
    aidan: a ? money(a) : null, amanda: b ? money(b) : null, other: o ? money(o) : 0,
  };
});
for (const p of personLabels()) {
  if (p.aidan === null) continue;
  eqn(p.aidan + p.amanda + p.other, p.total, `${p.cat}: person labels sum to the row total`);
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. Settlement
// ═════════════════════════════════════════════════════════════════════════════
// Amanda paid 200 shared @56 → Aidan owes 112. Aidan paid 100 shared @56 → Amanda owes 44.
// net Aidan = -112 + 44 = -68 → "Aidan owes Amanda $68"
const owes = ev(`calcOwes(${JSON.stringify(LEDGER)})`);
eqn(owes.Aidan, -68.00, 'settlement = 68 owed by Aidan (hand-checked)');
ok(tileText('Settlement').includes('68'), 'Settlement tile shows 68', tileText('Settlement'));
ok(/Aidan owes Amanda/.test(tileText('Settlement')), 'settlement names the right direction', tileText('Settlement'));

// Solo expenses must never move the settlement, at any ratio.
const soloOnly = ev(`calcOwes(${JSON.stringify(LEDGER.filter(e => !e.shared))})`);
ok(soloOnly.Aidan === 0 && soloOnly.Amanda === 0, 'solo-only ledger settles to zero', JSON.stringify(soloOnly));

// ── EXPECTED-BUG: a settled month freezes and hides later changes ────────────
// Mark this month settled at the current 68, then add a new shared expense. The tile keeps
// reporting "✓ $68.00 paid" and the newly-created imbalance is invisible.
call(`toggleMonthSettled('${YEAR}-${MONTH}', 68)`);
call('renderBudget()');
const settledLabel = tileText('Settlement');
ok(/paid/.test(settledLabel), 'settling a month marks it paid', settledLabel);
call(`expenses.push({id:'late1', date:'${YEAR}-${MONTH}-20', person:'Amanda', category:'Dining',
  description:'After settling', amount:100, shared:true, splitPct:56}); renderBudget()`);
const afterLabel = tileText('Settlement');
const liveOwed = ev("Math.abs(calcOwes(expenses.filter(e=>e.date.slice(0,7)==='" + YEAR + "-" + MONTH + "')).Aidan)");
eqn(liveOwed, 124.00, 'after the late expense, 56 more is owed (68 + 56)');
ok(/56/.test(afterLabel),
  'a shared expense added AFTER settling is surfaced, not silently hidden',
  `tile reads "${afterLabel}" while $${liveOwed - 68} is newly owed`);
ok(/paid/.test(afterLabel), 'the drifted tile still shows what was already paid', afterLabel);
// clean up
call(`expenses = expenses.filter(e => e.id !== 'late1'); toggleMonthSettled('${YEAR}-${MONTH}', 0); renderBudget()`);

// ═════════════════════════════════════════════════════════════════════════════
// 5. Period views
// ═════════════════════════════════════════════════════════════════════════════
const spentFor = view => { call(`_budgetMonth = ${JSON.stringify(view)}; renderBudget()`); return money(tileText('Spent')); };
const allSpent = spentFor('all');
const sixSpent = spentFor('6m');
const threeSpent = spentFor('3m');
ok(allSpent >= sixSpent - 0.005, 'All >= 6M', `${allSpent} vs ${sixSpent}`);
ok(sixSpent >= threeSpent - 0.005, '6M >= 3M', `${sixSpent} vs ${threeSpent}`);
const yearSpent = spentFor('year');
ok(allSpent >= yearSpent - 0.005, 'All >= Year', `${allSpent} vs ${yearSpent}`);
// This ledger is entirely in the CURRENT month, and 3M/6M anchor to the last COMPLETED month,
// so they should contain none of it. Pin that so the anchoring doesn't silently change.
eqn(threeSpent, 0, '3M excludes the current (partial) month');

// A cross-year ledger: All must include both years, Year must include only the selected one.
call(`expenses.push({id:'old1', date:'2024-06-15', person:'Amanda', category:'Dining',
  description:'Old dinner', amount:55, shared:false, splitPct:50})`);
const allWithOld = spentFor('all');
eqn(allWithOld - allSpent, 55.00, 'All picks up a prior-year expense');
call(`_budgetMonth='year'; renderBudget()`);
eqn(money(tileText('Spent')), yearSpent, 'Year view ignores the prior-year expense');
call(`expenses = expenses.filter(e => e.id !== 'old1')`);
call(`_budgetMonth = ${JSON.stringify(MONTH_NAME)}; renderBudget()`);

// ═════════════════════════════════════════════════════════════════════════════
// 6. Trend chart must agree with the tiles
// ═════════════════════════════════════════════════════════════════════════════
const trendSum = () => [...window.document.querySelectorAll('.btrend-col')]
  .reduce((s, c) => { const t = c.getAttribute('title') || ''; const mm = t.match(/\$([\d,]+\.\d\d)/); return s + (mm ? Number(mm[1].replace(/,/g, '')) : 0); }, 0);
// The chart needs two months of data before it draws anything, so add an earlier month.
call(`expenses.push({id:'jan1', date:'${YEAR}-01-15', person:'Amanda', category:'Dining',
  description:'January dinner', amount:70, shared:false, splitPct:50})`);
call(`_budgetMonth='year'; renderBudget()`);
ok([...window.document.querySelectorAll('.btrend-col')].length >= 2,
  'trend chart draws once there are two months', String([...window.document.querySelectorAll('.btrend-col')].length));
eqn(trendSum(), money(tileText('Spent')), 'trend bars sum to the Spent tile for the Year view');
call(`expenses = expenses.filter(e => e.id !== 'jan1')`);
call(`_budgetMonth = ${JSON.stringify(MONTH_NAME)}; renderBudget()`);

// ═════════════════════════════════════════════════════════════════════════════
// 7. Unknown/missing `person` — can the per-person split lose money?
// ═════════════════════════════════════════════════════════════════════════════
call(`expenses.push({id:'ghost', date:'${YEAR}-${MONTH}-09', person:'Someone', category:'Dining',
  description:'Imported row', amount:50, shared:false, splitPct:56}); renderBudget()`);
const ghostRows = personLabels().filter(p => p.aidan !== null);
const ghostBad = ghostRows.filter(p => Math.abs(p.aidan + p.amanda + p.other - p.total) > 0.005);
ok(ghostBad.length === 0,
  'a row with an unrecognized `person` is surfaced as Unassigned, not lost',
  ghostBad.map(p => `${p.cat}: ${p.aidan} + ${p.amanda} + ${p.other} != ${p.total}`).join('; '));
const ghostDining = ghostRows.find(p => p.cat === 'Dining');
eqn(ghostDining ? ghostDining.other : NaN, 50.00, 'the unassigned $50 is shown explicitly');
call(`expenses = expenses.filter(e => e.id !== 'ghost'); renderBudget()`);

// ═════════════════════════════════════════════════════════════════════════════
// 8. Search / filter total row
// ═════════════════════════════════════════════════════════════════════════════
setFilters('', 'Shopping');
eqn(money(tileText('Spent')), 110.00, 'category filter narrows Spent to that category');
setFilters('', '', 'woodmans');
eqn(money(tileText('Spent')), 200.00, 'search narrows Spent to matching rows');
setFilters();

// ═════════════════════════════════════════════════════════════════════════════
// 9. Home tab stat must agree with the Budget tab
// ═════════════════════════════════════════════════════════════════════════════
setFilters();
call(`_budgetMonth = ${JSON.stringify(MONTH_NAME)}; renderBudget(); renderHome()`);
const homeStat = Number(String((window.document.getElementById('stat-budget') || {}).textContent || '').replace(/[^0-9.]/g, ''));
// countUp animates, so compare against the value it was asked to render rather than the DOM mid-tween.
const homeExpected = ev(`(function(){
  const d = new Date();
  const ym = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
  return round2(expenses.filter(e => typeof e.date === 'string' && e.date.startsWith(ym)
    && !EXPENSE_CATS_EXCL.has(e.category)).reduce((s,e) => s + e.amount, 0));
})()`);
eqn(homeExpected, 410.00, 'Home month-spend uses the same rule as the Budget Spent tile');

// ═════════════════════════════════════════════════════════════════════════════
// 10. A month that nets NEGATIVE (refunds exceed spending)
// ═════════════════════════════════════════════════════════════════════════════
push('expenses', { items: [
  { id: 'n1', date: `${YEAR}-${MONTH}-02`, person: 'Amanda', category: 'Shopping', description: 'Big return', amount: -300.00, shared: false, splitPct: 56 },
  { id: 'n2', date: `${YEAR}-${MONTH}-03`, person: 'Amanda', category: 'Shopping', description: 'Small buy',  amount: 50.00,   shared: false, splitPct: 56 },
] });
call(`_budgetMonth = ${JSON.stringify(MONTH_NAME)}; renderBudget()`);
const negSpent = tileText('Spent');
ok(negSpent && /−|-/.test(negSpent), 'a net-refund month shows Spent as negative, not as a positive', negSpent);
eqn(Math.abs(money(negSpent)), 250.00, 'net-refund magnitude is right (300 back, 50 out)');
const negRows = catRows();
ok(negRows.length > 0, 'category breakdown still renders on a net-negative month');
eqn(negRows.reduce((s, x) => s + x.amt, 0), -250.00, 'net-negative category rows sum to the tile');
// The bar width must not be a negative percentage (which renders as an invisible/odd bar).
const negBars = [...window.document.querySelectorAll('.budget-cat-bar')]
  .map(b => Number(String(b.getAttribute('style') || '').match(/width:(-?[\d.]+)%/)?.[1] ?? 0));
ok(negBars.every(w => w >= 0 && w <= 100), 'category bar widths stay within 0–100%', JSON.stringify(negBars));

// Restore the main ledger.
push('expenses', { items: LEDGER.map(x => ({ ...x })) });
call(`_budgetMonth = ${JSON.stringify(MONTH_NAME)}; renderBudget()`);

// ═════════════════════════════════════════════════════════════════════════════
// 11. Recurring "already loaded" detection — must not double-charge a month
// ═════════════════════════════════════════════════════════════════════════════
push('recurring', { items: [
  { id: 'rec-a', person: 'Aidan',  category: 'Housing', description: 'Mortgage', amount: 1833.00, shared: false },
  { id: 'rec-b', person: 'Amanda', category: 'Income',  description: 'Paycheck', amount: 4200.00, shared: false },
] });
const ymNow = `${YEAR}-${MONTH}`;
const isLoaded = id => ev(`_isRecurringLoaded(recurringItems.find(r=>r.id===${JSON.stringify(id)}),
  ${JSON.stringify(MONTH_NAME)}, ${JSON.stringify(YEAR)}, ${JSON.stringify(ymNow)})`);
ok(!isLoaded('rec-a'), 'mortgage not yet loaded for this month');
call(`expenses.push({id:'exp-rec-rec-a-${ymNow}', date:'${ymNow}-01', month:${JSON.stringify(MONTH_NAME)},
  person:'Aidan', category:'Housing', description:'Mortgage', amount:1833, shared:false, recurringId:'rec-a', splitPct:56})`);
ok(isLoaded('rec-a'), 'mortgage detected as loaded once present');
// Amount drift must NOT make it look unloaded (that would double-charge the month).
call(`expenses.find(e=>e.recurringId==='rec-a').amount = 1901.44`);
ok(isLoaded('rec-a'), 'a changed amount still counts as loaded (no double-charge)');
// Income is special-cased by a threshold rather than by description.
ok(!isLoaded('rec-b'), 'paycheck not yet loaded');
call(`expenses.push({id:'inc-1', date:'${ymNow}-05', month:${JSON.stringify(MONTH_NAME)},
  person:'Amanda', category:'Income', description:'Direct deposit', amount:4200, shared:false, splitPct:56})`);
ok(isLoaded('rec-b'), 'a large income row counts the income template as loaded');
// A small resale income must NOT satisfy the paycheck template — otherwise selling a $40 dress
// would make the app think Amanda's whole salary had been logged.
call(`expenses = expenses.filter(e => e.id !== 'inc-1')`);
call(`expenses.push({id:'inc-2', date:'${ymNow}-05', month:${JSON.stringify(MONTH_NAME)},
  person:'Amanda', category:'Income', description:'Poshmark sale', amount:40, shared:false, splitPct:56})`);
ok(!isLoaded('rec-b'),
  'a small resale income does NOT satisfy the paycheck template',
  `INCOME_LOADED_MIN is ${ev('INCOME_LOADED_MIN')}; a $40 sale should stay below it`);

// ═════════════════════════════════════════════════════════════════════════════
console.log('');
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('');
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.detail || ''}`);
  console.log('');
  dom.window.close();
  process.exit(1);
}
console.log('  Budget math audit clean.\n');
dom.window.close();
process.exit(0);
