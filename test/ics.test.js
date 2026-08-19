/**
 * Calendar feed / trip-date tests.
 *
 * The trip end-date parser is implemented TWICE — once in index.html (drives the calendar grid and
 * the manual .ics download) and once in functions/index.js (drives the live subscription feed your
 * phone reads). Both files carry a "keep this in sync" comment, which is exactly the kind of
 * promise that quietly stops being true. This extracts BOTH and asserts they agree on every case,
 * then checks the date semantics themselves.
 *
 * Run:  node test/ics.test.js
 */
const fs = require('fs');
const path = require('path');

const CLIENT_SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');

function extractFn(src, name, label) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) { console.error(`FATAL: ${name} not found in ${label}`); process.exit(2); }
  // Walk braces to find the end of the function body.
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) { console.error(`FATAL: could not find end of ${name} in ${label}`); process.exit(2); }
  return src.slice(start, end);
}

const clientFn = new Function(`${extractFn(CLIENT_SRC, 'parseICSEndDate', 'index.html')}; return parseICSEndDate;`)();
const serverFn = new Function(`${extractFn(SERVER_SRC, 'parseICSEndDate', 'functions/index.js')}; return parseICSEndDate;`)();

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) pass++; else { fail++; failures.push({ name, detail }); }
}

// Every case runs through BOTH implementations. `expected` is the ICS DTEND, which for an all-day
// event is EXCLUSIVE — the day AFTER the last day of the trip.
const CASES = [
  // [dates text,            sortDate,      expected DTEND, why]
  ['',                       '2026-08-21', '20260822', 'no text → single day, DTEND is the next day'],
  [null,                     '2026-08-21', '20260822', 'null text → single day'],
  ['Aug 21',                 '2026-08-21', '20260822', 'single explicit day'],
  ['Aug 21–23',              '2026-08-21', '20260824', 'en-dash range, DTEND day after the 23rd'],
  ['Aug 21-23',              '2026-08-21', '20260824', 'hyphen range'],
  ['Aug 21 — 23',            '2026-08-21', '20260824', 'em-dash with spaces'],
  ['Oct 24 – Nov 8',         '2026-10-24', '20261109', 'range crossing a month'],
  ['Jul 30 – Aug 2',         '2026-07-30', '20260803', 'range crossing a month, short span'],
  ['Dec 30 – Jan 2',         '2026-12-30', '20270103', 'range crossing the YEAR boundary'],
  ['4/28-5/2',               '2026-04-28', '20260503', 'numeric range'],
  ['12/30-1/2',              '2026-12-30', '20270103', 'numeric range crossing the year'],
  // Guards against historical misparses:
  ['May 28 - 9 PM',          '2026-05-28', '20260529', 'a TIME must not be read as a range end day'],
  ['May 28 - 9:00 PM',       '2026-05-28', '20260529', 'a colon time must not be read as a range'],
  ['Jun-Jul 2026',           '2026-06-01', '20260602', 'a 4-digit year must not be read as an end day'],
  ['Jun 5-3',                '2026-06-05', '20260606', 'reversed range → single day, not negative'],
  ['5/30-5/28',              '2026-05-30', '20260531', 'reversed numeric range → single day'],
  ['Feb 27 – Mar 1',         '2026-02-27', '20260302', 'range across the end of February'],
  ['Feb 27 – Mar 1',         '2028-02-27', '20280302', 'same range in a LEAP year'],
  ['Mar 7 – 9',              '2026-03-07', '20260310', 'range spanning the US DST spring-forward'],
  ['Nov 1 – 2',              '2026-11-01', '20261103', 'range spanning the US DST fall-back'],
];

for (const [dates, sortDate, expected, why] of CASES) {
  const c = clientFn(dates, sortDate);
  const s = serverFn(dates, sortDate);
  const label = `${JSON.stringify(dates)} @ ${sortDate}`;
  ok(c === expected, `client: ${label} → ${expected} (${why})`, `got ${c}`);
  ok(s === expected, `server: ${label} → ${expected} (${why})`, `got ${s}`);
  ok(c === s, `PARITY: client and server agree on ${label}`, `client=${c} server=${s}`);
}

// No sortDate → empty (nothing to anchor to).
ok(clientFn('Aug 21–23', '') === '', 'client: no sortDate → empty');
ok(serverFn('Aug 21–23', '') === '', 'server: no sortDate → empty');

