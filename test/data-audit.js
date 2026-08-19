#!/usr/bin/env node
/**
 * Health report for your REAL data.
 *
 * Everything else in test/ checks that the code computes correctly. This checks whether the data
 * already sitting in Firestore is sane — duplicates, rows that can't be attributed, dates that
 * disagree with themselves, amounts stored as text. Those produce wrong ANSWERS even when the math
 * is right.
 *
 * Usage:
 *   1. In the app: Budget → ⚙️ Settings → Data → Export backup
 *   2. node test/data-audit.js ~/Downloads/our-weekly-backup-2026-08-18.json
 *
 * READ-ONLY. It never writes, never uploads, and never modifies the export. Everything stays on
 * this machine.
 */
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.log(`
  Usage: node test/data-audit.js <export.json>

  Get the file from the app: Budget → ⚙️ Settings → Data → "Export backup".
  Nothing is uploaded — the file is read locally and only a summary is printed.
`);
  process.exit(1);
}
if (!fs.existsSync(file)) { console.error(`  No such file: ${file}`); process.exit(1); }

let data;
try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (err) { console.error(`  That file isn't valid JSON: ${err.message}`); process.exit(1); }

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const EXCL = new Set(['Income', 'Savings', 'Investments']);
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const money = n => '$' + Math.abs(round2(n)).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

const findings = [];   // {level: 'problem'|'warn'|'note', title, detail, rows}
const add = (level, title, detail, rows = []) => findings.push({ level, title, detail, rows });

const expenses = Array.isArray(data.expenses) ? data.expenses : [];
const trips    = Array.isArray(data.trips) ? data.trips : [];
const todos    = Array.isArray(data.todos) ? data.todos : [];
const recurring = Array.isArray(data.recurringItems) ? data.recurringItems : [];
const settled  = (data.settledMonths && typeof data.settledMonths === 'object') ? data.settledMonths : {};
const cards    = Array.isArray(data.giftCards) ? data.giftCards : [];
const spends   = Array.isArray(data.giftCardSpends) ? data.giftCardSpends : [];

console.log('');
console.log(`  Our Weekly — data health report`);
console.log(`  file: ${path.basename(file)}`);
if (data.exportedAt) console.log(`  exported: ${data.exportedAt}`);
console.log(`  ${expenses.length} expenses · ${trips.length} trips · ${todos.length} to-dos · ` +
            `${recurring.length} recurring templates · ${cards.length} gift cards`);

// ═══ EXPENSES ════════════════════════════════════════════════════════════════
const label = e => `${e.date || '????'} ${e.person || '?'} ${e.category || '?'} "${(e.description || '').slice(0, 30)}" ${money(e.amount)}`;

// 1. Structurally broken rows.
const noDate = expenses.filter(e => typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date));
if (noDate.length) add('problem', `${noDate.length} expense(s) with a missing or malformed date`,
  'The Budget tab silently drops these from every view, so they are invisible but still in your data.',
  noDate.map(label));

const badAmount = expenses.filter(e => typeof e.amount !== 'number' || !Number.isFinite(e.amount));
if (badAmount.length) add('problem', `${badAmount.length} expense(s) whose amount is not a number`,
  'A string amount ("42.50") can behave unpredictably in sums. Re-save each row to fix.',
  badAmount.map(e => `${label(e)}  (amount is ${typeof e.amount}: ${JSON.stringify(e.amount)})`));

const subCent = expenses.filter(e => typeof e.amount === 'number' && Math.abs(e.amount * 100 - Math.round(e.amount * 100)) > 1e-9);
if (subCent.length) add('warn', `${subCent.length} expense(s) with sub-cent precision`,
  'Amounts like 12.345 round differently in different views. Round them to cents.',
  subCent.map(label));

// 2. Rows that can't be attributed to either person.
const ghost = expenses.filter(e => e.person !== 'Amanda' && e.person !== 'Aidan');
if (ghost.length) add('problem', `${ghost.length} expense(s) not attributed to Amanda or Aidan`,
  'These count toward category totals but toward neither person\'s share, and shared ones are ' +
  'skipped by the settlement entirely. The Budget tab now labels them "Unassigned".',
  ghost.map(e => `${label(e)}  (person = ${JSON.stringify(e.person)})`));

