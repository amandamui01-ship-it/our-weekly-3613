# Tests

Plain Node, no framework. Run all four:

```sh
node test/run-all.js
```

Or individually:

| File | What it checks | Catches |
|---|---|---|
| `parse-check.js` | Every inline `<script>` parses; no duplicate top-level names | Syntax errors, accidental redeclarations |
| `split-math.test.js` | The 56/44 split, settlement, income and refund handling | Wrong math, lost/created pennies, sign errors |
| `emoji.test.js` | The auto-emoji table | Ordering bugs (a general pattern stealing a specific one's matches) |
| `runtime.test.js` | Loads the real page in jsdom with Firebase stubbed, pushes data through the listeners, drives the UI | **Runtime** errors: out-of-scope helpers, TDZ, bad element ids, renders that throw on real data |

`runtime.test.js` needs jsdom:

```sh
npm install --no-save jsdom
```

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
