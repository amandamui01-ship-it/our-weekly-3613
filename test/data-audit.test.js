/**
 * Self-test for test/data-audit.js.
 *
 * The auditor is only useful if it actually detects problems, so it's run against a fixture with
 * known faults planted in it (test/fixtures/dirty-export.json) and against a clean one. Without
 * this, a broken detector would silently report "your data looks clean" forever — the worst
 * possible failure mode for a health check.
 *
 * Run:  node test/data-audit.test.js
 */
const { spawnSync } = require('child_process');
const path = require('path');

const AUDIT = path.join(__dirname, 'data-audit.js');
const run = fixture => spawnSync(process.execPath, [AUDIT, path.join(__dirname, 'fixtures', fixture)],
  { encoding: 'utf8' });

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) pass++; else { fail++; failures.push({ name, detail }); }
}

// ── Dirty fixture: every planted fault must be reported ─────────────────────
const dirty = run('dirty-export.json');
ok(dirty.status === 0, 'auditor exits cleanly on the dirty fixture', dirty.stderr);
const out = dirty.stdout;

const MUST_DETECT = [
  ['missing or malformed date',           'a row with no date'],
  ['amount is not a number',              'a string amount'],
  ['sub-cent precision',                  'a sub-cent amount'],
  ['not attributed to Amanda or Aidan',   'an unattributable row'],
  ['month label disagrees',               'a stale month label'],
  ['used by more than one row',           'a duplicate expense id'],
  ['identical transactions',              'likely double-entry'],
  ['loaded more than once into the same month', 'a double-charged recurring month'],
  ['invalid split percentage',            'an out-of-range splitPct'],
  ['income row(s) marked shared',         'shared income'],
  ['marked shared',                       'shared savings transfers'],
  ['dated outside',                       'an implausible year'],
  ['unrecognized categor',                'an unknown category'],
  ['activity logged after they were settled', 'post-settlement drift'],
  ['referencing a deleted card',          'an orphaned gift-card spend'],
  ['more spent than the card held',       'an overdrawn gift card'],
  ['unreadable expiration date',          'a malformed gift-card expiry'],
  ['expired gift card(s) still showing a balance', 'money stranded on a lapsed card'],
  ['trip(s) with no parsed date',         'a text-only trip date'],
  ['trip id(s) used more than once',      'a duplicate trip id'],
  ['unparseable due date',                'a bad to-do due date'],
  ['section that no longer exists',       'an orphaned to-do'],
];
for (const [needle, what] of MUST_DETECT) {
  ok(out.includes(needle), `detects ${what}`, `no line matching "${needle}"`);
}

// The post-settlement drift figure must be computed, not just flagged.
ok(/2026-07: \$30\.00 was paid, \$30\.00 added since/.test(out),
  'quantifies post-settlement drift correctly', out.split('\n').filter(l => l.includes('2026-07')).join(' '));
// The expiry checks must be specific, not just "any card with a date". A future expiry is normal,
// and an expired card with nothing left on it is a non-event — flagging either would train the eye
// to ignore the whole section.
ok(!/Fine Coupon/.test(out), 'a future expiration date is not flagged',
  out.split('\n').filter(l => l.includes('Coupon')).join(' | '));
ok(!/Lapsed But Used/.test(out), 'an expired card with a zero balance is not flagged (no money at stake)',
  out.split('\n').filter(l => l.includes('Lapsed')).join(' | '));
ok(/Lapsed Coupon: \$20\.00 left/.test(out), 'the stranded balance is quantified',
  out.split('\n').filter(l => l.includes('Lapsed Coupon')).join(' | '));
// Totals must exclude income from spending.
ok(/2026:\s+14 rows · spent\s+\$4,551\.75 · income\s+\$400\.00/.test(out),
  'year totals separate spending from income',
  out.split('\n').filter(l => l.trim().startsWith('2026:')).join(' '));

