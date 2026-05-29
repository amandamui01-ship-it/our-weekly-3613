// Live .ics calendar feed for Our Weekly. Subscribed-to by iPhone/Google Calendar so trips added
// in the app appear automatically (typically refreshed every few hours by the calendar client).
//
// Access is gated by a token stored in Firestore at state/settings.icsToken. The client app reads
// the same token to display a complete subscribable URL to the user.

const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const crypto = require('crypto');

initializeApp();
const db = getFirestore();

// Mirror of the same logic in index.html — ICS DTEND for all-day events is exclusive (day AFTER
// the last day). Keep this in sync with the client implementation.
function parseICSEndDate(datesStr, sortDate) {
  if (!sortDate) return '';
  const addOne = s => {
    const d = new Date(s + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  };
  if (!datesStr) return addOne(sortDate);
  const year = parseInt(sortDate.slice(0, 4));
  const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  // Range patterns: "Apr 3–6", "Oct 24 – Nov 8", "Jul 30 – Aug 2".
  //   - (?!\d) prevents capturing a 4-digit year as the end day ("Jun-Jul 2026").
  //   - (?!\s*(?:am|pm)\b) prevents misreading a hyphenated time as a date range
  //     ("May 28 - 9 PM" was parsing "9" as endDay → multi-day phantom trip).
  const rangeMatch = datesStr.match(/[–—\-]\s*(?:([A-Za-z]+)\s+)?(\d{1,2})(?!\d)(?!\s*(?:am|pm)\b)/i);
  if (rangeMatch) {
    const endDay = parseInt(rangeMatch[2]);
    let endMonth;
    if (rangeMatch[1]) {
      endMonth = months[rangeMatch[1].toLowerCase().slice(0, 3)];
    } else {
      const startMonthMatch = datesStr.match(/([A-Za-z]+)/);
      if (startMonthMatch) endMonth = months[startMonthMatch[1].toLowerCase().slice(0, 3)];
    }
    if (endMonth !== undefined && !isNaN(endDay) && endDay >= 1 && endDay <= 31) {
      let endYear = year;
      const startMonth = parseInt(sortDate.slice(5, 7)) - 1;
      if (endMonth < startMonth - 1) endYear++;
      const startDay = parseInt(sortDate.slice(8, 10));
      // Guard against reversed inputs ("Jun 5-3" or other end-before-start typos). Same month,
      // end day < start day → treat as single-day rather than emitting a negative-duration
      // range that the calendar grid would silently drop.
      if (endYear === year && endMonth === startMonth && endDay < startDay) return addOne(sortDate);
      const d = new Date(Date.UTC(endYear, endMonth, endDay + 1));
      return d.toISOString().slice(0, 10).replace(/-/g, '');
    }
  }
  // Numeric range fallback: "4/28-5/2", "12/30-1/2" (cross-year).
  const numericRange = datesStr.match(/(\d{1,2})\/(\d{1,2})\s*[–—\-]\s*(\d{1,2})\/(\d{1,2})/);
  if (numericRange) {
    const endMonth = parseInt(numericRange[3]) - 1;
    const endDay = parseInt(numericRange[4]);
    if (endMonth >= 0 && endMonth <= 11 && endDay >= 1 && endDay <= 31) {
      let endYear = year;
      const startMonth = parseInt(sortDate.slice(5, 7)) - 1;
      if (endMonth < startMonth - 1) endYear++;
      const d = new Date(Date.UTC(endYear, endMonth, endDay + 1));
      return d.toISOString().slice(0, 10).replace(/-/g, '');
    }
  }
  return addOne(sortDate);
}

// Build a floating-time DTSTART/DTEND pair for a single-day event with optional endTime.
// Handles three problem cases the old in-place math missed:
//   1. endTime < startTime (e.g. 23:00 → 01:00 — user wants "11pm to 1am next day"): roll
//      the end forward one day so DTEND > DTSTART. Previously emitted an invalid VEVENT
//      that iPhone/Google Calendar silently dropped.
//   2. endTime == startTime: treat as zero-duration intent → fall back to +1h. Some clients
//      drop true zero-duration events.
//   3. Hour overflow ≥48 from a manually-set bad endTime: integer-division on minutes
//      handles arbitrary day rollover, where the old `eH -= 24` ran once and could leave
//      eH ≥ 24 if input was extreme.
function _buildTimedRange(dateCompact, startTime, endTime) {
  const [sH, sM] = startTime.split(':').map(Number);
  const startMins = sH * 60 + sM;
  let endMins;
  if (endTime && /^\d{2}:\d{2}$/.test(endTime)) {
    const [eH, eM] = endTime.split(':').map(Number);
    const candidate = eH * 60 + eM;
    if (candidate < startMins) endMins = candidate + 24 * 60;
    else if (candidate === startMins) endMins = startMins + 60;
    else endMins = candidate;
  } else {
    endMins = startMins + 60;
  }
  const startTs = `${dateCompact}T${String(sH).padStart(2,'0')}${String(sM).padStart(2,'0')}00`;
  const daysAhead = Math.floor(endMins / (24 * 60));
  const finalH = Math.floor((endMins % (24 * 60)) / 60);
  const finalM = endMins % 60;
  let endDateCompact = dateCompact;
  if (daysAhead > 0) {
    const d = new Date(Date.UTC(
      parseInt(dateCompact.slice(0,4)),
      parseInt(dateCompact.slice(4,6)) - 1,
      parseInt(dateCompact.slice(6,8)) + daysAhead
    ));
    endDateCompact = d.toISOString().slice(0,10).replace(/-/g,'');
  }
  const endTs = `${endDateCompact}T${String(finalH).padStart(2,'0')}${String(finalM).padStart(2,'0')}00`;
  return { startTs, endTs };
}

const escIcs = s => (s || '')
  .toString()
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

// RFC 5545 §3.1: content lines longer than 75 OCTETS must be folded — split at 75 octets and
// continue with CRLF + a single space. Apple/Google tolerate unfolded lines but stricter parsers
// (Lotus Notes, some Linux mail clients) silently truncate. Counting code units is a good-enough
// approximation for the ASCII property names + mostly-ASCII trip text we emit, with one
// exception: a UTF-16 surrogate pair (emoji like 🎉 are two code units / 4 UTF-8 bytes) must
// not be split across a fold — slicing inside the pair produces a lone surrogate that the
// UTF-8 encoder turns into U+FFFD, corrupting the emoji. Back off the chunk by one when the
// boundary would land between a high and low surrogate.
function foldIcs(line) {
  if (line.length <= 75) return line;
  const parts = [];
  let i = 0;
  while (i < line.length) {
    let len = i === 0 ? 75 : 74; // continuation lines lose 1 char to the leading space
    if (i + len < line.length) {
      const lastCharCode = line.charCodeAt(i + len - 1);
      if (lastCharCode >= 0xD800 && lastCharCode <= 0xDBFF) len -= 1;
    }
    parts.push((i === 0 ? '' : ' ') + line.slice(i, i + len));
    i += len;
  }
  return parts.join('\r\n');
}

// Constant-time string compare so the public-token check doesn't leak token bytes via timing.
// (Practically infeasible to exploit against Cloud Run jitter + public internet, but the
// crypto.timingSafeEqual primitive is cheap and removes the concern entirely.)
function _timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// Cache the expected token in module scope across warm invocations so we don't pay a Firestore
// read for every poll from every device. 30 s TTL keeps revocation latency low — when Amanda
// regenerates the token (e.g. after a leak) the old token stops working within ~30 s on each
// warm instance rather than the previous 5 min.
let _tokenCache = { value: null, until: 0 };
const TOKEN_CACHE_TTL_MS = 30 * 1000;
async function _expectedToken() {
  const now = Date.now();
  if (_tokenCache.value !== null && now < _tokenCache.until) return _tokenCache.value;
  const snap = await db.collection('state').doc('settings').get();
  const tok = snap.exists ? (snap.data().icsToken || '') : '';
  _tokenCache = { value: tok, until: now + TOKEN_CACHE_TTL_MS };
  return tok;
}

exports.ics = onRequest(
  // invoker: 'public' is required for Gen 2 functions — without it Cloud Run rejects all
  // unauthenticated requests at the infra level (before the request even reaches our handler),
  // and iPhone Calendar / Google Calendar can't subscribe. Token check inside the handler is
  // the actual security boundary.
  { region: 'us-central1', cors: false, memory: '256MiB', invoker: 'public' },
  async (req, res) => {
    // Generate a short correlation id so a 500 response and its console.error log can be
    // matched up quickly without timestamp gymnastics.
    const cid = Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
    try {
      const expectedToken = await _expectedToken();

      // Token must be set in Firestore AND match the query string. No token = no access.
      const givenToken = (req.query && req.query.token) ? String(req.query.token) : '';
      if (!expectedToken || !_timingSafeEqual(givenToken, expectedToken)) {
        // Don't leak whether the token field exists vs. value mismatch — same response either way.
        res.set('Cache-Control', 'no-store');
        res.status(403).type('text/plain').send('Forbidden');
        return;
      }

      // Fetch trips + dated events in parallel — both feed the calendar.
      const [tripsSnap, eventsSnap] = await Promise.all([
        db.collection('state').doc('trips').get(),
        db.collection('state').doc('datedEvents').get(),
      ]);
      const trips = tripsSnap.exists ? (tripsSnap.data().items || []) : [];
      const events = eventsSnap.exists ? (eventsSnap.data().items || []) : [];

      const now = new Date();
      const dtstamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '').slice(0, 15) + 'Z';

      const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Our Weekly//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:Our Weekly',
        'X-PUBLISHED-TTL:PT2H',
        'REFRESH-INTERVAL;VALUE=DURATION:PT2H',
      ];

      // ── Trip events ──
      // Multi-day trips always emit as all-day (VALUE=DATE) regardless of any time field.
      // Single-day trips with a time emit as timed VEVENT (1h default duration, floating time).
      // Authoritative date is sortDate (ISO). The dates string is only used to compute the
      // end-date when it parses as a range; otherwise parseICSEndDate falls back to sortDate+1
      // (single-day all-day), so trips with freeform dates ("tonight", "Memorial Day weekend")
      // still surface on the iPhone calendar instead of being silently filtered out.
      for (const t of trips) {
        if (!t.sortDate || !t.id) continue; // Missing id → unstable UID, calendar clients dedupe
        const descParts = [];
        if (t.location) descParts.push(`Location: ${t.location}`);
        if (t.who) descParts.push(`Who: ${t.who}`);
        if (t.status) descParts.push(`Status: ${t.status}`);
        if (t.notes) descParts.push('', t.notes);
        if (Array.isArray(t.links) && t.links.length) {
          descParts.push('');
          for (const l of t.links) {
            if (l && l.url) descParts.push(`${l.label || 'Link'}: ${l.url}`);
          }
        }

        const startCompact = t.sortDate.replace(/-/g, '');
        const endCompact = parseICSEndDate(t.dates, t.sortDate);
        const isSingleDay = (() => {
          const sd = new Date(Date.UTC(
            parseInt(startCompact.slice(0,4)), parseInt(startCompact.slice(4,6)) - 1, parseInt(startCompact.slice(6,8))
          ));
          const ed = new Date(Date.UTC(
            parseInt(endCompact.slice(0,4)), parseInt(endCompact.slice(4,6)) - 1, parseInt(endCompact.slice(6,8))
          ));
          return Math.round((ed - sd) / 86400000) === 1;
        })();

        const eventLines = [
          'BEGIN:VEVENT',
          `UID:our-weekly-trip-${t.id}@ourweekly`,
          `DTSTAMP:${dtstamp}`,
        ];
        if (isSingleDay && t.time && /^\d{2}:\d{2}$/.test(t.time)) {
          const { startTs, endTs } = _buildTimedRange(startCompact, t.time, t.endTime);
          eventLines.push(`DTSTART:${startTs}`, `DTEND:${endTs}`);
        } else {
          eventLines.push(
            `DTSTART;VALUE=DATE:${startCompact}`,
            `DTEND;VALUE=DATE:${endCompact}`,
          );
        }
        eventLines.push(`SUMMARY:${escIcs(t.label)}`);
        if (descParts.length) eventLines.push(`DESCRIPTION:${escIcs(descParts.join('\n'))}`);
        if (t.location) eventLines.push(`LOCATION:${escIcs(t.location)}`);
        eventLines.push('CLASS:PRIVATE', 'CATEGORIES:Our Weekly · Trips', 'END:VEVENT');

        lines.push(...eventLines);
      }

      // ── Dated freeform events (single-day, timed or all-day) ──
      // time format: "HH:MM" (24-hour). When set, emit floating-time DTSTART/DTEND with 1h default
      // duration. When unset, emit as a VALUE=DATE all-day event. Floating time = no TZID; the
      // calendar client interprets in the device's local time, matching how Amanda enters them.
      for (const e of events) {
        if (!e || !e.date || !e.text || !e.id) continue; // Missing id → unstable UID
        const dateCompact = e.date.replace(/-/g, '');
        if (!/^\d{8}$/.test(dateCompact)) continue;
        const lineSet = [
          'BEGIN:VEVENT',
          `UID:our-weekly-evt-${e.id}@ourweekly`,
          `DTSTAMP:${dtstamp}`,
        ];
        if (e.time && /^\d{2}:\d{2}$/.test(e.time)) {
          const { startTs, endTs } = _buildTimedRange(dateCompact, e.time, e.endTime);
          lineSet.push(`DTSTART:${startTs}`, `DTEND:${endTs}`);
        } else {
          // All-day event: DTEND is exclusive (day after)
          const d = new Date(Date.UTC(
            parseInt(dateCompact.slice(0,4)), parseInt(dateCompact.slice(4,6)) - 1,
            parseInt(dateCompact.slice(6,8)) + 1
          ));
          const endDate = d.toISOString().slice(0,10).replace(/-/g,'');
          lineSet.push(`DTSTART;VALUE=DATE:${dateCompact}`, `DTEND;VALUE=DATE:${endDate}`);
        }
        lineSet.push(`SUMMARY:${escIcs(e.text)}`);
        lineSet.push('CLASS:PRIVATE', 'CATEGORIES:Our Weekly · Events', 'END:VEVENT');
        lines.push(...lineSet);
      }

      lines.push('END:VCALENDAR');

      res.set('Content-Type', 'text/calendar; charset=utf-8');
      // Private (per-user) caching only — the response body is gated by a per-couple token, so a
      // shared/CDN cache must not be allowed to serve it to anyone else who happens to have the
      // same URL. 15-min max-age balances freshness against iPhone's hourly poll rate.
      res.set('Cache-Control', 'private, max-age=900');
      // RFC 5545 §3.4: every content line must be terminated by CRLF, including the final one.
      // iCloud/Google/Apple tolerate the missing trailing CRLF, but Outlook (and other strict
      // parsers) occasionally drop the last VEVENT without it.
      res.status(200).send(lines.map(foldIcs).join('\r\n') + '\r\n');
    } catch (err) {
      console.error(`ICS feed error [cid=${cid}]`, err);
      res.set('Cache-Control', 'no-store');
      res.status(500).type('text/plain').send(`Internal error (ref ${cid})`);
    }
  }
);
