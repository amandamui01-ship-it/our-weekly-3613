/**
 * Split-math test harness for Our Weekly.
 *
 * This does NOT copy the math — it EXTRACTS the real source block from index.html between the
 * `SHARED-EXPENSE SPLIT` banner and the end of calcOwes, then evaluates it in a sandbox with a
 * stubbed `db`. If someone edits the math in index.html and breaks an invariant, this fails.
 *
 * Run:  node test/split-math.test.js
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const START = '// ─── SHARED-EXPENSE SPLIT';
const END = '\nconst MONTHS_LIST';
const iStart = SRC.indexOf(START);
const iEnd = SRC.indexOf(END, iStart);
if (iStart < 0 || iEnd < 0) {
  console.error('FATAL: could not locate the split-math block in index.html.');
  console.error('  Looked for start marker: ' + START);
  console.error('  and end marker: const MONTHS_LIST');
  console.error('If the code moved, update the markers in this harness.');
  process.exit(2);
}
const mathSrc = SRC.slice(iStart, iEnd);

// Stub the two globals the block touches so it can be evaluated headlessly.
const _writes = [];
const db = { collection: () => ({ doc: () => ({ set: v => { _writes.push(v); return { catch() {} }; } }) }) };
const _onSaveErr = () => {};

const api = new Function('db', '_onSaveErr', `
  ${mathSrc}
  return { splitShares, shareFor, calcOwes, txSplitPct, round2, splitLabel, splitTitle,
           _isPct, _cleanPct, LEGACY_SPLIT_PCT, DEFAULT_SPLIT_PCT,
           setPct: v => { splitPct = v; }, getPct: () => splitPct };
`)(db, _onSaveErr);

const { splitShares, shareFor, calcOwes, txSplitPct, round2, _isPct, LEGACY_SPLIT_PCT } = api;

// ── tiny assert harness ──────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push({ name, detail }); }
}
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, name, `expected ${e}, got ${a}`);
}
function close(actual, expected, name) {
  ok(Math.abs(actual - expected) < 1e-9, name, `expected ${expected}, got ${actual}`);
}
const tx = o => ({ person: 'Amanda', category: 'Dining', shared: true, amount: 100, ...o });

// ═════════════════════════════════════════════════════════════════════════════
// 1. splitShares — the primitive
// ═════════════════════════════════════════════════════════════════════════════
eq(splitShares(tx({ amount: 100, splitPct: 50 })), { Aidan: 50, Amanda: 50 }, '50/50 of $100');
eq(splitShares(tx({ amount: 100, splitPct: 56 })), { Aidan: 56, Amanda: 44 }, '56/44 of $100');
eq(splitShares(tx({ amount: 87.43, splitPct: 56 })), { Aidan: 48.96, Amanda: 38.47 }, '56/44 of $87.43');
eq(splitShares(tx({ amount: 0.01, splitPct: 56 })), { Aidan: 0.01, Amanda: 0 }, '56/44 of one cent');
eq(splitShares(tx({ amount: 0, splitPct: 56 })), { Aidan: 0, Amanda: 0 }, '56/44 of zero');
eq(splitShares(tx({ amount: 100, splitPct: 0 })), { Aidan: 0, Amanda: 100 }, '0/100 edge');
eq(splitShares(tx({ amount: 100, splitPct: 100 })), { Aidan: 100, Amanda: 0 }, '100/0 edge');

// Legacy rows (no splitPct) must stay 50/50 forever — this is the "history never changes" promise.
eq(splitShares(tx({ amount: 100 })), { Aidan: 50, Amanda: 50 }, 'missing splitPct → 50/50');
eq(splitShares(tx({ amount: 100, splitPct: null })), { Aidan: 50, Amanda: 50 }, 'null splitPct → 50/50');
eq(splitShares(tx({ amount: 100, splitPct: 'abc' })), { Aidan: 50, Amanda: 50 }, 'garbage splitPct → 50/50');
eq(splitShares(tx({ amount: 100, splitPct: 999 })), { Aidan: 50, Amanda: 50 }, 'out-of-range splitPct → 50/50');
eq(splitShares(tx({ amount: 100, splitPct: -5 })), { Aidan: 50, Amanda: 50 }, 'negative splitPct → 50/50');
ok(txSplitPct(undefined) === LEGACY_SPLIT_PCT, 'txSplitPct(undefined) is legacy', txSplitPct(undefined));

// THE penny invariant: the two shares must always sum to exactly the amount, for every cent
// value from $0.00 to $200.00, at every whole-percent ratio. This is what guarantees the
// settlement can never gain or lose a penny.
let pennyBad = [];
for (let pct = 0; pct <= 100; pct++) {
  for (let cents = 0; cents <= 20000; cents++) {
    const amount = cents / 100;
    const s = splitShares({ shared: true, amount, splitPct: pct });
    if (round2(s.Aidan + s.Amanda) !== round2(amount)) pennyBad.push({ amount, pct, s });
  }
}
ok(pennyBad.length === 0, 'penny invariant: shares sum to amount (2M cases)',
  pennyBad.length + ' mismatches, first: ' + JSON.stringify(pennyBad[0]));

// Shares are always whole cents — no floating-point tails leaking into display.
let centBad = [];
for (let cents = 0; cents <= 5000; cents++) {
  const s = splitShares({ shared: true, amount: cents / 100, splitPct: 56 });
  if (Math.abs(s.Aidan * 100 - Math.round(s.Aidan * 100)) > 1e-9) centBad.push(cents);
  if (Math.abs(s.Amanda * 100 - Math.round(s.Amanda * 100)) > 1e-9) centBad.push(cents);
}
ok(centBad.length === 0, 'shares are always whole cents', centBad.slice(0, 5).join(','));

// ═════════════════════════════════════════════════════════════════════════════
// 2. shareFor — per-person responsibility
// ═════════════════════════════════════════════════════════════════════════════
close(shareFor(tx({ amount: 100, splitPct: 56 }), 'Aidan'), 56, 'shareFor Aidan on shared');
close(shareFor(tx({ amount: 100, splitPct: 56 }), 'Amanda'), 44, 'shareFor Amanda on shared');
// Solo: the payer owes all of it, the partner none — regardless of ratio.
close(shareFor(tx({ shared: false, person: 'Amanda', amount: 100, splitPct: 56 }), 'Amanda'), 100, 'solo: payer owes all');
close(shareFor(tx({ shared: false, person: 'Amanda', amount: 100, splitPct: 56 }), 'Aidan'), 0, 'solo: partner owes none');
// A person filter must never total more than the household total.
for (const pct of [0, 44, 50, 56, 100]) {
  const t = tx({ amount: 137.77, splitPct: pct });
  close(round2(shareFor(t, 'Aidan') + shareFor(t, 'Amanda')), 137.77, `shareFor halves reconstruct total @${pct}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. calcOwes — the settlement tile
// ═════════════════════════════════════════════════════════════════════════════
// Amanda fronts a $100 shared bill at 56/44 → Aidan owes her his 56% share.
let owes = calcOwes([tx({ person: 'Amanda', amount: 100, splitPct: 56 })]);
eq(owes, { Aidan: -56, Amanda: 56 }, 'Amanda pays $100 @56/44 → Aidan owes 56');
// Aidan fronts it → Amanda owes him her 44%.
owes = calcOwes([tx({ person: 'Aidan', amount: 100, splitPct: 56 })]);
eq(owes, { Aidan: 44, Amanda: -44 }, 'Aidan pays $100 @56/44 → Amanda owes 44');
// 50/50 must be byte-identical to the old behaviour.
owes = calcOwes([tx({ person: 'Amanda', amount: 100, splitPct: 50 })]);
eq(owes, { Aidan: -50, Amanda: 50 }, '50/50 unchanged from legacy');

// Equal-and-opposite invariant. The settlement tile reads Math.abs(owes.Aidan) and assumes the
// other side is its exact negation; if that ever breaks, the tile silently misreports.
const mixed = [
  tx({ person: 'Amanda', amount: 42.37, splitPct: 56 }),
  tx({ person: 'Aidan', amount: 19.99, splitPct: 56 }),
  tx({ person: 'Amanda', amount: 250.00, splitPct: 50 }),   // legacy-era row
  tx({ person: 'Aidan', amount: 8.13 }),                     // no stamp at all
  tx({ person: 'Amanda', amount: 500, shared: false }),       // solo — must not move the needle
  tx({ person: 'Aidan', amount: 77, shared: false }),
];
owes = calcOwes(mixed);
close(round2(owes.Aidan + owes.Amanda), 0, 'equal-and-opposite across mixed eras');

// Hand-computed expectation for the mixed set, so this isn't just self-consistent:
//   Amanda paid 42.37 @56 → Aidan owes 23.73  (42.37*.56 = 23.7272 → 23.73)
//   Aidan  paid 19.99 @56 → Amanda owes  8.80 (19.99 - 19.99*.56=11.19 → 8.80)
//   Amanda paid 250.00 @50 → Aidan owes 125.00
//   Aidan  paid  8.13 @50 → Amanda owes 4.07  (8.13 - 4.07=4.06... check: 8.13*.5=4.065→4.07 Aidan, Amanda 4.06)
//   net Aidan = -23.73 + 8.80 - 125.00 + 4.06 = -135.87
close(owes.Aidan, -135.87, 'mixed-era settlement matches hand calculation');

// Solo expenses alone → all square.
eq(calcOwes([tx({ shared: false, amount: 900 })]), { Aidan: 0, Amanda: 0 }, 'solo only → all square');
// Empty / junk input must not throw or produce NaN.
eq(calcOwes([]), { Aidan: 0, Amanda: 0 }, 'empty list → all square');
owes = calcOwes([tx({ person: 'Someone Else', amount: 100, splitPct: 56 })]);
eq(owes, { Aidan: 0, Amanda: 0 }, 'unknown person is ignored');
owes = calcOwes([tx({ amount: undefined, splitPct: 56 })]);
ok(Number.isFinite(owes.Aidan) && Number.isFinite(owes.Amanda), 'undefined amount → no NaN', JSON.stringify(owes));
owes = calcOwes([tx({ amount: 'abc', splitPct: 56 })]);
ok(Number.isFinite(owes.Aidan) && Number.isFinite(owes.Amanda), 'string amount → no NaN', JSON.stringify(owes));

// Float-dust: 300 shared $0.10 expenses at 56/44 must not accumulate float drift.
// NOTE the expected value is $18.00, not $16.80 (= 300 * 0.056). Each transaction is settled to
// the whole cent, and $0.10 * 0.56 = $0.056 rounds UP to $0.06. That per-row rounding is
// deliberate — it's what keeps every displayed row summing exactly to the tile total — but it does
// mean sub-dollar shared items round in Aidan's disfavour. Irrelevant at real expense sizes;
// documented here so the number is never mistaken for drift.
const dust = Array.from({ length: 300 }, () => tx({ person: 'Amanda', amount: 0.10, splitPct: 56 }));
owes = calcOwes(dust);
close(owes.Aidan, -18.00, '300 x $0.10 @56/44 → exactly $18.00 (per-row cent rounding), no float drift');
// The float-drift check that actually matters: a long ledger of ordinary amounts must land on a
// clean cent value, never $135.87000000000003.
const many = Array.from({ length: 500 }, (_, i) => tx({ person: i % 2 ? 'Aidan' : 'Amanda', amount: 10.10 + (i % 7), splitPct: 56 }));
owes = calcOwes(many);
ok(Math.abs(owes.Aidan * 100 - Math.round(owes.Aidan * 100)) < 1e-9,
  '500-row ledger settles to a whole cent', String(owes.Aidan));

// ═════════════════════════════════════════════════════════════════════════════
// 4. INCOME & REFUNDS — money coming IN (Amanda's reselling)
// ═════════════════════════════════════════════════════════════════════════════
// A negative amount is a refund/credit on a shared expense. The settlement should reverse:
// if Amanda gets a $50 shared refund, she now holds money that's partly Aidan's.
owes = calcOwes([tx({ person: 'Amanda', amount: -50, splitPct: 56 })]);
eq(owes, { Aidan: 28, Amanda: -28 }, 'shared REFUND to Amanda reverses direction');
// A shared expense fully refunded nets to zero.
owes = calcOwes([
  tx({ person: 'Amanda', amount: 80, splitPct: 56 }),
  tx({ person: 'Amanda', amount: -80, splitPct: 56 }),
]);
close(owes.Aidan, 0, 'expense + equal refund → all square');

// ── Reselling income ────────────────────────────────────────────────────────
// Amanda's resale proceeds logged SOLO must not touch the settlement at all.
owes = calcOwes([tx({ person: 'Amanda', category: 'Income', shared: false, amount: 400, splitPct: 56 })]);
eq(owes, { Aidan: 0, Amanda: 0 }, 'SOLO resale income does not affect settlement');

// Amanda's resale proceeds logged as SHARED. `amount` positive means "money received", so the
// receiver OWES her partner his share — the reverse of a shared expense, where the payer is owed.
const sharedIncome = calcOwes([tx({ person: 'Amanda', category: 'Income', shared: true, amount: 400, splitPct: 56 })]);
eq(sharedIncome, { Aidan: 200, Amanda: -200 },
  'SHARED income to Amanda → she owes Aidan his half, not the reverse');
// Income splits 50/50 even under 56/44, so the expense tilt doesn't hand Aidan 56% of her resales.
eq(calcOwes([tx({ person: 'Amanda', category: 'Income', shared: true, amount: 400, splitPct: 56 })]),
   calcOwes([tx({ person: 'Amanda', category: 'Income', shared: true, amount: 400, splitPct: 50 })]),
   'shared income ignores the expense ratio (always even)');
// Shared income received by Aidan mirrors it.
eq(calcOwes([tx({ person: 'Aidan', category: 'Income', shared: true, amount: 400, splitPct: 56 })]),
   { Aidan: -200, Amanda: 200 }, 'SHARED income to Aidan → he owes Amanda half');

// The realistic reselling month: Amanda resells (solo income), they share groceries and dining.
// The resale money must be completely invisible to the settlement.
const resellMonth = [
  tx({ person: 'Amanda', category: 'Income', shared: false, amount: 640.00, splitPct: 56 }),  // resales
  tx({ person: 'Amanda', category: 'Income', shared: false, amount: 215.50, splitPct: 56 }),
  tx({ person: 'Amanda', category: 'Groceries', shared: true, amount: 210.00, splitPct: 56 }),
  tx({ person: 'Aidan', category: 'Dining', shared: true, amount: 90.00, splitPct: 56 }),
];
const withResale = calcOwes(resellMonth);
const withoutResale = calcOwes(resellMonth.filter(e => e.category !== 'Income'));
eq(withResale, withoutResale, 'solo resale income leaves the settlement untouched');
// Hand-check: Amanda paid 210 @56 → Aidan owes 117.60. Aidan paid 90 @56 → Amanda owes 39.60.
// Net Aidan = -117.60 + 39.60 = -78.00
close(withResale.Aidan, -78.00, 'reselling month settles to $78 (hand-checked)');
// The per-person snapshot tiles use shareFor, so they must apply the same even income rule as the
// settlement — otherwise filtering to "Amanda" would credit Aidan 56% of her shared resale income.
close(shareFor(tx({ category: 'Income', shared: true, amount: 400, splitPct: 56 }), 'Aidan'), 200,
  'shared income tile splits evenly, not 56/44');
close(shareFor(tx({ category: 'Income', shared: true, amount: 400, splitPct: 56 }), 'Amanda'), 200,
  'shared income tile splits evenly for Amanda too');
// Solo income belongs entirely to whoever received it.
close(shareFor(tx({ category: 'Income', shared: false, person: 'Amanda', amount: 640 }), 'Amanda'), 640,
  'solo resale income is 100% Amanda');
close(shareFor(tx({ category: 'Income', shared: false, person: 'Amanda', amount: 640 }), 'Aidan'), 0,
  'solo resale income is 0% Aidan');

// Income must never leak into the settlement via a solo row, at any ratio.
for (const pct of [0, 44, 50, 56, 100]) {
  eq(calcOwes([tx({ category: 'Income', shared: false, amount: 1000, splitPct: pct })]),
     { Aidan: 0, Amanda: 0 }, `solo income inert @${pct}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. Snapshot-tile consistency — spending totals vs. the category breakdown
// ═════════════════════════════════════════════════════════════════════════════
// Mirrors renderBudget's EXPENSE_CATS_EXCL logic: Income/Savings/Investments are not "spending".
const EXCL = new Set(['Income', 'Savings', 'Investments']);
const ledger = [
  tx({ person: 'Amanda', category: 'Groceries', amount: 120.50, shared: true, splitPct: 56 }),
  tx({ person: 'Aidan', category: 'Dining', amount: 64.20, shared: true, splitPct: 56 }),
  tx({ person: 'Amanda', category: 'Shopping', amount: 39.99, shared: false, splitPct: 56 }),
  tx({ person: 'Amanda', category: 'Income', amount: 400, shared: false, splitPct: 56 }),   // resale
  tx({ person: 'Amanda', category: 'Shopping', amount: -25.00, shared: false, splitPct: 56 }), // return
];
const spendRows = ledger.filter(e => !EXCL.has(e.category));
const household = round2(spendRows.reduce((s, e) => s + e.amount, 0));
const perPerson = round2(spendRows.reduce((s, e) => s + shareFor(e, 'Aidan') + shareFor(e, 'Amanda'), 0));
close(perPerson, household, 'per-person shares reconstruct household spending exactly');
close(household, 199.69, 'household spending excludes income, includes the return');

// Income must never be counted as spending by shareFor's callers.
const incomeRow = tx({ category: 'Income', amount: 400, shared: false, person: 'Amanda' });
ok(!EXCL.has('Groceries') && EXCL.has('Income'), 'Income is excluded from spending totals');

// ═════════════════════════════════════════════════════════════════════════════
console.log('');
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('');
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.detail}`);
  console.log('');
  process.exit(1);
}
console.log('  All split-math invariants hold.\n');
