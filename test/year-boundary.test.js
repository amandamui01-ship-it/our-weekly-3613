/**
 * Year-boundary tests: boots the real page under a FAKE clock at several dates around New Year.
 *
 * Every other suite runs on the real clock (or one pinned date), so nothing exercised "what does
 * the app do in January?" — and a health check in Nov 2026 found six bugs that only show up then:
 * the Budget tab opening on last January, holiday trips filed a year late, edited trips jumping a
 * year, a cross-year trip missing from the new year's list, a recurring-load dropdown that ran
 * out in 2028, and bulk-paste accepting 13/45.
 *
 * Run:  node test/year-boundary.test.js        (OW_HTML=<path> to point it at another copy)
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML_PATH = process.env.OW_HTML || path.join(__dirname, '..', 'index.html');
const RAW = fs.readFileSync(HTML_PATH, 'utf8');
const HTML = RAW.replace(/<script[^>]*\bsrc=["'][^"']*["'][^>]*>\s*<\/script>/gi, '');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
  if (cond) pass++;
  else { fail++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${detail}` : ''}`); }
};

function boot(fakeNow, { localStorage: ls = {} } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  const listeners = new Map();
  const snap = (id, data) => ({ exists: data !== undefined, id, data: () => data, metadata: { hasPendingWrites: false } });
  const docStub = id => ({
    onSnapshot(n) { listeners.set(id, typeof n === 'function' ? n : n && n.next); return () => {}; },
    set() { return Promise.resolve(); }, update() { return Promise.resolve(); },
    get() { return Promise.resolve(snap(id, undefined)); },
  });
  const fb = {
    initializeApp: () => ({}), apps: [],
    auth: () => ({ onAuthStateChanged: () => {}, signOut: () => Promise.resolve(), currentUser: null }),
    firestore: () => ({ collection: () => ({ doc: docStub }),
      runTransaction: fn => Promise.resolve(fn({ get: () => Promise.resolve(snap('tx', { items: [] })), set: () => {}, update: () => {} })),
      enablePersistence: () => Promise.resolve(), settings: () => {} }),
  };
  fb.firestore.FieldValue = { arrayUnion: (...v) => ({ v }), arrayRemove: (...v) => ({ v }), delete: () => ({ __delete: true }) };

  const dom = new JSDOM(HTML, { runScripts: 'outside-only', pretendToBeVisual: true,
    url: 'https://amandamui01-ship-it.github.io/our-weekly-3613/', virtualConsole: vc });
  const w = dom.window;
  for (const [k, v] of Object.entries(ls)) w.localStorage.setItem(k, v);
  const T = new Date(fakeNow).getTime();
  const R = w.Date;
  w.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(T); } static now() { return T; } };
  w.firebase = fb;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLInputElement.prototype.showPicker = function () {};
  if (!w.crypto) w.crypto = {};
  let n = 0; w.crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  w.navigator.vibrate = () => {};
  const bodies = []; const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(HTML)) !== null) bodies.push(m[1]);
  w.eval(bodies.join('\n;\n') + '\n;window.__ev = function (__s) { return eval(__s); };');
  const ev = s => w.__ev(s);
  ev('initFirestore()');
  const push = (doc, data) => { const cb = listeners.get(doc); if (cb) cb(snap(doc, data)); };
  return { ev, push, errors, close: () => w.close() };
}

const psd = (app, text, anchor) =>
  app.ev(`parseSortDate(${JSON.stringify(text)}${anchor ? `, ${JSON.stringify(anchor)}` : ''})`);

// ── Late November 2026 (today, when these were found) ───────────────────────
{
  const app = boot('2026-11-25T10:00:00');
  const cases = [
    ['Dec 28 - Jan 3, 2027', null, '2026-12-28', 'year typed at the END of a cross-year range belongs to the end'],
    ['Dec 28 – Dec 31, 2026', null, '2026-12-28', 'a range ending Dec 31 is not mistaken for cross-year (exclusive end is Jan 1)'],
    ['Dec 30 – Jan 2', null, '2026-12-30', 'yearless cross-year trip starts this December'],
    ['Jan 5', null, '2027-01-05', 'yearless January means the coming one'],
    ['Feb 14, 2027', null, '2027-02-14', 'explicit start year honored'],
    ['Jun 5, 2026 – Jun 8', null, '2026-06-05', 'explicit past start year honored, not shifted'],
    ['Oct 2', null, '2026-10-02', 'within the 2-month look-back stays this year'],
    ['Aug 21–23', '2026-08-21', '2026-08-21', 'editing a past trip keeps its year (anchored to its sortDate)'],
    ['Mar 6', '2027-03-05', '2027-03-06', 'editing a future trip keeps its year'],
    ['not a date', null, null, 'junk still returns null'],
  ];
  for (const [text, anchor, want, name] of cases) {
    const got = psd(app, text, anchor);
    ok(got === want, `[Nov 25] ${name}`, `${text}${anchor ? ` @${anchor}` : ''} → ${got}, want ${want}`);
  }

  // Drive the real edit entry point, not just the parser.
  app.push('trips', { items: [{ id: 'aug', dates: 'Aug 21–23', sortDate: '2026-08-21', label: 'Camping' }] });
  app.ev("_currentTripId = 'aug'; saveTripField('dates', 'Aug 22–24')");
  const after = app.ev("trips.find(t => t.id === 'aug').sortDate");
  ok(after === '2026-08-22', '[Nov 25] fixing a typo on an August trip in November does not move it to next year', after);
  ok(app.errors.length === 0, '[Nov 25] no runtime errors', app.errors.slice(0, 3).join(' | '));
  app.close();
}

// ── Early January 2027 ──────────────────────────────────────────────────────
{
  const app = boot('2027-01-03T10:00:00');
  for (const [text, want, name] of [
    ['Dec 23–27', '2026-12-23', 'the December that just happened'],
    ['Dec 30 – Jan 2', '2026-12-30', 'a trip still in progress over New Year'],
    ['Nov 20', '2026-11-20', 'two months back is still last year'],
    ['Jan 10', '2027-01-10', 'this January'],
    ['Mar 1', '2027-03-01', 'upcoming spring'],
  ]) {
    const got = psd(app, text);
    ok(got === want, `[Jan 3] ${name}`, `${text} → ${got}, want ${want}`);
  }

  // Budget must open on the CURRENT year/month, not a hardcoded 2026.
  app.push('expenses', { items: [
    { id: '1', date: '2026-01-10', month: 'January',  person: 'Amanda', category: 'Groceries', description: 'jan26', amount: 100, shared: true, splitPct: 50 },
    { id: '2', date: '2026-12-10', month: 'December', person: 'Amanda', category: 'Groceries', description: 'dec26', amount: 200, shared: true, splitPct: 56 },
  ] });
  app.ev('renderBudget()');
  const yr = app.ev("document.getElementById('b-filter-year').value");
  ok(yr === '2027', '[Jan 3] Budget opens on 2027, not 2026', `year select = ${yr}`);
  const opts = app.ev("[...document.getElementById('b-filter-year').options].map(o => o.value).join(',')");
  ok(opts.includes('2026'), '[Jan 3] last year is still selectable', opts);

  // Bulk paste: real dates only, year guessed sensibly.
  for (const [inp, want] of [['13/45', null], ['2/30', null], ['0/0', null], ['2026-13-01', null], ['12/20', '2026-12-20'], ['1/2', '2027-01-02'], ['2/29/2028', '2028-02-29']]) {
    const got = app.ev(`_parseBulkDate(${JSON.stringify(inp)})`);
    ok(got === want, `[Jan 3] bulk date ${inp}`, `→ ${got}, want ${want}`);
  }

  ok(app.errors.length === 0, '[Jan 3] no runtime errors', app.errors.slice(0, 3).join(' | '));
  app.close();
}

// ── New Year's Day 2027: a trip in progress across the boundary ─────────────
{
  const app = boot('2027-01-01T10:00:00');
  // A trip crossing New Year shows under the new year too.
  app.push('trips', { items: [{ id: 'nye', dates: 'Dec 30 – Jan 2', sortDate: '2026-12-30', label: 'NYE Cabin' },
                               { id: 'spr', dates: 'Mar 1–3', sortDate: '2027-03-01', label: 'Spring Trip' }] });
  app.ev('_setDatesYear(2027)');
  const grid27 = app.ev("document.getElementById('trip-grid').textContent");
  ok(grid27.includes('NYE Cabin'), '[Jan 1] a Dec 30 – Jan 2 trip is listed under 2027', grid27.slice(0, 160));
  ok(grid27.indexOf('NYE Cabin') < grid27.indexOf('Spring Trip'), '[Jan 1] an in-progress trip is listed as upcoming, not under Past Adventures', grid27.replace(/\s+/g, ' ').slice(0, 160));
  app.ev('_setDatesYear(2026)');
  ok(app.ev("document.getElementById('trip-grid').textContent").includes('NYE Cabin'), '[Jan 1] …and still under 2026');
  ok(app.errors.length === 0, '[Jan 1] no runtime errors', app.errors.slice(0, 3).join(' | '));
  app.close();
}

// ── January 2028: hardcoded year lists run out ──────────────────────────────
{
  const app = boot('2028-01-05T10:00:00', { localStorage: { 'ow-income-min': '0' } });
  app.ev('openBudgetSettings()');
  const ly = app.ev("document.getElementById('rec-load-year').value");
  ok(ly === '2028', '[Jan 2028] recurring load-year defaults to the current year', `value = "${ly}"`);
  ok(app.ev('INCOME_LOADED_MIN') === 0, 'an income threshold of 0 survives a reload', String(app.ev('INCOME_LOADED_MIN')));
  // Not a year-boundary bug, but this is the suite that boots a clean page: every shared Firestore
  // doc must be in the backup. datedEvents (every calendar event) was silently missing.
  const docs = [...new Set([...RAW.matchAll(/collection\('state'\)\.doc\('([A-Za-z]+)'\)/g)].map(m => m[1]))];
  const EXPORT_KEY = { bucket: 'bucketList', logistics: 'logisticsList', countdowns: 'customCountdowns', entries: 'entries', weekplan: 'weekPlan', recurring: 'recurringItems' };
  const _ex = RAW.indexOf('function exportData');
  const exportSrc = RAW.slice(_ex, RAW.indexOf('JSON.stringify(payload', _ex));
  const missing = docs.filter(d => d !== 'settings' /* holds the calendar feed's secret token */ &&
    !new RegExp('\\b' + (EXPORT_KEY[d] || d) + '\\b').test(exportSrc));
  ok(missing.length === 0, 'backup export includes every shared Firestore doc', `missing: ${missing.join(', ')}`);
  ok(app.errors.length === 0, '[Jan 2028] no runtime errors', app.errors.slice(0, 3).join(' | '));
  app.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
