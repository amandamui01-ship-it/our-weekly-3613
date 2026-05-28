// Live .ics calendar feed for Our Weekly. Subscribed-to by iPhone/Google Calendar so trips added
// in the app appear automatically (typically refreshed every few hours by the calendar client).
//
// Access is gated by a token stored in Firestore at state/settings.icsToken. The client app reads
// the same token to display a complete subscribable URL to the user.

const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

// Mirror of the same logic in index.html — ICS DTEND for all-day events is exclusive (day AFTER
// the last day). Keep this in sync with the client implementation.
function parseICSEndDate(datesStr, sortDate) {
  const addOne = s => {
    const d = new Date(s + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  };
  if (!datesStr || !sortDate) return addOne(sortDate);
  const year = parseInt(sortDate.slice(0, 4));
  const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  const rangeMatch = datesStr.match(/[–—\-]\s*(?:([A-Za-z]+)\s+)?(\d{1,2})(?!\d)/);
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
      const d = new Date(Date.UTC(endYear, endMonth, endDay + 1));
      return d.toISOString().slice(0, 10).replace(/-/g, '');
    }
  }
  return addOne(sortDate);
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
// approximation for the ASCII property names + mostly-ASCII trip text we emit.
function foldIcs(line) {
  if (line.length <= 75) return line;
  const parts = [];
  let i = 0;
  while (i < line.length) {
    const len = i === 0 ? 75 : 74; // continuation lines lose 1 char to the leading space
    parts.push((i === 0 ? '' : ' ') + line.slice(i, i + len));
    i += len;
  }
  return parts.join('\r\n');
}

// Cache the expected token in module scope across warm invocations so we don't pay a Firestore
// read for every poll from every device. TTL is short — token regeneration takes effect within
// a few minutes for any subscribed device.
let _tokenCache = { value: null, until: 0 };
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
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
    try {
      const expectedToken = await _expectedToken();

      // Token must be set in Firestore AND match the query string. No token = no access.
      const givenToken = (req.query && req.query.token) ? String(req.query.token) : '';
      if (!expectedToken || givenToken !== expectedToken) {
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
        if (!t.sortDate) continue;
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
          const [sH, sM] = t.time.split(':').map(Number);
          const startTs = `${startCompact}T${String(sH).padStart(2,'0')}${String(sM).padStart(2,'0')}00`;
          // Use explicit endTime when set, otherwise +1h default. Handles day rollover.
          let eH, eM, endDateCompact = startCompact;
          if (t.endTime && /^\d{2}:\d{2}$/.test(t.endTime)) {
            [eH, eM] = t.endTime.split(':').map(Number);
          } else {
            eH = sH + 1; eM = sM;
          }
          if (eH >= 24) {
            eH -= 24;
            const d = new Date(Date.UTC(
              parseInt(startCompact.slice(0,4)), parseInt(startCompact.slice(4,6)) - 1,
              parseInt(startCompact.slice(6,8)) + 1
            ));
            endDateCompact = d.toISOString().slice(0,10).replace(/-/g,'');
          }
          const endTs = `${endDateCompact}T${String(eH).padStart(2,'0')}${String(eM).padStart(2,'0')}00`;
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
        if (!e || !e.date || !e.text) continue;
        const dateCompact = e.date.replace(/-/g, '');
        if (!/^\d{8}$/.test(dateCompact)) continue;
        const lineSet = [
          'BEGIN:VEVENT',
          `UID:our-weekly-evt-${e.id}@ourweekly`,
          `DTSTAMP:${dtstamp}`,
        ];
        if (e.time && /^\d{2}:\d{2}$/.test(e.time)) {
          const [sH, sM] = e.time.split(':').map(Number);
          const startTs = `${dateCompact}T${String(sH).padStart(2,'0')}${String(sM).padStart(2,'0')}00`;
          // Use explicit endTime when set; otherwise +1h default. Handles day rollover.
          let eH, eM, endDate = dateCompact;
          if (e.endTime && /^\d{2}:\d{2}$/.test(e.endTime)) {
            [eH, eM] = e.endTime.split(':').map(Number);
          } else {
            eH = sH + 1; eM = sM;
          }
          if (eH >= 24) {
            eH -= 24;
            const d = new Date(Date.UTC(
              parseInt(dateCompact.slice(0,4)), parseInt(dateCompact.slice(4,6)) - 1,
              parseInt(dateCompact.slice(6,8)) + 1
            ));
            endDate = d.toISOString().slice(0,10).replace(/-/g,'');
          }
          const endTs = `${endDate}T${String(eH).padStart(2,'0')}${String(eM).padStart(2,'0')}00`;
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
      res.status(200).send(lines.map(foldIcs).join('\r\n'));
    } catch (err) {
      console.error('ICS feed error', err);
      res.status(500).type('text/plain').send('Internal error');
    }
  }
);