// ── Legacy settled months must NOT be reported as unpaid money ──────────────
// Real-world case (found in Amanda's actual export, 2026-08-18): seven months settled under the
// OLD settlement code, which summed UNROUNDED halves. The current code rounds each row's share to
// the cent, so recomputing those months differs by 3-6 cents. Reporting that as "money that never
// got paid" is a false alarm — worse than useless in a health check. It must land as a note.
const legacy = run('legacy-settled-export.json');
ok(legacy.status === 0, 'auditor exits cleanly on the legacy-settlement fixture', legacy.stderr);
ok(/0 problem\(s\)/.test(legacy.stdout),
  'penny-level recomputation of a legacy settled month is NOT reported as a problem',
  legacy.stdout.split('\n').filter(l => l.includes('problem(s)')).join(' '));
ok(/recompute a few cents differently/.test(legacy.stdout),
  'the recomputation difference is still surfaced, as a note',
  legacy.stdout.slice(-500));
ok(/NOT money owed/.test(legacy.stdout), 'the note says plainly that nothing is owed');
// But a real post-settlement addition must still be caught. The dirty fixture uses the NEW signed
// record shape, where the comparison is exact, and it IS reported as a problem.
ok(/activity logged after they were settled/.test(out),
  'genuine post-settlement activity is still reported as a problem (signed records are exact)');

// ── Recurrence and yearly-event schema (added with those features) ──────────
ok(/unreadable repeat rule/.test(out) && /Change furnace filter/.test(out),
  'a corrupt to-do repeat rule is caught — it looks recurring but silently never returns');
ok(/recurring to-do\(s\) with no deadline/.test(out) && /Rotate tires/.test(out),
  'a repeat with no due date to count from is caught');
ok(/unreadable "last done" date/.test(out) && /Water plants/.test(out),
  'a malformed lastDone is caught');
ok(/yearly event\(s\) with an unusable date/.test(out) && /Broken yearly/.test(out),
  'a yearly event with a bad anchor date is caught — it renders on no day in any year');
ok(/repeat the app ignores/.test(out) && /Weekly standup/.test(out),
  'an event repeat other than "year" is caught');
ok(/literal "!yearly" marker/.test(out) && /Cabin !yearly/.test(out),
  'a marker left un-stripped in a trip label is caught (it reaches the phone feed too)');

// Negative controls: the valid records in the same fixture must NOT be flagged.
ok(!/Valid recurring/.test(out),
  'a well-formed recurring to-do is not flagged', out.match(/.*Valid recurring.*/)?.[0]);
ok(!/"Anniversary"/.test(out),
  'a well-formed yearly event is not flagged', out.match(/.*Anniversary.*/)?.[0]);
ok(!/Plain event/.test(out),
  'a plain one-off event is not flagged', out.match(/.*Plain event.*/)?.[0]);

// ── Clean fixture: must NOT invent problems ─────────────────────────────────
const clean = run('clean-export.json');
ok(clean.status === 0, 'auditor exits cleanly on the clean fixture', clean.stderr);
ok(/0 problem\(s\)/.test(clean.stdout), 'reports zero problems on clean data',
  clean.stdout.split('\n').filter(l => l.includes('problem(s)')).join(' '));
ok(/Nothing to flag/.test(clean.stdout), 'says so plainly when data is clean',
  clean.stdout.slice(-400));

// ── Argument handling ───────────────────────────────────────────────────────
const noArg = spawnSync(process.execPath, [AUDIT], { encoding: 'utf8' });
ok(noArg.status === 1 && /Usage/.test(noArg.stdout), 'prints usage when given no file');
const missing = spawnSync(process.execPath, [AUDIT, 'nope.json'], { encoding: 'utf8' });
ok(missing.status === 1 && /No such file/.test(missing.stderr), 'errors clearly on a missing file');

console.log('');
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('');
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.detail || ''}`);
  console.log('');
  process.exit(1);
}
console.log('  Data auditor detects every planted fault and stays quiet on clean data.\n');