// 3. `month` name disagreeing with the date it's supposed to describe.
const monthDrift = expenses.filter(e => {
  if (typeof e.date !== 'string' || !/^\d{4}-\d{2}/.test(e.date)) return false;
  if (typeof e.month !== 'string') return false;
  return e.month !== MONTHS[parseInt(e.date.slice(5, 7), 10) - 1];
});
if (monthDrift.length) add('warn', `${monthDrift.length} expense(s) whose month label disagrees with its date`,
  'Every view keys off the DATE, so these are filed correctly — the stale label is cosmetic. ' +
  'Worth knowing if you ever read the raw data.',
  monthDrift.map(e => `${label(e)}  (labelled "${e.month}", date says ${MONTHS[parseInt(e.date.slice(5,7),10)-1]})`));

// 4. Duplicate ids — two rows sharing an id is genuinely dangerous, because edits and deletes
//    address rows BY id and would hit the wrong one.
const byId = {};
for (const e of expenses) byId[e.id] = (byId[e.id] || 0) + 1;
const dupIds = Object.entries(byId).filter(([, n]) => n > 1);
if (dupIds.length) add('problem', `${dupIds.length} expense id(s) used by more than one row`,
  'Editing or deleting one of these can affect the wrong row. Delete and re-add the duplicates.',
  dupIds.map(([id, n]) => `id ${id} × ${n}`));

const noId = expenses.filter(e => !e.id);
if (noId.length) add('problem', `${noId.length} expense(s) with no id`, 'These cannot be edited or deleted from the UI.', noId.map(label));

// 5. Likely duplicate transactions: same date, person, category, description and amount.
const sig = e => `${e.date}|${e.person}|${e.category}|${(e.description || '').toLowerCase().trim()}|${round2(e.amount)}`;
const bySig = {};
for (const e of expenses) (bySig[sig(e)] = bySig[sig(e)] || []).push(e);
const dupTx = Object.values(bySig).filter(g => g.length > 1);
if (dupTx.length) {
  const total = dupTx.reduce((s, g) => s + round2(g[0].amount) * (g.length - 1), 0);
  add('warn', `${dupTx.length} set(s) of identical transactions (possible double-entry)`,
    `If these are accidental duplicates they inflate your spending by about ${money(total)}. ` +
    'Some may be legitimate (two identical coffees on one day) — worth eyeballing.',
    dupTx.map(g => `${g.length}× ${label(g[0])}`));
}

// 6. Recurring rows loaded twice into the same month.
const recSeen = {};
for (const e of expenses) {
  if (!e.recurringId || typeof e.date !== 'string') continue;
  const k = `${e.recurringId}|${e.date.slice(0, 7)}`;
  (recSeen[k] = recSeen[k] || []).push(e);
}
const dupRec = Object.entries(recSeen).filter(([, g]) => g.length > 1);
if (dupRec.length) {
  const total = dupRec.reduce((s, [, g]) => s + round2(g[0].amount) * (g.length - 1), 0);
  add('problem', `${dupRec.length} recurring expense(s) loaded more than once into the same month`,
    `This double-charges those months by about ${money(total)}.`,
    dupRec.map(([k, g]) => `${g.length}× ${label(g[0])}  (template ${k.split('|')[0]})`));
}

// 7. Split-ratio sanity.
const badPct = expenses.filter(e => e.splitPct !== undefined && e.splitPct !== null &&
  !(typeof e.splitPct === 'number' && e.splitPct >= 0 && e.splitPct <= 100));
if (badPct.length) add('problem', `${badPct.length} expense(s) with an invalid split percentage`,
  'These fall back to 50/50, which may not be what you intended.',
  badPct.map(e => `${label(e)}  (splitPct = ${JSON.stringify(e.splitPct)})`));

const sharedIncome = expenses.filter(e => e.shared && e.category === 'Income');
if (sharedIncome.length) add('note', `${sharedIncome.length} income row(s) marked shared`,
  'Shared income splits EVENLY and reverses the settlement (the receiver owes their partner a ' +
  'half). If any of these are actually your own resale money, un-share them.',
  sharedIncome.map(label));

