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
ev('renderHome()');
ok(ev("document.getElementById('home-chores-widget').style.display") === 'none', 'Home shows no chores card before there are any chores');
ev('loadChoreTemplate()');
const count = ev('chores.length');
ok(count === 20, 'the plan loads all 20 chores', String(count));
ev('loadChoreTemplate()');
ok(ev('chores.length') === 20, 'loading the plan twice does not duplicate it');
const id = (text, who) => ev(`(chores.find(c => c.text === ${j(text)} && c.who === ${j(who)}) || {}).id`);

// ── Home: only what needs doing today ─────────────────────────────────────
ev("setChoresWho('all'); setChoresTab('week'); renderHome()");
const homeLines = () => ev("[...document.querySelectorAll('#home-chores .ch-line')].map(l => l.textContent.replace(/\\s+/g, ' ').trim())");
const homeShown = () => ev("document.getElementById('home-chores-widget').style.display") !== 'none';
ok(homeShown(), "Home shows a Today's chores card on a day with chores due");
ok(j(homeLines().map(l => l.replace(/ (Amanda|Aidan|Together).*$/, '')).sort()) === j(['Cat litter', 'Clean bathroom', 'Spend DoorDash credit', 'Spend DoorDash credit, use Uber credit']),
  "on Wed Nov 25 (plan just loaded): Wednesday's chores and the ~25th credits, nothing from before today", j(homeLines()));
