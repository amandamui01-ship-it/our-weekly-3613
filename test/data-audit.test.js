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
// Totals must exclude income from spending.
ok(/2026:\s+14 rows · spent\s+\$4,551\.75 · income\s+\$400\.00/.test(out),
  'year totals separate spending from income',
  out.split('\n').filter(l => l.trim().startsWith('2026:')).join(' '));

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