const sharedSavings = expenses.filter(e => e.shared && (e.category === 'Savings' || e.category === 'Investments'));
if (sharedSavings.length) {
  const tot = sharedSavings.reduce((s, e) => s + round2(e.amount), 0);
  add('note', `${sharedSavings.length} savings/investment transfer(s) marked shared (${money(tot)} total)`,
    'These DO count toward who-owes-who. If a transfer into a joint account is not something your ' +
    'partner owes you a share of, un-share it.',
    sharedSavings.map(label));
}

// 8. Dates that are implausible.
const nowYear = new Date().getFullYear();
const oddDates = expenses.filter(e => typeof e.date === 'string' && /^\d{4}/.test(e.date) &&
  (+e.date.slice(0, 4) < 2020 || +e.date.slice(0, 4) > nowYear + 1));
if (oddDates.length) add('warn', `${oddDates.length} expense(s) dated outside 2020–${nowYear + 1}`,
  'Usually a typo in the year, which hides the row in the wrong period.', oddDates.map(label));

const future = expenses.filter(e => typeof e.date === 'string' && e.date > new Date().toISOString().slice(0, 10));
if (future.length) add('note', `${future.length} expense(s) dated in the future`, 'Fine if intentional.', future.map(label));

// 9. Categories the app doesn't know about.
const KNOWN = new Set(['Dining','Entertainment','Groceries','Housing','Income','Insurance','Investments','Misc','Pet','Savings','Shopping','Subscriptions','Transportation','Travel','Utilities']);
const oddCats = [...new Set(expenses.map(e => e.category).filter(c => c && !KNOWN.has(c)))];
if (oddCats.length) add('warn', `${oddCats.length} unrecognized categor${oddCats.length === 1 ? 'y' : 'ies'}`,
  'These still total correctly but get no colour, emoji or budget target.', oddCats);

// ═══ SETTLED MONTHS vs. reality ══════════════════════════════════════════════
// Recompute each settled month's balance and compare against what was recorded as paid.
function calcOwes(list) {
  let net = { Aidan: 0, Amanda: 0 };
  for (const tx of list) {
    if (!tx.shared) continue;
    if (tx.person !== 'Aidan' && tx.person !== 'Amanda') continue;
    const isIncome = tx.category === 'Income';
    const pct = isIncome ? 50 : (typeof tx.splitPct === 'number' && tx.splitPct >= 0 && tx.splitPct <= 100 ? tx.splitPct : 50);
    const a = round2((Number(tx.amount) || 0) * pct / 100);
    const shares = { Aidan: a, Amanda: round2((Number(tx.amount) || 0) - a) };
    const other = tx.person === 'Aidan' ? 'Amanda' : 'Aidan';
    const dir = isIncome ? -1 : 1;
    net[tx.person] += dir * shares[other];
    net[other] -= dir * shares[other];
  }
  return { Aidan: round2(net.Aidan), Amanda: round2(net.Amanda) };
}
const drifted = [];       // genuinely new activity since settling
const recalcNoise = [];   // pennies from the rounding change, not money owed
for (const [ym, rec] of Object.entries(settled)) {
  const paid = (rec && typeof rec === 'object') ? Number(rec.paid) || 0 : Number(rec) || 0;
  const netThen = (rec && typeof rec === 'object' && Number.isFinite(rec.net)) ? rec.net : null;
  const monthRows = expenses.filter(e => typeof e.date === 'string' && e.date.slice(0, 7) === ym);
  const live = calcOwes(monthRows);
  const outstanding = netThen !== null ? round2(live.Aidan - netThen) : round2(Math.abs(live.Aidan) - paid);
  if (Math.abs(outstanding) < 0.01) continue;

  if (netThen !== null) {
    // Signed record → the comparison is exact, so any difference is real activity.
    drifted.push({ ym, paid, outstanding, live: live.Aidan });
    continue;
  }
  // LEGACY record (a bare magnitude, written before the settlement stored its sign). Those totals
  // were produced by the old settlement code, which summed UNROUNDED halves (amount / 2) and only
  // rounded at the very end. The current code rounds each row's share to the cent, which is what
  // guarantees the displayed rows sum exactly to the tile. For any shared row with an odd cent, a
  // half lands on a half-cent and the two approaches differ by up to half a cent per row.
  //
  // So the maximum difference attributable purely to that change is ~0.005 per shared row. Below
  // that, the delta is recomputation noise rather than money that never got paid — reporting it as
  // "unpaid" would be a false alarm, which is worse than useless in a health check.
  const sharedRows = monthRows.filter(e => e.shared && (e.person === 'Amanda' || e.person === 'Aidan')).length;
  const tolerance = round2(0.005 * sharedRows + 0.01);
  if (Math.abs(outstanding) <= tolerance) recalcNoise.push({ ym, paid, outstanding, sharedRows, tolerance });
  else drifted.push({ ym, paid, outstanding, live: live.Aidan });
}
if (drifted.length) {
  const tot = drifted.reduce((s, d) => s + Math.abs(d.outstanding), 0);
  add('problem', `${drifted.length} settled month(s) have activity logged after they were settled`,
    `About ${money(tot)} in total was added after you squared up, so it may never have been paid. ` +
    'The Settlement tile now flags this, but these predate that.',
    drifted.map(d => `${d.ym}: ${money(d.paid)} was paid, ${money(d.outstanding)} added since ` +
                     `(balance is now ${money(d.live)} ${d.live > 0 ? 'owed by Amanda' : 'owed by Aidan'})`));
}
if (recalcNoise.length) {
  const tot = recalcNoise.reduce((s, d) => s + Math.abs(d.outstanding), 0);
  add('note', `${recalcNoise.length} settled month(s) recompute a few cents differently (${money(tot)} in total)`,
    'NOT money owed. These were settled before shared amounts were rounded per-transaction; the ' +
    'old code summed unrounded halves. Recomputing them now shifts the total by a fraction of a ' +
    'cent per shared row. Nothing to do — listed only so the difference is accounted for.',
    recalcNoise.map(d => `${d.ym}: recorded ${money(d.paid)}, recomputes ${money(d.outstanding)} ` +
                         `different across ${d.sharedRows} shared rows (rounding accounts for up to ${money(d.tolerance)})`));
}

