# Tests

Plain Node, no framework. Run everything:

```sh
npm install        # once — jsdom + playwright/chromium
node test/run-all.js
```

Or individually:

| File | What it checks | Catches |
|---|---|---|
| `parse-check.js` | Every inline `<script>` parses; no duplicate top-level names | Syntax errors, accidental redeclarations |
| `split-math.test.js` | The 56/44 split, settlement, income and refund handling | Wrong math, lost/created pennies, sign errors |
| `emoji.test.js` | The auto-emoji table | Ordering bugs (a general pattern stealing a specific one's matches) |
| `runtime.test.js` | Loads the real page in jsdom with Firebase stubbed, pushes data through the listeners, drives the UI | **Runtime** errors: out-of-scope helpers, TDZ, bad element ids, renders that throw on real data |
| `budget-audit.test.js` | Budget tab money math end to end: amount parsing, tiles vs. category breakdown vs. trend chart, period views, settlement, settled-month drift, recurring "already loaded" | Tiles disagreeing with the rows beneath them, sign errors, money attributed to nobody, double-charged months |
| `ics.test.js` | Trip end-date parsing, asserting the `index.html` and `functions/index.js` copies agree case-for-case; plus feed structure | The two implementations drifting apart, off-by-one-day on all-day events, DST/leap-year/cross-year errors |
| `concurrency.test.js` | TWO jsdom clients against one shared fake Firestore, with controllable snapshot delay | Last-write-wins data loss when you and Aidan act at the same time; double-charged recurring months |
| `data-audit.test.js` | Self-test for `data-audit.js` against fixtures with planted faults | A health check that silently stops detecting anything — the worst failure mode for a health check |
| `layout.test.js` | Real Chromium at iPhone SE / iPhone 14 / iPad (both orientations) / 13" laptop / desktop widths: horizontal overflow, clipped text, tap-target size, dark mode. Writes `test/screenshots/` | Anything about actual layout — jsdom has no layout engine and cannot see it at all |

## Auditing your real data

Separate from the test suite. Read-only, stays on your machine:

```sh
# In the app: Budget → ⚙️ Settings → Data → Export backup
node test/data-audit.js ~/Downloads/our-weekly-backup-YYYY-MM-DD.json
```

Reports duplicates, double-charged recurring months, rows attributable to neither person, dates
that disagree with their own month label, settled months with activity added afterwards, overdrawn
gift cards, and trips with unparseable dates.

`runtime.test.js` needs jsdom:

```sh
npm install --no-save jsdom
```

## Four traps these harnesses fell into (worth remembering)

Every one produced confidently passing tests that were measuring nothing:

1. **The layout test measured the login screen.** The Firebase stub never fired an auth callback,
   so the overlay never lifted and 36 assertions "passed" against an empty gate. `layout.test.js`
   now asserts the overlay is dismissed *and* that real content rendered before it measures.
2. **Screenshots and measurements were attributed to the wrong tab.** `showPage()` fades the
   outgoing page for 150ms before swapping `.active`, so a fixed 120ms wait consistently measured
   the *previous* page. It now waits on the actual condition.

3. **An assertion that could never fail.** "A collapsed budget section stays collapsed across a
   re-render" passed even with the re-apply function gutted to `{}` — because `renderBudget()` only
   rewrites the *children* of a section body, so an inline `display:none` survives on its own. The
   real thing needing coverage was a **fresh load**, where the collapsed state lives only in
   localStorage and the body has no inline style. Found by deliberately breaking the code.

4. **A fullPage screenshot silently disabled touch emulation.** `page.screenshot({fullPage:true})`
   permanently clears Chromium's device-metric emulation — touch included — for the rest of that
   page's life. The tap-target section ran after the screenshot loop, so `pointer:coarse` was false,
   every touch-sizing CSS rule was absent, and it reported mouse-sized buttons on a device it
   thought had a mouse. Found by mutation testing: removing the real iPad fix didn't fail anything.
   Fixed by moving the check above the screenshot loop AND asserting `pointer:coarse` is live, so
   ordering can't silently regress.

If a harness reports everything green on the first run, be suspicious and check it can fail.

**How to check:** break the thing on purpose and confirm the suite goes red.

```sh
cp index.html /tmp/orig.html
sed -i 's|<the real line>|<a broken version>|' index.html
node test/runtime.test.js      # must FAIL, and fail for the right reason
cp /tmp/orig.html index.html
```

An assertion that survives the mutation is testing nothing. This is worth doing for any test
guarding money or persisted state.

## Why runtime.test.js exists

`parse-check.js` passing does **not** mean the page works. It cannot see:

- a function using a helper that's only a local inside some *other* function
  (this actually happened: `renderSplitPreview` called `fmt`, which lives inside `renderBudget`
  — the Settings popup would have thrown on open, and only the runtime test caught it)
- a `const` referenced before its declaration line executes (TDZ)
- a `getElementById` for an id that doesn't exist
- anything that only breaks on real-shaped data

So: when changing anything non-trivial, run `runtime.test.js`, not just the parse check.

## Extending the split-math tests

`split-math.test.js` **extracts** the real math out of `index.html` between the
`// ─── SHARED-EXPENSE SPLIT` banner and `const MONTHS_LIST` — it does not keep its own copy.
If that block moves, update the markers at the top of the file. Same idea for the emoji test.
