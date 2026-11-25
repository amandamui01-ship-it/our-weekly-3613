/**
 * Chores: rule math, the This-week grid, the Schedule view, the editor, and the template.
 * Clock pinned to Wed 2026-11-25 (the day this was built) so the expected dates are concrete.
 * Persistence and two-person races live in concurrency.test.js.
 *
 * Run:  node test/chores.test.js
 */
const { boot, makeOk } = require('./_boot');
const T = makeOk(); const ok = T.ok;

const app = boot('2026-11-25T10:00:00');
const ev = app.ev;
const j = v => JSON.stringify(v);
const q = sel => ev(`(document.querySelector(${j(sel)}) || {}).textContent || ''`).replace(/\s+/g, ' ').trim();
const sec = i => ev(`(document.querySelectorAll('#chores-card .ch-sec')[${i}] || {}).textContent || ''`).replace(/\s+/g, ' ').trim();
const n = sel => ev(`document.querySelectorAll(${j(sel)}).length`);

// ── Rule math ───────────────────────────────────────────────────────────────
const occ = (on, y, m0) => ev(`_chMonthOcc(${y}, ${m0}, ${j(on)})`);
ok(occ({ nth: 1, weekday: 'sat' }, 2026, 10) === '2026-11-07', '1st Saturday of Nov 2026 is the 7th');
ok(occ({ nth: 2, weekday: 'weekend' }, 2026, 10) === '2026-11-14', '2nd weekend of Nov 2026 starts Sat the 14th');
ok(occ({ nth: -1, weekday: 'fri' }, 2026, 10) === '2026-11-27', 'last Friday of Nov 2026 is the 27th');
ok(occ({ day: 31 }, 2026, 10) === '2026-11-30', 'the 31st clamps to Nov 30');
ok(occ({ nth: 5, weekday: 'sat' }, 2026, 10) === null, 'a 5th Saturday that does not exist is null, not December');
ok(occ({ nth: 1, weekday: 'weekend' }, 2027, 0) === '2027-01-02', '1st weekend of Jan 2027 starts Sat Jan 2 (Jan 1 is a Friday)');
ok(j(ev(`choreOccurrences({freq:'weekly', days:['wed','fri']}, '2026-11-23', '2026-11-29')`)) === j(['2026-11-25', '2026-11-27']),
  'weekly Wed+Fri lands on the 25th and 27th this week');
const quarterly = { freq: 'monthly', months: [1, 4, 7, 10], on: { nth: 1, weekday: 'weekend' } };
ok(j(ev(`choreOccurrences(${j(quarterly)}, '2026-11-01', '2027-12-31')`)) === j(['2027-01-02', '2027-04-03', '2027-07-03', '2027-10-02']),
  'every 3 months (Jan/Apr/Jul/Oct), 1st weekend: the next four dates',
  j(ev(`choreOccurrences(${j(quarterly)}, '2026-11-01', '2027-12-31')`)));
ok(ev(`choreWhenLabel({freq:'monthly', on:{nth:2, weekday:'weekend'}})`) === '2nd weekend', 'label: 2nd weekend');
ok(ev(`choreWhenLabel({freq:'monthly', on:{day:25, approx:true}})`) === '~25th', 'label: ~25th');
ok(ev(`choreWhenLabel({freq:'weekly', days:['fri','wed']})`) === 'Wed, Fri', 'label: weekly days in week order');
ok(ev(`choreMonthsLabel([10, 1, 7, 4])`) === 'Every 3 months (Jan, Apr, Jul, Oct)', 'group: every 3 months');
ok(ev(`choreMonthsLabel([3])`) === 'Yearly (Mar)', 'group: yearly');
ok(ev(`choreMonthsLabel(undefined)`) === 'Monthly', 'group: monthly');
ok(ev(`_chOccEnd({freq:'monthly', on:{nth:2, weekday:'weekend'}}, '2026-11-14')`) === '2026-11-15', 'a weekend chore is on time through Sunday');

// ── Empty state + template ──────────────────────────────────────────────────
ev("showPage('todos'); renderTodos()");
ok(/Start with our plan/.test(q('#chores-card')), 'with no chores the card offers to start with our plan');
ev('loadChoreTemplate()');
const count = ev('chores.length');
ok(count === 20, 'the plan loads all 20 chores', String(count));
ev('loadChoreTemplate()');
ok(ev('chores.length') === 20, 'loading the plan twice does not duplicate it');
const id = (text, who) => ev(`(chores.find(c => c.text === ${j(text)} && c.who === ${j(who)}) || {}).id`);