// ═══ GIFT CARDS ══════════════════════════════════════════════════════════════
const cardIds = new Set(cards.map(c => c.id));
const orphanSpends = spends.filter(s => !cardIds.has(s.cardId));
if (orphanSpends.length) add('warn', `${orphanSpends.length} gift-card spend(s) referencing a deleted card`,
  'Harmless but dead weight.', orphanSpends.map(s => `${s.date} ${money(s.amount)} → card ${s.cardId}`));

const overdrawn = cards.filter(c => {
  const spent = (c.redemptions || []).concat(spends.filter(s => s.cardId === c.id))
    .reduce((t, r) => t + (Number(r.amount) || 0), 0);
  return round2((Number(c.amount) || 0) - spent) < -0.005;
});
if (overdrawn.length) add('warn', `${overdrawn.length} gift card(s) show more spent than the card held`,
  'Probably a typo in one of the logged spends.',
  overdrawn.map(c => `${c.label}: face ${money(c.amount)}`));

// Expiry is optional, so a MISSING one is fine — but a present-and-malformed one is silently
// ignored by the app, which means a card you believe is tracked has no deadline at all.
const badExpiry = cards.filter(c => c.expires !== undefined && c.expires !== null && c.expires !== ''
  && !/^\d{4}-\d{2}-\d{2}$/.test(String(c.expires)));
if (badExpiry.length) add('warn', `${badExpiry.length} gift card(s) with an unreadable expiration date`,
  'The app ignores these, so the card shows no deadline. Re-pick the date.',
  badExpiry.map(c => `${c.label}: expires "${c.expires}"`));