// ── The all-day exclusivity property, stated directly ───────────────────────
// A one-day trip must span exactly one day: DTEND − DTSTART === 1 day. If DTEND were inclusive,
// every trip would show a day short on the phone (or a day long).
const asDate = compact => new Date(Date.UTC(+compact.slice(0, 4), +compact.slice(4, 6) - 1, +compact.slice(6, 8)));
const spanDays = (dates, sortDate) => {
  const end = asDate(clientFn(dates, sortDate));
  const start = new Date(sortDate + 'T00:00:00Z');
  return Math.round((end - start) / 864e5);
};
ok(spanDays('Aug 21', '2026-08-21') === 1, 'a single-day trip spans exactly 1 day', String(spanDays('Aug 21', '2026-08-21')));
ok(spanDays('Aug 21–23', '2026-08-21') === 3, 'Aug 21–23 spans 3 days', String(spanDays('Aug 21–23', '2026-08-21')));
ok(spanDays('Oct 24 – Nov 8', '2026-10-24') === 16, 'Oct 24 – Nov 8 spans 16 days', String(spanDays('Oct 24 – Nov 8', '2026-10-24')));
// DST must not steal or add a day: both of these are plain 3-day spans in wall-clock terms.
ok(spanDays('Mar 7 – 9', '2026-03-07') === 3, 'spring-forward weekend still spans 3 days', String(spanDays('Mar 7 – 9', '2026-03-07')));
ok(spanDays('Nov 1 – 2', '2026-11-01') === 2, 'fall-back weekend still spans 2 days', String(spanDays('Nov 1 – 2', '2026-11-01')));

// ── The feed itself ─────────────────────────────────────────────────────────
// Structural checks on functions/index.js. These are deliberately about the things that break
// phone subscriptions specifically.
ok(/BEGIN:VCALENDAR/.test(SERVER_SRC) && /END:VCALENDAR/.test(SERVER_SRC), 'feed emits a VCALENDAR wrapper');
ok(/VERSION:2\.0/.test(SERVER_SRC), 'feed declares VERSION:2.0');
ok(/PRODID/.test(SERVER_SRC), 'feed declares a PRODID (some clients reject feeds without one)');
// All-day events must use VALUE=DATE; timed events must be TZID-anchored, not floating or naive UTC.
ok(/DTSTART;VALUE=DATE:/.test(SERVER_SRC), 'all-day events use VALUE=DATE');
ok(/DTEND;VALUE=DATE:/.test(SERVER_SRC), 'all-day events set an explicit DTEND');
ok(/DTSTART;TZID=America\/Chicago:/.test(SERVER_SRC), 'timed events are anchored to a named timezone');
ok(/BEGIN:VTIMEZONE/.test(SERVER_SRC), 'feed ships a VTIMEZONE block so DST is resolved by the client');
ok(/DAYLIGHT/.test(SERVER_SRC) && /STANDARD/.test(SERVER_SRC), 'VTIMEZONE defines both DST and standard offsets');
ok(/UID/.test(SERVER_SRC), 'events carry a UID (without one, phones duplicate events on refresh)');
ok(/DTSTAMP/.test(SERVER_SRC), 'events carry a DTSTAMP');
// A stable UID is what stops your phone from duplicating every trip on each refresh.
ok(/UID:[^\n]*\$\{[^}]*id/.test(SERVER_SRC) || /UID.*trip/i.test(SERVER_SRC),
  'UID is derived from the trip id (stable across refreshes), not random');
// Access control on the feed.
ok(/icsToken/.test(SERVER_SRC), 'feed is gated by a token');
// Line folding: RFC 5545 caps lines at 75 octets. Long trip names must be folded or clients choke.
const foldsLines = /\.slice\(0,\s*7[0-9]\)|fold|75/.test(SERVER_SRC);
ok(foldsLines, 'feed folds or truncates long lines (RFC 5545 75-octet limit)',
  'no line-folding logic found — a very long trip name or note could produce an over-long line ' +
  'that some calendar clients reject');
// Escaping: commas, semicolons and newlines are special in ICS text values.
ok(/replace\([^)]*[,;\\]/.test(SERVER_SRC),
  'feed escapes ICS-special characters in text values',
  'a trip label containing a comma or semicolon would otherwise corrupt the event');

// ── Yearly events: the app calendar and the phone feed must agree ────────────
// Yearly events (birthdays, anniversaries) exist as ONE stored row. The in-app calendar decides
// which days it lands on via _yearlyHitsDate; the phone decides via the RRULE in the feed. Those
// are two independent implementations of the same rule — the same trap parseICSEndDate fell into.
//
// The interesting case is Feb 29. RFC 5545 §3.3.10 DISCARDS invalid recurrence dates rather than
// shifting them, so a plain FREQ=YEARLY on Feb 29 shows up only in leap years. The app folds to
// Feb 28 instead, so the feed has to say BYMONTH=2;BYMONTHDAY=-1 (last day of February) to mean
// the same thing. If someone "simplifies" that away, a leap-day anniversary silently vanishes
// from the phone for three years at a stretch while still showing in the app.
// Structural checks below run against COMMENT-STRIPPED source. Learned the hard way: the
// BYMONTHDAY=-1 assertion originally passed against the explanatory comment above the code, so
// deleting the actual special case went undetected. A test that a comment can satisfy is not a test.
const SERVER_CODE = SERVER_SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')          // block comments
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');

