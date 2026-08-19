/**
 * Real-browser layout test (Chromium via Playwright).
 *
 * Everything else in this suite runs in jsdom, which has NO layout engine — it cannot tell you
 * whether anything fits on a phone. This loads the actual page in a real browser at real iPhone
 * viewport sizes and measures: horizontal overflow, clipped text, and tap-target sizes. It also
 * writes screenshots to test/screenshots/ so the rendering can be eyeballed.
 *
 * Run:  node test/layout.test.js
 * Needs: npm install   (playwright + a chromium download)
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const INDEX = path.join(__dirname, '..', 'index.html');
const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

// Firebase stub installed BEFORE any page script runs. The real CDN scripts are aborted by a route
// handler, so nothing overwrites this. window.__push lets the test feed snapshots in.
const STUB = `
window.__listeners = {};
window.__pushQueue = [];
(function () {
  const makeSnap = (id, data) => ({ exists: data !== undefined, id, data: () => data,
                                    metadata: { hasPendingWrites: false } });
  const doc = id => ({
    onSnapshot(next) { window.__listeners[id] = typeof next === 'function' ? next : next && next.next; return () => {}; },
    set() { return Promise.resolve(); },
    update() { return Promise.resolve(); },
    get() { return Promise.resolve(makeSnap(id, undefined)); },
  });
  const fb = {
    initializeApp: () => ({}), apps: [],
    // Sign a fake user in immediately. Without this the login overlay never lifts and the whole
    // test measures an empty gate while happily reporting everything "passed".
    auth: () => ({
      onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'test-user', email: 'test@example.com' }), 0); return () => {}; },
      signInWithEmailAndPassword: () => Promise.resolve(),
      signOut: () => Promise.resolve(),
      currentUser: { uid: 'test-user', email: 'test@example.com' },
    }),
    firestore: () => ({
      collection: () => ({ doc }),
      runTransaction: fn => Promise.resolve(fn({ get: () => Promise.resolve(makeSnap('t', { items: [] })), set: () => {} })),
      enablePersistence: () => Promise.resolve(), settings: () => {},
    }),
  };
  fb.firestore.FieldValue = { arrayUnion: (...v) => ({ v }), arrayRemove: (...v) => ({ v }), delete: () => ({}) };
  window.firebase = fb;
  window.__push = (id, data) => {
    const cb = window.__listeners[id];
    if (cb) cb(makeSnap(id, data));
  };
})();
`;

const YEAR = String(new Date().getFullYear());
const MONTH = String(new Date().getMonth() + 1).padStart(2, '0');

const DATA = {
  expenses: { items: [
    { id: 'e1', date: `${YEAR}-${MONTH}-02`, person: 'Amanda', category: 'Groceries', description: 'Woodmans weekly shop', amount: 210.45, shared: true,  splitPct: 56 },
    { id: 'e2', date: `${YEAR}-${MONTH}-05`, person: 'Aidan',  category: 'Dining',    description: 'Sushi',                amount: 90.00,  shared: true,  splitPct: 56 },
    { id: 'e3', date: `${YEAR}-${MONTH}-07`, person: 'Amanda', category: 'Income',    description: 'Poshmark payout',      amount: 1640.00, shared: false, splitPct: 56 },
    { id: 'e4', date: `${YEAR}-01-15`,       person: 'Amanda', category: 'Housing',   description: 'Mortgage',             amount: 1833.00, shared: true },
  ] },
  splitPct: { aidan: 56 },
  settledMonths: { months: {} },
  giftCards: { items: [
    { id: 'gc1', label: 'Target', amount: 25 },
    { id: 'gc2', label: 'Bath & Body Works rewards card', amount: 150 },   // deliberately long label
    { id: 'gc3', label: 'Starbucks', amount: 10 },
  ], spends: [
    { id: 's1', cardId: 'gc1', date: `${YEAR}-${MONTH}-01`, amount: 12.34 },
    { id: 's2', cardId: 'gc3', date: `${YEAR}-${MONTH}-03`, amount: 10 },
  ] },
  todos: { items: [
    { id: 't1', text: 'Book campsite for Peninsula State Park', cat: 'todo', done: false, due: `${YEAR}-${MONTH}-25` },
    { id: 't2', text: 'Renew passport', cat: 'todo', done: false, due: `${YEAR}-01-05`, priority: 'critical' },
    { id: 't3', text: 'No deadline', cat: 'todo', done: false },
  ] },
  todoCategories: { items: [{ id: 'todo', label: '📋 To-Do' }] },
  trips: { items: [
    { id: 'trip-a', dates: 'Aug 21–23', sortDate: `${YEAR}-${MONTH}-21`, label: 'Peninsula State Park Camping' },
    { id: 'trip-b', dates: 'Aug 22',    sortDate: `${YEAR}-${MONTH}-22`, label: 'Night Market' },
    { id: 'trip-d', dates: 'Oct 24 – Nov 8', sortDate: `${YEAR}-10-24`, label: 'JAPAN' },
  ] },
  okdOverlaps: { pairs: [] },
  weekplan: { mon: {}, tue: {}, wed: {}, thu: {}, fri: {}, sat: {}, sun: {} },
  datedEvents: { items: [{ id: 'ev1', date: `${YEAR}-${MONTH}-20`, text: 'Dentist' }] },
  recurring: { items: [] },
};

const VIEWPORTS = [
  { name: 'iphone-se',  width: 375, height: 667 },   // smallest phone still in use
  { name: 'iphone-14',  width: 390, height: 844 },
  // iPad and laptop are the two Amanda actually organizes from, so they get real coverage rather
  // than being assumed to fall out of "desktop". Portrait iPad in particular sits in the awkward
  // band above the phone breakpoints but well below a laptop.
  { name: 'ipad-portrait',  width: 820,  height: 1180, touch: true },
  { name: 'ipad-landscape', width: 1180, height: 820,  touch: true },
  { name: 'laptop-13',      width: 1440, height: 900 },
  { name: 'desktop',    width: 1280, height: 900 },
];
const PAGES = ['home', 'dates', 'todos', 'budget', 'history'];

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) pass++; else { fail++; failures.push({ name, detail }); }
}

(async () => {
  const browser = await chromium.launch();
  const pageErrors = [];

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1, isMobile: vp.width < 500,
      // iPad is a touch device at a tablet width — tap-target checks must apply there too, which
      // they wouldn't under a width-only rule.
      hasTouch: vp.width < 500 || !!vp.touch });
    const page = await context.newPage();
    page.on('pageerror', e => pageErrors.push(`[${vp.name}] ${e.message}`));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      // We abort the firebase CDN ourselves (the stub replaces it), so the resulting failed-resource
      // errors are noise from the harness, not the page misbehaving.
      if (/ERR_FAILED|Failed to load resource/i.test(m.text())) return;
      pageErrors.push(`[${vp.name}] console: ${m.text()}`);
    });
    // Block the firebase CDN — the stub stands in for it.
    await page.route('**/*firebasejs/**', r => r.abort());
    await page.route('**/gstatic.com/**', r => r.abort());
    await page.addInitScript(STUB);
    await page.goto('file://' + INDEX.replace(/\\/g, '/'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('typeof initFirestore === "function"');
    // Wait for the auth callback to lift the login overlay — otherwise every measurement below is
    // taken against the sign-in screen. This is asserted, not assumed.
    await page.waitForFunction(
      () => { const ov = document.getElementById('login-overlay');
              return !ov || ov.classList.contains('hidden') || getComputedStyle(ov).display === 'none'; },
      { timeout: 5000 });
    await page.evaluate(() => initFirestore());
    await page.evaluate(d => { for (const [k, v] of Object.entries(d)) window.__push(k, v); }, DATA);

    // Guard against the whole suite silently measuring a blank/gated page.
    const gated = await page.evaluate(() => {
      const ov = document.getElementById('login-overlay');
      return !!ov && !ov.classList.contains('hidden') && getComputedStyle(ov).display !== 'none';
    });
    ok(!gated, `${vp.name}: login overlay is dismissed so the app is actually visible`);
    // Budget only renders while its page is active, so switch to it before checking for content.
    await page.evaluate(() => showPage('budget'));
    await page.waitForFunction(
      () => { const a = document.querySelector('.page.active'); return a && a.id === 'page-budget'; },
      { timeout: 5000 });
    await page.waitForTimeout(120);
    const hasContent = await page.evaluate(() => {
      const el = document.getElementById('budget-snapshot');
      return !!el && el.children.length > 0;
    });
    ok(hasContent, `${vp.name}: real app content rendered (snapshot tiles present)`,
      'the page rendered but the Budget tiles are empty — measurements would be meaningless');

    // ── Tap targets (any touch device) ────────────────────────────────────
    // Apple's guidance is 44x44pt. Anything much smaller is a coin-flip to hit with a finger.
    // Gated on TOUCH, not on width: an iPad is finger-driven at 820px, so a control too small to
    // hit is just as wrong there as on a phone. A width-only rule missed that entirely.
    //
    // MUST run before the screenshot loop. page.screenshot({fullPage:true}) permanently clears
    // Chromium's device-metric emulation — touch included — for the rest of that page's life, so
    // measuring afterwards saw pointer:coarse=false, dropped every touch-sizing rule, and reported
    // mouse-sized buttons on a device it thought had a mouse. Third time this harness has silently
    // measured the wrong thing, hence the assertion rather than a comment asking for the ordering
    // to be preserved.
    if (vp.width < 500 || vp.touch) {
      const touchLive = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
      ok(touchLive, `${vp.name}: touch emulation is still active (else tap-target checks are vacuous)`,
        'pointer:coarse is false — something reset device emulation before this check');
      await page.evaluate(() => showPage('budget'));
      await page.waitForFunction(
        () => { const a = document.querySelector('.page.active'); return a && a.id === 'page-budget'; },
        { timeout: 5000 });
      await page.waitForTimeout(120);
      // Two bars, deliberately. Controls added recently are held to 36px (a comfortable
      // one-handed tap). Long-standing controls — the Settings button and the month pills in the
      // sticky period picker — sit at 31-34px; they're reported but not failed, because silently
      // restyling a layout Amanda already tuned is not this test's call to make.
      const measure = sel => page.evaluate(s2 => [...document.querySelectorAll(s2)]
        .filter(el => { const r = el.getBoundingClientRect();
                        return r.width > 0 && r.height > 0 && (r.height < 36 || r.width < 28); })
        .slice(0, 10)
        .map(el => `${el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') || el.id} ` +
                   `"${(el.textContent || '').trim().slice(0, 16)}" ` +
                   `${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`), sel);

      const newControls = await measure('.gc-btn, .gc-use-input, .todo-due, .overlap-dismiss, .overlap-okd');
      ok(newControls.length === 0,
        `${vp.name}: recently-added controls are tappable (>=36px tall)`, newControls.join('; '));

      const legacyControls = await measure('.bmonth-pill, .bq-btn, .budget-settings-btn');
      if (legacyControls.length) {
        console.log(`  ℹ ${vp.name}: pre-existing controls below 36px (not failed, for your call):`);
        for (const c of legacyControls) console.log(`      ${c}`);
      }
    }

    for (const pageName of PAGES) {
      await page.evaluate(p => showPage(p), pageName);
      // showPage fades the outgoing page for 150ms before swapping .active, so waiting a fixed
      // 120ms measured the PREVIOUS tab. Wait for the real condition instead of guessing a delay.
      await page.waitForFunction(
        p => { const a = document.querySelector('.page.active'); return a && a.id === 'page-' + p; },
        pageName, { timeout: 5000 });
      await page.waitForTimeout(120);   // let the fade-in and any deferred render settle

      // ── 1. Horizontal overflow ────────────────────────────────────────────
      // A page wider than the viewport means side-scrolling on a phone, which is the single most
      // common way a layout "breaks" without anything looking obviously wrong in a desktop browser.
      const overflow = await page.evaluate(() => ({
        docWidth: document.documentElement.scrollWidth,
        viewWidth: window.innerWidth,
        // Which elements actually stick out past the right edge?
        culprits: [...document.querySelectorAll('body *')]
          .filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            const st = getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden') return false;
            if (st.position === 'fixed') return false;   // overlays are allowed off-canvas
            return r.right > window.innerWidth + 1;
          })
          .slice(0, 6)
          .map(el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}` +
                     `${el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''}` +
                     ` (right=${Math.round(el.getBoundingClientRect().right)})`),
      }));
      ok(overflow.docWidth <= overflow.viewWidth + 1,
        `${vp.name} / ${pageName}: no horizontal overflow`,
        `page is ${overflow.docWidth}px wide in a ${overflow.viewWidth}px viewport. Sticking out: ` +
        (overflow.culprits.join('; ') || 'none identified'));

      // ── 2. Clipped text ──────────────────────────────────────────────────
      // scrollWidth > clientWidth on a nowrap element means the text is cut off mid-word.
      const clipped = await page.evaluate(() => [...document.querySelectorAll(
          '.bsnap-val, .bsnap-label, .gc-name, .gc-amt, .todo-due, .overlap-dismiss, .overlap-okd, ' +
          '.plan-slot-trip, .budget-cat-amt, .trip-name, .btrend-lbl, .gc-log-entry')]
        .filter(el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const st = getComputedStyle(el);
          if (st.display === 'none') return false;
          // text-overflow:ellipsis is an intentional truncation with a visible "…" affordance, so
          // overflowing is the designed behaviour there rather than text being silently cut off.
          if (st.textOverflow === 'ellipsis') return false;
          return el.scrollWidth > el.clientWidth + 1;
        })
        .slice(0, 8)
        .map(el => `${el.className.split(/\s+/)[0]} "${(el.textContent || '').trim().slice(0, 28)}" ` +
                   `(needs ${el.scrollWidth}px, has ${el.clientWidth}px)`));
      ok(clipped.length === 0, `${vp.name} / ${pageName}: no clipped text`, clipped.join('; '));

      // Confirm the page we asked for is the page we're measuring. Without this, a showPage() that
      // silently no-ops would have every screenshot and measurement attributed to the wrong tab.
      const activeId = await page.evaluate(() => {
        const a = document.querySelector('.page.active');
        return a ? a.id : '(none)';
      });
      ok(activeId === 'page-' + pageName,
        `${vp.name} / ${pageName}: showPage actually switched to it`,
        `active page is "${activeId}", expected "page-${pageName}"`);
      await page.screenshot({ path: path.join(SHOTS, `${vp.name}-${pageName}.png`), fullPage: false });
      // Also capture the whole scroll height, so sections below the fold (gift cards, the
      // transaction list) are reviewable instead of invisible to this test.
      await page.screenshot({ path: path.join(SHOTS, `${vp.name}-${pageName}-full.png`), fullPage: true });
    }

    // ── 4. Dark mode must not break layout or wash out text ───────────────
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); showPage('budget'); });
    await page.waitForFunction(
      () => { const a = document.querySelector('.page.active'); return a && a.id === 'page-budget'; },
      { timeout: 5000 });
    await page.waitForTimeout(120);
    const darkOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    ok(darkOverflow, `${vp.name}: dark mode does not introduce overflow`);
    await page.screenshot({ path: path.join(SHOTS, `${vp.name}-budget-dark.png`) });
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));

    await context.close();
  }

  await browser.close();

  ok(pageErrors.length === 0, 'no browser console errors on any page/viewport', pageErrors.slice(0, 6).join('\n      '));

  console.log('');
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log(`  screenshots → test/screenshots/`);
  if (fail) {
    console.log('');
    for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.detail || ''}`);
    console.log('');
    process.exit(1);
  }
  console.log('  Layout holds at phone and desktop widths.\n');
})().catch(err => { console.error(err); process.exit(1); });