// Already-past expiry with money still on it: real money about to be (or already) lost.
const _todayIso = new Date().toISOString().slice(0, 10);
const deadWithBalance = cards.filter(c => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.expires || ''))) return false;
  if (c.expires >= _todayIso) return false;
  const spent = (c.redemptions || []).concat(spends.filter(s => s.cardId === c.id))
    .reduce((t, r) => t + (Number(r.amount) || 0), 0);
  return round2((Number(c.amount) || 0) - spent) >= 0.01;
});
if (deadWithBalance.length) add('warn', `${deadWithBalance.length} expired gift card(s) still showing a balance`,
  'That money is probably gone. Delete them, or check whether the issuer honors it anyway.',
  deadWithBalance.map(c => {
    const spent = (c.redemptions || []).concat(spends.filter(s => s.cardId === c.id))
      .reduce((t, r) => t + (Number(r.amount) || 0), 0);
    return `${c.label}: ${money(round2((Number(c.amount) || 0) - spent))} left, expired ${c.expires}`;
  }));

// ═══ TRIPS ═══════════════════════════════════════════════════════════════════
const noSort = trips.filter(t => !t.sortDate);
if (noSort.length) add('warn', `${noSort.length} trip(s) with no parsed date`,
  'These get no countdown and never appear on the calendar grid. The app now re-parses the date ' +
  'text on load, so if the text is readable this fixes itself the next time you open the app — ' +
  're-export afterwards and it should be gone. If it persists, the dates field needs retyping.',
  noSort.map(t => `"${t.label}" (dates: "${t.dates || ''}")`));

const tripDupIds = Object.entries(trips.reduce((m, t) => (m[t.id] = (m[t.id] || 0) + 1, m), {})).filter(([, n]) => n > 1);
if (tripDupIds.length) add('problem', `${tripDupIds.length} trip id(s) used more than once`,
  'Editing one may change the other.', tripDupIds.map(([id, n]) => `id ${id} × ${n}`));

// ═══ TO-DOS ══════════════════════════════════════════════════════════════════
const badDue = todos.filter(t => t.due !== undefined && t.due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(t.due)));
if (badDue.length) add('warn', `${badDue.length} to-do(s) with an unparseable due date`,
  'These show no deadline badge and never appear on the calendar.',
  badDue.map(t => `"${t.text}" (due = ${JSON.stringify(t.due)})`));

const orphanTodos = todos.filter(t => Array.isArray(data.todoCategories) && data.todoCategories.length &&
  !data.todoCategories.some(c => c.id === t.cat));
if (orphanTodos.length) add('warn', `${orphanTodos.length} to-do(s) in a section that no longer exists`,
  'These are invisible in the app but still in your data.',
  orphanTodos.map(t => `"${t.text}" (section ${JSON.stringify(t.cat)})`));

// A repeat rule the app can't read is the worst kind of silent failure: the to-do looks like a
// recurring chore, but on completion _advanceRepeat() bails and it just gets ticked off forever.
// Mirrors _isRepeat() in index.html — keep the two in step.
const REPEAT_UNITS = new Set(['day', 'week', 'month', 'year']);
const validRepeat = r => !!r && typeof r === 'object' && Number.isInteger(r.every)
  && r.every >= 1 && r.every <= 365 && REPEAT_UNITS.has(r.unit);

const badRepeat = todos.filter(t => t.repeat !== undefined && t.repeat !== null && !validRepeat(t.repeat));
if (badRepeat.length) add('problem', `${badRepeat.length} to-do(s) with an unreadable repeat rule`,
  'These look recurring in the app but will NOT come back after you check them off. Re-pick the repeat from the deadline popup.',
  badRepeat.map(t => `"${t.text}" (repeat = ${JSON.stringify(t.repeat)})`));

// Recurrence is anchored to the due date; without one there is nothing to advance from.
const repeatNoDue = todos.filter(t => validRepeat(t.repeat) && !/^\d{4}-\d{2}-\d{2}$/.test(String(t.due || '')));
if (repeatNoDue.length) add('warn', `${repeatNoDue.length} recurring to-do(s) with no deadline`,
  'A repeat needs a due date to count forward from. Set a deadline or clear the repeat.',
  repeatNoDue.map(t => `"${t.text}" (repeat = ${JSON.stringify(t.repeat)}, due = ${JSON.stringify(t.due)})`));

const badLastDone = todos.filter(t => t.lastDone !== undefined && t.lastDone !== null
  && !/^\d{4}-\d{2}-\d{2}$/.test(String(t.lastDone)));