// ── This week ───────────────────────────────────────────────────────────────
ev("setChoresWho('all'); setChoresTab('week')");
const row = i => `#chores-card .ch-week .ch-row:nth-child(${i + 2})`;   // +1 header, nth-child is 1-based
ok(/Mon/.test(q(row(0))) && /Nov 23/.test(q(row(0))), 'the week starts Monday Nov 23', q(row(0)));
ok(ev(`document.querySelector(${j(row(2))}).classList.contains('today')`), 'Wednesday is highlighted as today');
ok(/Cat litter/.test(q(row(2))) && /Clean bathroom/.test(q(row(2))), "Wednesday shows Amanda's cat litter and Aidan's bathroom", q(row(2)));
ok(/DoorDash/.test(q(row(2))) && /~25th/.test(q(row(2))), 'the ~25th credits land on Wed the 25th, tagged', q(row(2)));
ok(n(`${row(0)} .ch-item.missed`) === 2, "Monday's two unticked chores show as missed", String(n(`${row(0)} .ch-item.missed`)));
ok(n(`${row(1)} .ch-note`) === 1 && n(`${row(1)} .ch-item`) === 1, 'Tuesday: volleyball is a reminder (no checkbox), vacuum is tickable');
ok(/Quick check-in together/.test(q(`${row(6)} .ch-together`)), 'Sunday has the together check-in on its own line', q(row(6)));
ok(n(`${row(5)} .ch-item`) === 1, 'Saturday Nov 28 (4th Saturday) has only grocery shopping', q(row(5)));
ok(/1 today|2 today|3 today|4 today/.test(q('#chores-card .rec-head')), 'the header counts what is left today', q('#chores-card .rec-head'));
const before = q('#chores-card .rec-head');
const litter = id('Cat litter', 'amanda');
ev(`toggleChore('${litter}', '2026-11-25')`);
ok(ev(`_chIsDone('${litter}', '2026-11-25')`) === true, 'ticking a chore records that day');
ok(n(`${row(2)} .ch-item.done`) === 1, 'the ticked chore shows as done');
ok(q('#chores-card .rec-head') !== before, 'the today count drops', `${before} → ${q('#chores-card .rec-head')}`);
ok(ev(`_chIsDone('${litter}', '2026-11-27')`) === false, "Friday's cat litter is a separate occurrence, still open");
ev(`toggleChore('${litter}', '2026-11-25')`);
ok(ev(`_chIsDone('${litter}', '2026-11-25')`) === false, 'tapping again undoes it');

// Per-phone filter
ev("setChoresWho('aidan')");
ok(n('#chores-card .ch-hdr > div') === 2 && /Aidan/.test(q('#chores-card .ch-hdr')), 'Aidan filter shows one column', q('#chores-card .ch-hdr'));
ok(!/Cat litter/.test(q(row(2))) && /Clean bathroom/.test(q(row(2))), "Aidan's view hides Amanda's chores", q(row(2)));
ok(/Quick check-in together/.test(q(row(6))), "…but keeps the together ones");
ok(ev("localStorage.getItem('ow-chores-who')") === 'aidan', 'the filter is remembered on this device');
ev("setChoresWho('all')");

// ── Schedule ────────────────────────────────────────────────────────────────
ev("setChoresTab('schedule')");
const titles = ev("[...document.querySelectorAll('#chores-card .ch-sec-title')].map(e => e.textContent)");
ok(j(titles) === j(['Weekly', 'Monthly', 'Every 3 months (Jan, Apr, Jul, Oct)']), 'Schedule sections: weekly, monthly, every 3 months', j(titles));
const monthlyWhens = ev("[...document.querySelectorAll('#chores-card .ch-sec')[1].querySelectorAll('.ch-when')].map(e => e.textContent)");
ok(j(monthlyWhens) === j(['1st Saturday', '2nd weekend', '3rd weekend', '~25th', 'When the box reveal drops']),
  'monthly rows are in calendar order, with the as-it-comes-up one last', j(monthlyWhens));
