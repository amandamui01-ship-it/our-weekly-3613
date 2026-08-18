/**
 * Parse-check every inline <script> block in index.html.
 *
 * Catches syntax errors only. It CANNOT catch temporal-dead-zone problems (a const referenced by
 * a function that an earlier IIFE calls) or any other runtime ordering bug — those need the page
 * actually loaded in a browser. Treat a pass here as "it parses", not "it works".
 *
 * Run:  node test/parse-check.js
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

let n = 0, bad = 0, m;
while ((m = re.exec(SRC)) !== null) {
  n++;
  const body = m[1];
  const line = SRC.slice(0, m.index).split('\n').length;
  try {
    new Function(body);
  } catch (err) {
    bad++;
    console.log(`  ✗ <script> #${n} (index.html line ~${line}): ${err.message}`);
  }
}
console.log(`\n  ${n - bad}/${n} inline script blocks parse cleanly.`);
if (bad) process.exit(1);

// Cheap duplicate-declaration guard: two `function foo(` or `const foo =` at top level would be a
// silent redefinition. Only flags exact top-level (column-0) declarations.
const decls = {};
for (const dm of SRC.matchAll(/^(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=)/gm)) {
  const name = dm[1] || dm[2];
  decls[name] = (decls[name] || 0) + 1;
}
const dupes = Object.entries(decls).filter(([, c]) => c > 1);
if (dupes.length) {
  console.log('\n  ⚠ top-level names declared more than once:');
  for (const [name, c] of dupes) console.log(`      ${name} ×${c}`);
} else {
  console.log('  No duplicate top-level declarations.');
}
console.log('');
