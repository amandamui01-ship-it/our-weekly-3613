/**
 * Shared test helper: boot the real index.html in jsdom under a FAKE clock, with Firebase stubbed.
 * Writes go nowhere (use concurrency.test.js for persistence); this is for logic + rendering.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML_PATH = process.env.OW_HTML || path.join(__dirname, '..', 'index.html');
const RAW = fs.readFileSync(HTML_PATH, 'utf8');
const HTML = RAW.replace(/<script[^>]*\bsrc=["'][^"']*["'][^>]*>\s*<\/script>/gi, '');

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


function makeOk() {
  const st = { pass: 0, fail: 0 };
  st.ok = (cond, name, detail) => {
    if (cond) st.pass++;
    else { st.fail++; console.log(`  ✗ ${name}${detail !== undefined ? `
      ${detail}` : ''}`); }
  };
  st.done = () => { console.log(`
  ${st.pass} passed, ${st.fail} failed`); process.exit(st.fail ? 1 : 0); };
  return st;
}
module.exports = { boot, makeOk, RAW };