ok(/late · Sat Nov 7/.test(sec(1)), "this month's unticked 1st-Saturday chore shows as late", sec(1).slice(0, 200));
ok(/Sat Jan 2/.test(sec(2)), 'the furnace filter shows its next date, Sat Jan 2', sec(2));
const order = id('Order cat food + litter', 'amanda');
ev(`toggleChore('${order}', '2026-11-07')`);
ok(/Sat Dec 5/.test(ev("document.querySelectorAll('#chores-card .ch-sec')[1].querySelector('.ch-srow').textContent")),
  'ticking the late one moves it on to Sat Dec 5', sec(1).slice(0, 120));
const allure = id('Allure box: worth it?', 'amanda');
ev(`toggleChore('${allure}', '2026-11-25')`);
ok(/done today/.test(sec(1)), 'an as-it-comes-up chore ticked today says so in the schedule', sec(1).slice(-120));
ok(/Allure box: worth it\?/.test(q('#chores-card')) && ev(`_chLastDone('${allure}')`) === '2026-11-25', 'and remembers when it was last done');

// ── Editor ──────────────────────────────────────────────────────────────────
ev("openChoreEditor()");
ok(ev("document.getElementById('chore-editor-overlay').style.display") === 'flex', 'Add chore opens the editor');
ev(`(function(){ const $ = id => document.getElementById(id);
  $('ce-text').value = 'Water plants'; $('ce-who').value = 'aidan'; $('ce-freq').value = 'weekly';
  $('ce-freq').dispatchEvent(new Event('change'));
  document.querySelector('.ce-day[data-day="thu"]').click();
  document.querySelector('.ce-day[data-day="sun"]').click();
  $('ce-save').click(); })()`);
const plants = ev("chores.find(c => c.text === 'Water plants')");
ok(plants && plants.who === 'aidan' && j(plants.rule) === j({ freq: 'weekly', days: ['thu', 'sun'] }), 'a new weekly chore saves its days', j(plants));
ok(ev("document.getElementById('chore-editor-overlay').style.display") === 'none', 'saving closes the editor');
// Weekly with no days is refused rather than saved as a chore that never comes up.
ev(`(function(){ openChoreEditor(); const $ = id => document.getElementById(id);
  $('ce-text').value = 'Nothing'; $('ce-freq').value = 'weekly'; $('ce-save').click(); })()`);
ok(!ev("chores.some(c => c.text === 'Nothing')"), 'a weekly chore with no days is not saved');
ev('closeChoreEditor()');
// Editing the quarterly chore round-trips its schedule, and changing it sticks.
const filter = id('Replace HVAC/furnace filter', 'aidan');
ev(`openChoreEditor('${filter}')`);
ok(ev("document.getElementById('ce-freq').value") === 'months' && ev("document.getElementById('ce-every').value") === '3'
  && ev("document.getElementById('ce-start').value") === '1' && ev("document.getElementById('ce-wd').value") === 'weekend',
  'the editor loads every 3 months from Jan, 1st weekend');
ev(`(function(){ const $ = id => document.getElementById(id);
  $('ce-every').value = '6'; $('ce-start').value = '3'; $('ce-nth').value = '-1'; $('ce-wd').value = 'sun';
  $('ce-save').click(); })()`);
const f2 = ev(`chores.find(c => c.id === '${filter}').rule`);
ok(j(f2) === j({ freq: 'monthly', on: { nth: -1, weekday: 'sun' }, months: [3, 9] }), 'changed to every 6 months from Mar, last Sunday', j(f2));
// Day-of-month with "about"
ev(`(function(){ openChoreEditor(); const $ = id => document.getElementById(id);
  $('ce-text').value = 'Pay card'; $('ce-freq').value = 'monthly'; $('ce-nth').value = 'day';
  $('ce-nth').dispatchEvent(new Event('change')); $('ce-day').value = '15'; $('ce-approx').checked = true; $('ce-save').click(); })()`);
ok(j(ev("chores.find(c => c.text === 'Pay card').rule")) === j({ freq: 'monthly', on: { day: 15, approx: true } }), 'a day-of-month chore saves with "about"');
// Delete
const vac = id('Vacuum', 'aidan');
ev(`deleteChore('${vac}')`); ev('_confirmOk()');
ok(!ev(`chores.some(c => c.id === '${vac}')`), 'deleting a chore removes it');

ok(app.errors.length === 0, 'no runtime errors', app.errors.slice(0, 3).join(' | '));
app.close();
T.done();
