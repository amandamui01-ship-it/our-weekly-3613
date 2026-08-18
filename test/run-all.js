/**
 * Runs every test file in order, cheapest first, and stops at the first failure.
 *
 * Run:  node test/run-all.js
 */
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  ['parse-check.js',     'syntax'],
  ['split-math.test.js', 'split math'],
  ['emoji.test.js',      'auto-emoji'],
  ['runtime.test.js',    'runtime (jsdom)'],
  ['budget-audit.test.js','budget math audit (jsdom)'],
  ['ics.test.js',        'calendar feed / dates'],
  ['concurrency.test.js','two-client concurrency (jsdom)'],
  ['data-audit.test.js', 'data auditor self-test'],
  ['layout.test.js',     'layout in a real browser (chromium)'],
];

let failed = null;
for (const [file, label] of SUITES) {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 56 - label.length))}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  if (r.status !== 0) { failed = label; break; }
}

console.log('');
if (failed) {
  console.log(`✗ ${failed} failed — stopping.\n`);
  process.exit(1);
}
console.log('✓ All suites passed.\n');
