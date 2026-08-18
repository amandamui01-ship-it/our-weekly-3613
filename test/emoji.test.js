/**
 * Auto-emoji tests. Extracts the real TRIP_EMOJIS table + tripEmoji() from index.html.
 *
 * The table is first-match-wins, so these cases mostly guard ORDERING: a general pattern placed
 * above a specific one silently steals its matches.
 *
 * Run:  node test/emoji.test.js
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const iStart = SRC.indexOf('// Auto-emoji for trip/event labels.');
const iEnd = SRC.indexOf('// Detect whether a string already contains an emoji', iStart);
if (iStart < 0 || iEnd < 0) { console.error('FATAL: could not find the emoji block in index.html'); process.exit(2); }

const { tripEmoji, TRIP_EMOJIS } = new Function(`
  ${SRC.slice(iStart, iEnd)}
  return { tripEmoji, TRIP_EMOJIS };
`)();

let pass = 0, fail = 0;
const failures = [];
function is(label, expected, why) {
  const got = tripEmoji(label);
  if (got === expected) pass++;
  else { fail++; failures.push(`"${label}" → ${got}, expected ${expected}${why ? '  (' + why + ')' : ''}`); }
}
function isnt(label, notThis, why) {
  const got = tripEmoji(label);
  if (got !== notThis) pass++;
  else { fail++; failures.push(`"${label}" → ${got}, should NOT be ${notThis}${why ? '  (' + why + ')' : ''}`); }
}

// ── Ordering regressions that the old table got wrong ────────────────────────
is('Sarah\'s Bachelorette', '👯', 'must not fall through to \\bbachelor → 🍺');
is('Mike\'s Bachelor Party', '🍺');
is('Kohler-Andrae State Park', '🌲', 'state park is more specific than park');
is('Devil\'s Lake State Park', '🌲');
is('Yellowstone National Park', '🏞️');
is('Noah\'s Ark Water Park', '🛝');
is('Six Flags', '🎢');
is('Just the park', '🌳', 'bare "park" falls to the generic catch-all');

// ── Real labels from Amanda's app ───────────────────────────────────────────
is('JAPAN', '🗾');
is('Peninsula State Park Camping', '🌲', 'state park wins over camping — both are reasonable, pin the behaviour');
is('Camping with Corey + Co', '🏕️');
is('MUNA in Madison', '🌆');
is('Olivia Rodrigo in Chicago', '🌆');
is('Gracie Abrams (Nashville!)', '🎸');
is('WI Fam Xmas', '🎄');
is('Family Xmas', '🎄');
is('Night Market', '🏮', 'night market gets its own lantern, not the generic market basket');
is('Farmers Market', '🌱');
is('Craft fair', '🧺');
is('St Patricks Day', '🍀', 'trailing \\b would reject the "s" in "Patricks"');
is('St. Pattys', '🍀');

// ── Breadth: the point of the expansion is fewer ✨ fallbacks ───────────────
const shouldMatch = [
  'Brewers game', 'Packers tailgate', 'Bucks playoff game', 'Dentist appointment',
  'Haircut', 'Yoga class', 'Half marathon', 'Brunch with Jess', 'Coffee with Ben',
  'Winery tour', 'Brewery hop', 'Trivia night', 'Board game night', 'Bowling league',
  'Thanksgiving at Mom\'s', 'Halloween party', 'NYE downtown', 'Valentines dinner',
  'Easter brunch', 'Fourth of July', 'St Patricks Day', 'Mothers Day', 'Fathers Day',
  'Graduation ceremony', 'Baby shower for Kate', 'Bridal shower', 'Housewarming',
  'Photoshoot', 'Volunteer at food bank', 'Vet appointment for the dog',
  'Apple picking', 'Farmers market', 'Pumpkin patch', 'Kayaking on the lake',
  'Golf with Dad', 'Pickleball', 'Rock climbing', 'Sushi date', 'Taco Tuesday',
  'Fish fry', 'Ice cream run', 'Picnic at the lake', 'Museum visit', 'Broadway musical',
  'Comedy show', 'Karaoke night', 'Movie premiere', 'Cruise to Alaska', 'Road trip west',
  'Hawaii honeymoon', 'Vegas weekend', 'Cabin up north', 'Interview prep', 'Work conference',
  'Pottery class', 'Thrifting downtown', 'Symphony', 'Ballet', 'Arcade bar',
];
const unmatched = shouldMatch.filter(l => tripEmoji(l) === '✨');
if (unmatched.length === 0) pass++;
else { fail++; failures.push(`${unmatched.length} labels still fall back to ✨: ${unmatched.join(', ')}`); }

// Genuinely unmatchable labels SHOULD fall back — the fallback isn't broken, just rarer.
is('Zzzz', '✨');
is('Thing', '✨');

// ── Variety: how many distinct emoji can the table actually produce? ────────
const distinct = new Set(TRIP_EMOJIS.map(([, e]) => e));
if (distinct.size >= 60) pass++;
else { fail++; failures.push(`only ${distinct.size} distinct emoji in the table; expected 60+`); }

// ── Every regex must be valid and none may match the empty string ──────────
for (const [re, emoji] of TRIP_EMOJIS) {
  if (re.test('')) { fail++; failures.push(`${re} matches the empty string → would emoji everything as ${emoji}`); }
  else pass++;
}

console.log('');
console.log(`  ${pass} passed, ${fail} failed`);
console.log(`  ${TRIP_EMOJIS.length} patterns, ${distinct.size} distinct emoji`);
if (fail) {
  console.log('');
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log('');
  process.exit(1);
}
console.log('');