ok(ev('chores.every(c => c.since === "2026-11-25")'), 'every loaded chore remembers the day it was added');
ok(/4 to do/.test(q('#chores-card .rec-head')), 'the To-Dos card header counts what is owed', q('#chores-card .rec-head'));
ok(/Cat litter/.test(q('#today-banner')) && /Clean bathroom/.test(q('#today-banner')), "the Calendar's Today banner lists today's chores", q('#today-banner'));
// The checkbox ticks; the name edits, same as a to-do.
const litter = id('Cat litter', 'amanda');
ok(/toggleChore\('[^']+','2026-11-25'\)/.test(ev("document.querySelector('#home-chores .ch-line .ch-tick').getAttribute('onclick')"))
  && /openChoreEditor\(/.test(ev("document.querySelector('#home-chores .ch-line .ch-name').getAttribute('onclick')")),
  'the checkbox ticks and the name opens the editor');
ev(`toggleChore('${litter}', '2026-11-25')`);
ok(ev(`_chIsDone('${litter}', '2026-11-25')`) === true, 'ticking records that day');
ok(ev("document.querySelectorAll('#home-chores .ch-line.done').length") === 1 && /3 to do/.test(q('#chores-card .rec-head')),
  'a ticked chore stays on Home struck through (so a mis-tap can be undone) and the count drops', q('#chores-card .rec-head'));
ok(ev(`_chIsDone('${litter}', '2026-11-27')`) === false, "Friday's cat litter is a separate occurrence, still open");
for (const x of ev('choresToday("2026-11-25").due.map(d => [d.c.id, d.iso])')) ev(`toggleChore('${x[0]}', '${x[1]}')`);
ok(/All done for today/.test(q('#home-chores')), 'when everything is ticked Home says all done', q('#home-chores'));
for (const x of ev('choresToday("2026-11-25").done.map(d => [d.c.id, d.iso])')) ev(`toggleChore('${x[0]}', '${x[1]}')`);
ok(ev(`_chIsDone('${litter}', '2026-11-25')`) === false, 'tapping again undoes it');
// A day with nothing due hides the card entirely.
{
  const a3 = boot('2026-11-28T10:00:00');   // a Saturday
  a3.ev("loadChoreTemplate(); setChoresWho('amanda'); renderHome()");
  ok(a3.ev("document.getElementById('home-chores-widget').style.display") === 'none', 'Home hides the card on a day with nothing due (Amanda, Sat Nov 28)',
    a3.ev("document.getElementById('home-chores').textContent").replace(/\s+/g, ' '));
  a3.close();
}
// The new card lands right after the stats even for a saved custom layout that predates it.
ev("localStorage.setItem('ow-widget-order', JSON.stringify(['countdowns', 'stats', 'customize'])); applyWidgetOrder()");
const wOrder = ev("[...document.querySelectorAll('#home-widgets > .home-widget')].map(w => w.dataset.widget)");
ok(wOrder.indexOf('chores') === wOrder.indexOf('stats') + 1, "a saved home layout gets Today's chores right after the stats, not at the bottom", j(wOrder));

// ── Late: owed until done or until the next occurrence comes round ──────────
ev("chores.forEach(c => { c.since = '2026-11-01'; }); renderChores()");
const due = ev('choresToday("2026-11-25").due.map(d => ({ t: d.c.text, who: d.c.who, iso: d.iso, late: d.late }))');
const find = t => due.find(d => d.t === t);
ok(find('Wipe counters') && find('Wipe counters').late && find('Wipe counters').iso === '2026-11-23', "Monday's unticked wipe-counters is late on Wednesday", j(find('Wipe counters')));
ok(find('Order cat food + litter') && find('Order cat food + litter').iso === '2026-11-07', "this month's 1st-Saturday chore is still owed", j(find('Order cat food + litter')));
const firstOnTime = due.findIndex(d => !d.late);
ok(firstOnTime > 0 && due.slice(firstOnTime).every(d => !d.late), 'late ones are listed first', j(due.map(d => d.late)));
ok(/since Mon Nov 23/.test(q('#home-chores')), 'a late chore says since when', q('#home-chores').slice(0, 160));
const thu = ev('choresToday("2026-11-26").due.filter(d => d.c.text === "Laundry + change bedding").map(d => ({ iso: d.iso, late: d.late }))')[0];
ok(thu && thu.iso === '2026-11-26' && !thu.late, "a missed weekly chore stops being late when its next day comes; it is just today's", j(thu));
ok(!ev('choresToday("2026-11-25").due.some(d => d.c.note)'), 'reminders (volleyball) are never owed');
ok(ev('choresToday("2026-11-24").notes.some(d => /Volleyball/.test(d.c.text))'), '...but show on their day as a reminder');

// ── Up next (To-Dos card) ───────────────────────────────────────────────────
ev("showPage('todos'); renderTodos()");
ok(/Up next/.test(q('#chores-card .ch-tabs')), 'the card opens on Up next');
const groups = ev("[...document.querySelectorAll('#chores-card .ch-daygrp')].map(g => g.textContent.replace(/\\s+/g, ' ').trim())");
ok(groups.length && /^Thu Nov 26/.test(groups[0]) && /Laundry/.test(groups[0]), 'Coming up starts tomorrow with Thursday laundry', j(groups.slice(0, 2)));
ok(groups.length <= 6, 'Coming up covers the next six days only', String(groups.length));
ok(!ev("document.querySelector('#chores-card .ch-week')"), 'no full week grid any more');

// Per-phone filter
ev("setChoresWho('aidan'); renderHome()");
ok(!/Order cat food/.test(q('#home-chores')) && /Clean bathroom/.test(q('#home-chores')), "Aidan's phone shows his chores, not Amanda's", q('#home-chores').slice(0, 200));
ok(/Quick check-in together/.test(ev('choresToday("2026-11-29").due.map(d => d.c.text).join("|")')), '...and still the together ones');
ok(ev("localStorage.getItem('ow-chores-who')") === 'aidan', 'the filter is remembered on this device');
ev('cycleChoresWho()');
ok(ev("localStorage.getItem('ow-chores-who')") === 'all', 'the Home pill cycles Aidan to Both');
ev("setChoresWho('all')");

// ── Schedule ────────────────────────────────────────────────────────────────
ev("setChoresTab('schedule')");
ev(`(function(){ const c = { id: 'fresh1', text: 'Fresh monthly', who: 'amanda', rule: { freq: 'monthly', on: { nth: 1, weekday: 'sat' } }, since: '2026-11-25' };
  chores.push(c); renderChores(); })()`);
ok(/Fresh monthly\s*Sat Dec 5/.test(ev("document.querySelector('#chores-card').textContent")),
  "a monthly chore added after this month's date shows next month's, not late");
ev("chores = chores.filter(c => c.id !== 'fresh1'); renderChores()");
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
ok(plants && plants.since === '2026-11-25', 'a chore added in the editor starts counting today', plants && plants.since);
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

// ── Across New Year ─────────────────────────────────────────────────────────
{
  const a2 = boot('2026-12-31T21:00:00');
  a2.ev("loadChoreTemplate(); showPage('todos'); renderTodos()");
  const soon = a2.ev('choresComingUp("2026-12-31", 6).map(d => [d.iso, d.items.map(c => c.text)])');
  const jan2 = (soon.find(d => d[0] === '2027-01-02') || [null, []])[1];
  ok(soon[0] && soon[0][0] === '2027-01-01', 'on Dec 31, Coming up starts Fri Jan 1', JSON.stringify(soon.map(d => d[0])));
  ok(['Replace HVAC/furnace filter', 'Deep clean fridge', 'Order cat food + litter', 'Go through fridge (before groceries)', 'Grocery shopping'].every(t => jan2.includes(t)),
    'Sat Jan 2 brings the quarterly filter + fridge and the 1st-Saturday chores', JSON.stringify(jan2));
  ok(a2.errors.length === 0, '[2026-12-31] no runtime errors', a2.errors.slice(0, 2).join(' | '));
  a2.close();
}
{
  const a2 = boot('2027-01-02T09:00:00');
  a2.ev("loadChoreTemplate(); renderHome()");
  const today = a2.ev('choresToday("2027-01-02").due.map(d => d.c.text)');
  ok(today.includes('Replace HVAC/furnace filter') && today.includes('Order cat food + litter'), "on Sat Jan 2 Home lists the quarterly and 1st-Saturday chores", JSON.stringify(today));
  const sun = a2.ev('choresToday("2027-01-03").due.map(d => d.c.text)');
  ok(sun.includes('Replace HVAC/furnace filter'), '...and still on Sunday, since a weekend chore is on time through Sunday', JSON.stringify(sun));
  const mon = a2.ev('choresToday("2027-01-04").due.filter(d => d.c.text === "Replace HVAC/furnace filter").map(d => d.late)');
  ok(mon.length === 1 && mon[0] === true, 'unticked by Monday Jan 4 it shows as late', JSON.stringify(mon));
  ok(a2.errors.length === 0, '[2027-01-02] no runtime errors', a2.errors.slice(0, 2).join(' | '));
  a2.close();
}
T.done();