if (badLastDone.length) add('warn', `${badLastDone.length} to-do(s) with an unreadable "last done" date`,
  'Cosmetic — the "last done" line just will not show.',
  badLastDone.map(t => `"${t.text}" (lastDone = ${JSON.stringify(t.lastDone)})`));

// ═══ YEARLY EVENTS ═══════════════════════════════════════════════════════════
// A yearly event is stored once and expanded from its own date, so a bad date means it renders on
// no day at all — in any year.
const events = Array.isArray(data.datedEvents) ? data.datedEvents : [];
const badYearly = events.filter(e => e && e.repeat === 'year'
  && !/^\d{4}-\d{2}-\d{2}$/.test(String(e.date || '')));
if (badYearly.length) add('problem', `${badYearly.length} yearly event(s) with an unusable date`,
  'A yearly event repeats from its own date. With a bad date it never appears on the calendar at all.',
  badYearly.map(e => `"${e.text}" (date = ${JSON.stringify(e.date)})`));

// 'year' is the only recurrence events support; anything else is ignored by _yearlyHitsDate().
const oddEventRepeat = events.filter(e => e && e.repeat !== undefined && e.repeat !== null && e.repeat !== 'year');
if (oddEventRepeat.length) add('warn', `${oddEventRepeat.length} event(s) with a repeat the app ignores`,
  'Only "year" is supported for calendar events. These behave as one-off events.',
  oddEventRepeat.map(e => `"${e.text}" (repeat = ${JSON.stringify(e.repeat)})`));

// The marker should have been stripped on save. Leftovers mean a creation path missed it — and the
// literal text also ends up in the phone calendar feed.
const leakedMarker = [
  ...events.filter(e => e && /!\s*(?:yearly|annual(?:ly)?|y)\b/i.test(String(e.text || ''))).map(e => `event "${e.text}"`),
  ...trips.filter(t => /!\s*(?:yearly|annual(?:ly)?|y)\b/i.test(String(t.label || ''))).map(t => `trip "${t.label}"`),
];
if (leakedMarker.length) add('warn', `${leakedMarker.length} item(s) still contain a literal "!yearly" marker`,
  'The marker should be stripped when saved. It also shows up like this in the phone calendar feed. Re-save the item to clean it.',
  leakedMarker);

// ═══ SUMMARY TOTALS, for a sanity eyeball ════════════════════════════════════
const byYear = {};
for (const e of expenses) {
  if (typeof e.date !== 'string') continue;
  const y = e.date.slice(0, 4);
  byYear[y] = byYear[y] || { spend: 0, income: 0, n: 0 };
  byYear[y].n++;
  if (e.category === 'Income') byYear[y].income += round2(e.amount);
  else if (!EXCL.has(e.category)) byYear[y].spend += round2(e.amount);
}

// ═══ REPORT ══════════════════════════════════════════════════════════════════
const ICON = { problem: '✗', warn: '!', note: 'ℹ' };
const ORDER = ['problem', 'warn', 'note'];
console.log('');
console.log('  ── Totals by year ' + '─'.repeat(42));
for (const y of Object.keys(byYear).sort()) {
  const v = byYear[y];
  console.log(`  ${y}: ${String(v.n).padStart(4)} rows · spent ${money(v.spend).padStart(12)} · income ${money(v.income).padStart(12)}`);
}

const counts = { problem: 0, warn: 0, note: 0 };
for (const f of findings) counts[f.level]++;
console.log('');
console.log('  ── Findings ' + '─'.repeat(48));
if (!findings.length) {
  console.log('  Nothing to flag. Your data looks clean.');
} else {
  for (const level of ORDER) {
    for (const f of findings.filter(x => x.level === level)) {
      console.log('');
      console.log(`  ${ICON[level]} ${f.title}`);
      console.log(`      ${f.detail}`);
      const show = f.rows.slice(0, 8);
      for (const r of show) console.log(`        · ${r}`);
      if (f.rows.length > show.length) console.log(`        · …and ${f.rows.length - show.length} more`);
    }
  }
}
console.log('');
console.log(`  ${counts.problem} problem(s), ${counts.warn} warning(s), ${counts.note} note(s)`);
console.log('');
process.exit(0);