ok(/RRULE:FREQ=YEARLY/.test(SERVER_CODE), 'feed emits an RRULE for yearly events');
ok(/e\.repeat === 'year'/.test(SERVER_CODE), 'the RRULE is gated on the stored repeat flag');
ok(/BYMONTHDAY=-1/.test(SERVER_CODE),
  'Feb 29 yearly events use BYMONTHDAY=-1 so they still appear in common years',
  'a plain FREQ=YEARLY would skip non-leap years entirely (RFC 5545 §3.3.10)');
ok(/0229/.test(SERVER_CODE), 'the Feb 29 special case is detected from the actual date');
// And the reference expansion below must reflect what the source ACTUALLY emits, not what this test
// assumes it emits — otherwise the parity check silently validates the wrong contract.
const serverUsesLastDayOfFeb = /isFeb29\s*\?\s*'RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1'/.test(SERVER_CODE);
ok(serverUsesLastDayOfFeb,
  'the Feb 29 RRULE is emitted from the real conditional (not just mentioned in a comment)',
  'expected the isFeb29 ternary to select BYMONTH=2;BYMONTHDAY=-1');

const clientYearly = new Function(
  `${extractFn(CLIENT_SRC, '_yearlyHitsDate', 'index.html')}
   const _isDateStr = s => typeof s === 'string' && /^\\d{4}-\\d{2}-\\d{2}\$/.test(s);
   return _yearlyHitsDate;`)();

// Reference expansion of what the FEED tells a calendar client, per RFC 5545. Written from the
// spec rather than copied from the app, so agreement means something.
function feedSaysOccursOn(startIso, iso) {
  const [sy, sm, sd] = startIso.split('-').map(Number);
  const [ty, tm, td] = iso.split('-').map(Number);
  if (ty < sy) return false;                       // DTSTART is the first occurrence
  const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (sm === 2 && sd === 29) {
    // Which rule the feed actually sends decides what the phone shows:
    //   BYMONTH=2;BYMONTHDAY=-1 → last day of February every year (Feb 29 or Feb 28)
    //   plain FREQ=YEARLY       → Feb 29 only, so common years are skipped entirely
    return serverUsesLastDayOfFeb
      ? tm === 2 && td === (isLeap(ty) ? 29 : 28)
      : tm === 2 && td === 29;
  }
  return tm === sm && td === sd;                   // plain FREQ=YEARLY repeats DTSTART's month/day
}

const YEARLY_CASES = [];
for (const start of ['2026-03-14', '2028-02-29', '2026-12-31', '2026-01-01', '2026-06-30']) {
  for (let y = 2025; y <= 2035; y++) {
    for (const [m, d] of [[2,28],[2,29],[3,1],[3,14],[12,31],[1,1],[6,30],[3,13],[3,15]]) {
      if (m === 2 && d === 29 && !((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) continue;
      YEARLY_CASES.push([start, `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`]);
    }
  }
}
let yearlyMismatches = [];
for (const [start, iso] of YEARLY_CASES) {
  const inApp = clientYearly({ date: start, repeat: 'year' }, iso);
  const onPhone = feedSaysOccursOn(start, iso);
  if (inApp !== onPhone) yearlyMismatches.push(`start=${start} on ${iso}: app=${inApp} phone=${onPhone}`);
}
ok(yearlyMismatches.length === 0,
  `app calendar and phone feed agree on all ${YEARLY_CASES.length} yearly-event dates`,
  yearlyMismatches.slice(0, 6).join(' | '));
// Guard the guard: the comparison must be capable of disagreeing.
ok(clientYearly({date: '2028-02-29', repeat: 'year'}, '2029-02-28') === true
   && feedSaysOccursOn('2028-02-29', '2029-02-28') === true,
  'both sides really do place a Feb 29 event on Feb 28 in a common year');
ok(clientYearly({date: '2026-03-14', repeat: 'year'}, '2025-03-14') === false,
  'a yearly event does not appear before its first year');

console.log('');
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('');
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.detail || ''}`);
  console.log('');
  process.exit(1);
}
console.log('  Calendar dates agree between client and server.\n');
