"use strict";
/* Older enterprise Edge builds predate AbortSignal.timeout (Edge 103, 2022).
   Provide it so one missing API can never take down a whole fetch path on a
   managed government machine pinned to an old browser image. */
if (typeof AbortSignal !== "undefined" && !AbortSignal.timeout) {
  AbortSignal.timeout = function (ms) {
    const ctrl = new AbortController();
    setTimeout(function () { ctrl.abort(); }, ms);
    return ctrl.signal;
  };
}
/* ============================================================
   YTZ U.S. Arrivals — live board for Billy Bishop (Toronto City)
   Data sources (all free, keyless):
     1. billybishopairport.com arrivals feed  -> schedule / ETA / status
        (fetched through public CORS-friendly readers, 60 s cycle)
     2. airplanes.live ADS-B network          -> live aircraft positions
        (20 s cycle; used to detect the actual touchdown = ATA)
   ============================================================ */

const YTZ = { lat: 43.6275, lon: -79.3962 };
const BOARD_URL = "https://www.billybishopairport.com/flights/arrivals/";
const DEPS_URL = "https://www.billybishopairport.com/flights/departures/";
const DEPS_INTERVAL_MS = 90_000;
/* Pre-parsed board JSON republished every ~5 min by a GitHub Action in this
   repo. Served from GitHub's CDN with open CORS: instant, no proxies, and it
   doesn't rate-limit when many viewers share one office IP. */
const FEED_URL = "https://raw.githubusercontent.com/MustafaSyed13/billy-bishop-arrivals/data/board.json";
const ADSB_URL = "https://api.airplanes.live/v2/point/43.6275/-79.3962/250";
const BOARD_INTERVAL_MS = 60_000;
const ADSB_BASE_MS = 15_000;      // radar poll cadence, nothing close by
const ADSB_FAST_MS = 6_000;       // radar poll cadence with an aircraft inside 80 km
const ADSB_ULTRA_MS = 3_000;      // radar poll cadence with an aircraft on final (< 25 km)
const ADSB_HIDDEN_INTERVAL_MS = 60_000;
const STORE_KEY = "ytz-ata-v1";
const BOARD_CACHE_KEY = "ytz-board-v1";
// Bumping this discards every locally-stored arrival time. Needed when a bug
// wrote wrong values, since browsers would otherwise keep showing them all day.
// v2 clears times recorded before the "must have seen it airborne" rule, which
// stamped several flights with the moment the page happened to be opened.
const ATA_EPOCH = "2";

/* Proxies tried in order; the last one that worked is tried first next time.
   jina is asked for raw HTML: the markdown view only carries the airport
   page's visible "Today" table, while the HTML holds Tomorrow rows too. */
const PROXIES = [
  // x-engine: direct skips jina's headless-browser render (~0.6 s vs 20 s cold)
  { url: (u) => `https://r.jina.ai/${u}`, headers: { "x-respond-with": "html", "x-engine": "direct" } },
  { url: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { url: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
];

/* Origin city (as spelled on the airport board) -> airport info.
   ============================================================
   THIS TABLE IS A FALLBACK ONLY. The authoritative copy lives in
   shared/airports.json and is fetched at startup by loadReferenceData(),
   which overwrites the entries below. It exists inline purely so the board
   still renders if that file cannot be fetched. Any correction must be made
   in shared/airports.json — editing here alone will be silently overwritten.
   ============================================================ */
const US_AIRPORTS = {
  "new york-newark": { code: "EWR", city: "Newark", lat: 40.6925, lon: -74.1687 },
  "newark":          { code: "EWR", city: "Newark", lat: 40.6925, lon: -74.1687 },
  "new york":        { code: "LGA", city: "New York LaGuardia", lat: 40.7772, lon: -73.8726 },
  "boston":          { code: "BOS", city: "Boston", lat: 42.3656, lon: -71.0096 },
  "chicago o'hare":  { code: "ORD", city: "Chicago O'Hare", lat: 41.9742, lon: -87.9073 },
  "chicago-o'hare":  { code: "ORD", city: "Chicago O'Hare", lat: 41.9742, lon: -87.9073 },
  "chicago-midway":  { code: "MDW", city: "Chicago Midway", lat: 41.7868, lon: -87.7522 },
  "chicago midway":  { code: "MDW", city: "Chicago Midway", lat: 41.7868, lon: -87.7522 },
  "washington-dulles": { code: "IAD", city: "Washington Dulles", lat: 38.9531, lon: -77.4565 },
  // Air Canada lists this simply as "Washington"; the operating airport is
  // Dulles, per airport staff — not National.
  "washington":      { code: "IAD", city: "Washington Dulles", lat: 38.9531, lon: -77.4565 },
  "nashville":       { code: "BNA", city: "Nashville", lat: 36.1263, lon: -86.6774 },
  "orlando":         { code: "MCO", city: "Orlando", lat: 28.4312, lon: -81.3081 },
  "tampa":           { code: "TPA", city: "Tampa", lat: 27.9755, lon: -82.5332 },
  "fort lauderdale": { code: "FLL", city: "Fort Lauderdale", lat: 26.0742, lon: -80.1506 },
  "fort myers":      { code: "RSW", city: "Fort Myers", lat: 26.5362, lon: -81.7552 },
  "west palm beach": { code: "PBI", city: "West Palm Beach", lat: 26.6832, lon: -80.0956 },
  "myrtle beach":    { code: "MYR", city: "Myrtle Beach", lat: 33.6797, lon: -78.9283 },
};

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS",
  "KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY",
  "NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV",
  "WI","WY","DC",
]);

const AIRLINES = {
  PD: { name: "Porter", cls: "pd", callsigns: ["PTR", "POE"] },
  AC: { name: "Air Canada", cls: "ac", callsigns: ["JZA", "ACA", "ROU"] },
};

/* ---------------- state ---------------- */
const state = {
  flights: [],            // parsed board rows (US only, PD/AC only)
  todayHigh: 0,           // highest Today-row-count confirmed so far today (guards against truncated re-scrapes)
  todayHighDate: null,
  arrRaw: [],             // every arrival row (all airlines) for the cancellations panel
  depRaw: [],             // every departure row
  prevArr: new Map(),     // cancellation flip detection, arrivals
  prevDep: new Map(),     // cancellation flip detection, departures
  seenAirborne: new Map(),// flight -> ms of the last fix showing it airborne. A
                          // landing time is only claimed for a transition we saw,
                          // and is interpolated across that bracket.
  cancels: [],            // today's cancellations, freshest source wins
  cancelsAt: 0,           // when that list was observed
  depsFetchedAt: 0,
  cxlOpen: true,
  focus: null,            // flight currently focused on the map (route drawn)
  focusFit: false,
  aircraft: new Map(),    // flightNo -> latest matched ADS-B sample
  ata: loadAta(),         // "YYYY-MM-DD|PD2720" -> {t: epochMs, src}
  justLanded: new Map(),  // flightNo -> epochMs, drives the green row flash
  prevStatus: new Map(),  // flightNo|day -> last board status (to catch Arrived flips)
  boardFetchedAt: 0,
  adsbFetchedAt: 0,
  boardError: null,
  adsbError: null,
  tab: "Today",
  search: "",
  expanded: new Set(),
  proxyIdx: 0,
  csCursor: 0,            // rotates long-range callsign lookups across flights
  csTry: 0,               // alternates callsign spelling candidates
};

/* ---------------- utilities ---------------- */
const $ = (id) => document.getElementById(id);

/* Replace the inline fallback tables with the canonical shared file, so the
   browser and the backend collector can never disagree about an airport. */
async function loadReferenceData() {
  try {
    const res = await fetch("shared/airports.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ref = await res.json();
    if (!ref || !ref.airports) throw new Error("malformed reference data");
    for (const k of Object.keys(US_AIRPORTS)) delete US_AIRPORTS[k];
    for (const [k, v] of Object.entries(ref.airports)) {
      US_AIRPORTS[k] = { code: v.iata, city: v.airport || v.city, lat: v.lat, lon: v.lon };
    }
    US_STATES.clear();
    for (const s of ref.usStates) US_STATES.add(s);
    for (const [k, v] of Object.entries(ref.airlines)) AIRLINES[k] = { ...AIRLINES[k], ...v };
    state.refLoaded = true;
  } catch (err) {
    // Non-fatal: the inline fallback above keeps the board usable.
    state.refError = String(err.message || err);
  }
}

function haversineKm(a, b) {
  const R = 6371, d = Math.PI / 180;
  const dLat = (b.lat - a.lat) * d, dLon = (b.lon - a.lon) * d;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function torontoDateKey(offsetDays = 0) {
  const dt = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(dt); // YYYY-MM-DD
}

function fmtClock(dt) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(dt);
}

function fmt12FromDate(dt) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto", hour: "numeric", minute: "2-digit", hour12: true,
  }).format(dt).replace(/\s/g, " ");
}

/* "13:24" (Toronto local) -> "1:24 PM" */
function fmt12(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  let h = +m[1];
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
}

function minutesOfDay(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return m ? +m[1] * 60 + +m[2] : 0;
}

/* A Toronto wall-clock "HH:MM" today, as an epoch-ms instant. Used so a board
   arrival is recorded at the time the airport published, not the time we
   happened to notice the board change. Returns null if it is not a real time or
   is implausibly far from now (which would mean a date rollover, not an
   arrival). */
function todayClockMs(hhmm) {
  if (!/^\d{1,2}:\d{2}$/.test(String(hhmm || ""))) return null;
  const diffMin = minutesOfDay(hhmm) - torontoMinutesNow();
  if (diffMin > 5 || diffMin < -12 * 60) return null;   // future, or yesterday
  return Date.now() + diffMin * 60_000;
}

function torontoMinutesNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t) => +parts.find((p) => p.type === t).value;
  return (get("hour") % 24) * 60 + get("minute");
}

function ago(ts) {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ---------------- ATA persistence ---------------- */
function loadAta() {
  try {
    if (localStorage.getItem(STORE_KEY + "-epoch") !== ATA_EPOCH) {
      localStorage.removeItem(STORE_KEY);
      localStorage.setItem(STORE_KEY + "-epoch", ATA_EPOCH);
      return {};
    }
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    const keep = {};
    const today = torontoDateKey(), yesterday = torontoDateKey(-1);
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith(today) || k.startsWith(yesterday)) keep[k] = v;
    }
    return keep;
  } catch { return {}; }
}
function saveAta() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state.ata)); } catch {}
}
function ataKey(f) {
  const date = f.day === "Tomorrow" ? torontoDateKey(1) : torontoDateKey();
  // Includes the preserved schedule so the same flight number flying twice in
  // one day (e.g. morning and afternoon PD2120) gets separate landing records.
  return `${date}|${f.flight}|${f.sched || f.time}`;
}

/* ---------------- board parsing ---------------- */
function originInfo(originText) {
  const clean = originText.trim();
  const lower = clean.toLowerCase();
  for (const key of Object.keys(US_AIRPORTS)) {
    if (lower.startsWith(key)) return US_AIRPORTS[key];
  }
  const st = /,\s*([A-Z]{2})\s*$/.exec(clean);
  if (st && US_STATES.has(st[1])) {
    return { code: "US", city: clean.replace(/,\s*[A-Z]{2}\s*$/, ""), lat: null, lon: null };
  }
  return null; // not a U.S. origin
}

function buildFlight(day, time, flightNo, origin, status, sched) {
  const prefix = flightNo.slice(0, 2);
  const airline = AIRLINES[prefix];
  if (!airline) return null;                 // drops TS/other codeshare rows
  const info = originInfo(origin);
  if (!info) return null;                    // drops non-US origins
  return {
    day, time, flight: flightNo, origin, status: status.trim(),
    schedHint: sched || null,
    airline: airline.name, airlineCls: airline.cls, callsigns: airline.callsigns,
    code: info.code, city: info.city, olat: info.lat, olon: info.lon,
  };
}

/* Raw rows (every airline, both feeds share this format). */
function parseRows(text) {
  const rows = [];
  const push = (day, time, flight, origin, status) => {
    if (!/^[A-Z]{2}\d{2,4}$/.test(flight)) return;
    if (!/^\d{1,2}:\d{2}$/.test(time)) return;
    rows.push({ day, time, flight, origin: origin.trim(), status: status.trim() });
  };
  if (text.includes("<tr")) {
    // raw HTML from a plain proxy
    const rowRe = /<tr[^>]*class=['"]item (Today|Tomorrow)['"][\s\S]*?<\/tr>/g;
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let rm;
    while ((rm = rowRe.exec(text))) {
      const tds = [];
      let tm;
      tdRe.lastIndex = 0;
      while ((tm = tdRe.exec(rm[0]))) tds.push(tm[1].replace(/<[^>]*>/g, "").trim());
      if (tds.length >= 6) push(rm[1], tds[1], tds[3], tds[4], tds[5]);
    }
  } else {
    // markdown table from the jina.ai reader
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("|")) continue;
      const c = t.split("|").map((x) => x.trim()).slice(1, -1);
      if (c.length < 6) continue;
      if (!/^(Today|Tomorrow)$/i.test(c[0])) continue;
      push(c[0][0].toUpperCase() + c[0].slice(1).toLowerCase(), c[1], c[3], c[4], c[5]);
    }
  }
  return rows;
}

/* Paint the last good board immediately on startup while fresh data loads.
   Deliberately skips applyBoard so stale statuses can't stamp false ATAs. */
function paintCachedBoard() {
  try {
    const c = JSON.parse(localStorage.getItem(BOARD_CACHE_KEY) || "null");
    if (c && Date.now() - c.t < 24 * 3_600_000 && Array.isArray(c.flights) && c.flights.length) {
      state.flights = c.flights;
      state.boardFetchedAt = c.t;
      // Restore cancellations too — but only when the cache was written on
      // the current Toronto day, so yesterday's cancellations never bleed
      // into this morning's board.
      const cacheDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" })
        .format(new Date(c.t));
      if (cacheDay === torontoDateKey() && Array.isArray(c.cancels)) {
        state.cancels = c.cancels;
        state.cancelsAt = c.cancelsAt || c.t;
      }
      render();
    }
  } catch {}
}

async function fetchViaProxies(target) {
  let lastErr = null;
  for (let i = 0; i < PROXIES.length; i++) {
    const idx = (state.proxyIdx + i) % PROXIES.length;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8_000);
      const p = PROXIES[idx];
      const res = await fetch(p.url(target), { signal: ctrl.signal, headers: p.headers || {} });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = parseRows(await res.text());
      if (!rows.length) throw new Error("no rows parsed");
      state.proxyIdx = idx;
      return rows;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("all proxies failed");
}

/* Notify (once) when a flight flips to Cancelled while we watch. */
function trackCancellations(raw, prevMap, kind) {
  for (const r of raw) {
    if (r.flight.startsWith("TS")) continue;
    const key = `${r.flight}|${r.day}`;
    const now = r.status.toLowerCase();
    const prev = prevMap.get(key);
    if (prev && prev !== "cancelled" && now === "cancelled" && r.day === "Today") {
      notify(`${torontoDateKey()}|${r.flight}|cxl`, `${r.flight} CANCELLED`,
        kind === "arrival"
          ? `Arrival from ${r.origin} - was due ${fmt12(r.time)}`
          : `Departure to ${r.origin} - was leaving ${fmt12(r.time)}`);
    }
    prevMap.set(key, now);
  }
}

/* ---------------- Supabase: the canonical source ----------------
   The backend decides landing times once, on a server, so every staff device
   shows the SAME time instead of each browser judging independently. The
   publishable key below is read-only by design (enforced by row-level security
   in the database), which is why it is safe to ship in public page code. */
// Beyond this age the backend snapshot is no longer trusted as current, and
// the client tries the live sources instead of settling for it.
const BACKEND_STALE_MS = 180_000;      // 3 minutes

// How long a landed flight stays on the board before it drops off.
const RETAIN_LANDED_MIN = 60;

const SUPA_URL = "https://crrrykfftzlzymmmawsn.supabase.co/rest/v1";
const SUPA_KEY = "sb_publishable_b5eZTW04X5TiOo_vt190Rg_rRLkz3Gf";

// Reverse lookup so a DB row's IATA code recovers the origin's coordinates
// (needed to draw the route line on the map).
const BY_CODE = {};
for (const v of Object.values(US_AIRPORTS)) if (!BY_CODE[v.code]) BY_CODE[v.code] = v;

async function fetchSupabase() {
  const res = await fetch(`${SUPA_URL}/board_state?select=payload,updated_at`, {
    headers: { apikey: SUPA_KEY },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`supabase HTTP ${res.status}`);
  const rows = await res.json();
  const payload = rows && rows[0] && rows[0].payload;
  if (!payload || !Array.isArray(payload.flights) || !payload.flights.length) {
    throw new Error("empty board_state");
  }
  return payload;
}

/* Turn one database row into the shape the rest of the board already speaks. */
function flightFromDbRow(r, todayKey) {
  const airline = AIRLINES[String(r.flight_no || "").slice(0, 2)];
  if (!airline) return null;
  const info = BY_CODE[r.origin_code] ||
    { code: r.origin_code || "US", city: r.origin_city || "", lat: null, lon: null };
  return {
    day: r.service_date === todayKey ? "Today" : "Tomorrow",
    time: r.est_local || r.sched_local || "",
    flight: r.flight_no,
    origin: r.origin_city || info.city,
    status: (r.status || "").trim(),
    schedHint: r.sched_local || null,
    airline: airline.name,
    airlineCls: airline.cls,
    callsigns: airline.callsigns,
    code: info.code,
    city: info.city || r.origin_city || "",
    olat: info.lat ?? null,
    olon: info.lon ?? null,
  };
}

/* Cancellations were flaky because they lived in exactly one source: refresh
   while that source lagged and the panel came up empty or half-full. Now every
   source derives them, the freshest set wins, and the result is cached — so
   they can never vanish on a refresh again. */
function deriveCancels(arrRows, depRows) {
  const out = [];
  const push = (r, direction) => {
    if (!r || r.day !== "Today" || String(r.flight || "").startsWith("TS")) return;
    if ((r.status || "").toLowerCase() !== "cancelled") return;
    out.push({ flight: r.flight, time: r.time, origin: r.origin, direction,
      us: !!originInfo(r.origin || "") });
  };
  for (const r of arrRows || []) push(r, "arrival");
  for (const r of depRows || []) push(r, "departure");
  return out;
}

function adoptCancels(list, at) {
  if (!Array.isArray(list) || at <= (state.cancelsAt || 0)) return;
  state.cancels = list;
  state.cancelsAt = at;
}

function applySupabase(payload) {
  const t = Date.parse(payload.generated_at) || 0;
  if (!t) return false;
  // Adopt the backend's cancellation list BEFORE any freshness early-return:
  // even when its flight list is older than what we hold, its cancellations
  // are still better than an empty panel.
  if (Array.isArray(payload.cancellations)) {
    adoptCancels(payload.cancellations.map((c) => ({
      flight: c.flight, time: c.time, origin: c.origin,
      direction: c.direction || "departure",
      us: c.us !== undefined ? c.us : !!originInfo(c.origin || ""),
    })), t);
  }
  // Older than what we already hold: ignore it.
  if (t < state.boardFetchedAt) return false;
  // Exactly what we already painted from cache: we're current, so report
  // success rather than pointlessly falling through to the slower sources.
  if (t === state.boardFetchedAt && state.flights.length) return true;
  const todayKey = torontoDateKey();
  const flights = payload.flights.map((r) => flightFromDbRow(r, todayKey)).filter(Boolean);
  if (!flights.length) return false;

  applyBoard(flights);   // preserves schedules, keeps the truncation guard active

  // Adopt the server's landing times as authoritative. This is the whole point
  // of the backend: one recorded touchdown, identical on every device.
  for (const r of payload.flights) {
    if (!r.touchdown_at) continue;
    const f = flights.find((x) => x.flight === r.flight_no &&
      x.day === (r.service_date === todayKey ? "Today" : "Tomorrow"));
    if (!f) continue;
    const ms = Date.parse(r.touchdown_at);
    if (!ms) continue;
    state.ata[ataKey(f)] = { t: ms, src: r.touchdown_source === "adsb" ? "radar" : "board" };
  }
  saveAta();

  // Feed the cancellations panel the same way the old path did.
  state.arrRaw = payload.flights.map((r) => ({
    day: r.service_date === todayKey ? "Today" : "Tomorrow",
    time: r.est_local || r.sched_local || "",
    flight: r.flight_no, origin: r.origin_city || "", status: r.status || "",
  }));
  state.depsFetchedAt = t;   // cancellations were already adopted above

  state.boardFetchedAt = t;
  state.boardError = null;
  try { localStorage.setItem(BOARD_CACHE_KEY, JSON.stringify({ t, flights, cancels: state.cancels, cancelsAt: state.cancelsAt })); } catch {}
  return true;
}

async function fetchFeed() {
  // 2-minute buckets bust the raw CDN cache without a unique URL per request.
  const bucket = Math.floor(Date.now() / 120_000);
  const res = await fetch(`${FEED_URL}?t=${bucket}`);
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  const j = await res.json();
  if (!j || !Array.isArray(j.arrivals) || !j.arrivals.length) throw new Error("bad feed");
  return j;
}

/* Apply a feed snapshot unless we already hold fresher data. */
function applyFeed(j) {
  const t = Date.parse(j.fetchedAt) || 0;
  if (!t || t <= state.boardFetchedAt) return false;
  const flights = j.arrivals.map((r) => buildFlight(r.day, r.time, r.flight, r.origin, r.status, r.sched)).filter(Boolean);
  applyBoard(flights);
  state.arrRaw = j.arrivals;
  trackCancellations(j.arrivals, state.prevArr, "arrival");
  if (Array.isArray(j.departures) && j.departures.length) {
    state.depRaw = j.departures;
    trackCancellations(j.departures, state.prevDep, "departure");
    state.depsFetchedAt = t;
  }
  adoptCancels(deriveCancels(j.arrivals, j.departures), t);
  state.boardFetchedAt = t;
  state.boardError = null;
  try { localStorage.setItem(BOARD_CACHE_KEY, JSON.stringify({ t, flights, cancels: state.cancels, cancelsAt: state.cancelsAt })); } catch {}
  return true;
}

async function fetchBoard() {
  // Three sources, most authoritative first. Supabase carries the canonical
  // landing times; the others exist so the board can never go blank if the
  // backend is unreachable.
  // The backend is canonical, but only while it is actually current. Its
  // collector runs on GitHub's free scheduler, which throttles hard — observed
  // gaps of over two hours. Treating "the server answered" as success meant a
  // three-hour-old snapshot silently beat a live scrape. So: use the backend
  // immediately either way, but if it is stale, keep going and try to upgrade
  // it with fresher data rather than stopping here.
  try {
    const payload = await fetchSupabase();
    const applied = applySupabase(payload);
    const age = Date.now() - (Date.parse(payload.generated_at) || 0);
    if (applied) render();             // paint what we have straight away
    if (applied && age < BACKEND_STALE_MS) return;   // fresh: nothing better available
  } catch (_) { /* fall through to the older paths */ }

  // Feed first: paints in ~200 ms. The live scrape below is fresher but slow
  // and rate-limited, so it upgrades the data in the background when it works.
  const feedP = fetchFeed().catch(() => null);
  feedP.then((j) => { if (j && applyFeed(j)) render(); });
  try {
    const raw = await fetchViaProxies(`${BOARD_URL}?_=${Date.now()}`);
    const flights = raw.map((r) => buildFlight(r.day, r.time, r.flight, r.origin, r.status, r.sched)).filter(Boolean);
    applyBoard(flights);
    state.arrRaw = raw;
    trackCancellations(raw, state.prevArr, "arrival");
    adoptCancels(deriveCancels(raw, state.depRaw), Date.now());
    state.boardFetchedAt = Date.now();
    state.boardError = null;
    try {
      localStorage.setItem(BOARD_CACHE_KEY, JSON.stringify({ t: Date.now(), flights, cancels: state.cancels, cancelsAt: state.cancelsAt }));
    } catch {}
  } catch (e) {
    // Live scrape failed; if the feed covered us recently, that's not an error
    // worth alarming the user about.
    const j = await feedP;
    if (!j && Date.now() - state.boardFetchedAt > 20 * 60_000) {
      state.boardError = String(e.message || e);
    }
  }
  render();
}

async function fetchDeps() {
  try {
    const raw = await fetchViaProxies(`${DEPS_URL}?_=${Date.now()}`);
    state.depRaw = raw;
    trackCancellations(raw, state.prevDep, "departure");
    adoptCancels(deriveCancels(state.arrRaw, raw), Date.now());
    state.depsFetchedAt = Date.now();
  } catch {} // panel simply shows arrivals-only when the departures feed is down
  render();
}

/* The airport's time cell mutates into the new/estimated time when a flight
   is delayed. Preserve the first schedule we ever saw for each flight+date so
   the Sched column stays the original plan (provenance: first_seen, or
   tomorrow_snapshot when we captured it the day before). */
const SCHED_KEY = "ytz-sched-v1";
let schedStore;
try { schedStore = JSON.parse(localStorage.getItem(SCHED_KEY) || "{}"); } catch { schedStore = {}; }

function preserveSched(f) {
  const date = f.day === "Tomorrow" ? torontoDateKey(1) : torontoDateKey();
  const k = `${date}|${f.flight}`;
  // The feed's remembered schedule beats anything this device first saw,
  // because the data robot captures Tomorrow's plan the evening before.
  if (f.schedHint && (!schedStore[k] || schedStore[k].src !== "feed")) {
    schedStore[k] = { t: f.schedHint, src: "feed" };
  } else if (!schedStore[k]) {
    schedStore[k] = { t: f.time, src: f.day === "Tomorrow" ? "tomorrow_snapshot" : "first_seen" };
  }
  return schedStore[k];
}

function pruneSchedStore() {
  const keep = new Set([torontoDateKey(), torontoDateKey(1)]);
  for (const k of Object.keys(schedStore)) {
    if (!keep.has(k.split("|")[0])) delete schedStore[k];
  }
  try { localStorage.setItem(SCHED_KEY, JSON.stringify(schedStore)); } catch {}
}

function applyBoard(flights) {
  // Two independent sources feed this function (the fast GitHub data feed and
  // a live scrape via CORS proxies), and either can win the race on any given
  // fetch. A proxy hiccup can return a truncated-but-parseable page, which
  // must never be allowed to silently erase flights we already confirmed.
  // Track the highest Today-row-count seen since Toronto's date last changed,
  // and reject any batch that comes in suspiciously below it.
  const nowDate = torontoDateKey();
  if (state.todayHighDate !== nowDate) {
    state.todayHighDate = nowDate;
    state.todayHigh = 0;
  }
  const todayCount = flights.filter((f) => f.day === "Today").length;
  if (state.todayHigh >= 4 && todayCount < state.todayHigh * 0.7) {
    return; // looks like a partial parse; keep the fuller data already held
  }
  state.todayHigh = Math.max(state.todayHigh, todayCount);

  for (const f of flights) {
    const s = preserveSched(f);
    f.sched = s.t;
    f.schedSrc = s.src;
  }
  pruneSchedStore();
  for (const f of flights) {
    const key = `${f.flight}|${f.day}`;
    const prev = state.prevStatus.get(key);
    const now = f.status.toLowerCase();
    // Board flipped to "Arrived" while we watch and radar never caught the
    // touchdown -> stamp an approximate ATA at the moment of the flip.
    if (prev && prev !== "arrived" && now === "arrived" && !state.ata[ataKey(f)]) {
      // Use the time the airport published, not the moment we spotted the
      // change. The board can take several minutes to flip, and charging that
      // lag to the flight is what made these times read late.
      const t = todayClockMs(f.time) ?? Date.now();
      state.ata[ataKey(f)] = { t, src: "board" };
      saveAta();
      state.justLanded.set(f.flight, Date.now());
      notify(`${ataKey(f)}|landed`, `${f.flight} landed at YTZ`,
        `Airport board marked it arrived at ${fmt12FromDate(new Date(t))}`);
    }
    state.prevStatus.set(key, now);
  }
  state.flights = flights;
}

/* ---------------- ADS-B live layer ---------------- */
function matchAircraft(flight, acList) {
  const digits = flight.flight.replace(/\D/g, "");
  const wanted = new Set();
  for (const p of flight.callsigns) {
    wanted.add(p + digits);
    // Jazz sometimes drops the leading marketing digit (AC8548 -> JZA548)
    if (p === "JZA" && digits.length === 4) wanted.add(p + digits.slice(1));
  }
  let best = null;
  for (const ac of acList) {
    const cs = (ac.flight || "").trim().toUpperCase();
    if (!wanted.has(cs)) continue;
    if (ac.lat == null || ac.lon == null) continue;
    // Every scheduled YTZ arrival is a Dash 8; reject look-alike callsigns.
    if (ac.t && !/^DH8/.test(ac.t) && cs !== flight.callsigns[0] + digits) continue;
    if (!best || (ac.seen_pos ?? 99) < (best.seen_pos ?? 99)) best = ac;
  }
  return best;
}

/* Record one radar sample for a matched flight and run the alert/touchdown
   logic. Shared by the local point query and the long-range callsign lookups. */
function ingestAircraft(f, ac) {
  const dist = haversineKm({ lat: ac.lat, lon: ac.lon }, YTZ);
  const grounded = ac.alt_baro === "ground" ||
    (typeof ac.alt_baro === "number" && ac.alt_baro < 400 && (ac.gs ?? 999) < 80);
  const sample = {
    cs: (ac.flight || "").trim(), reg: ac.r || "—", type: ac.t || "—",
    hex: ac.hex, alt: ac.alt_baro, gs: ac.gs ?? null, dist, grounded, ts: Date.now(),
    lat: ac.lat, lon: ac.lon, track: ac.track ?? ac.true_heading ?? 0,
  };
  state.aircraft.set(f.flight, sample);
  // Alert once when the aircraft turns final (inside 12 km, still flying).
  if (!grounded && dist < 12 && (ac.gs ?? 0) > 60) {
    const mins = Math.max(2, Math.round((dist / ((ac.gs || 200) * 1.852)) * 60 + 3));
    notify(`${ataKey(f)}|final`, `${f.flight} on final approach`,
      `${f.city} to YTZ - about ${mins} min to touchdown`);
  }
  // Remember that we genuinely saw this aircraft flying. Without this, opening
  // the page at 13:52 and finding three aircraft already parked stamped all
  // three as "landed 13:52" — the time WE noticed, not the time they landed.
  // FlightAware had one of them down at 13:27, a 25 minute error.
  if (!grounded && (ac.gs ?? 0) > 40) state.seenAirborne.set(f.flight, Date.now());

  // Touchdown detection: an airborne aircraft we were watching is now on the
  // ground at the field. The distance gate stops a pre-departure aircraft at
  // its origin counting; the airborne gate stops an aircraft that was already
  // parked before we ever looked. If we never saw it fly, we do not know when
  // it landed — so we say nothing and let the airport's own time stand.
  const airborneAt = state.seenAirborne.get(f.flight);
  if (grounded && dist <= 4.5 && !state.ata[ataKey(f)] && airborneAt) {
    // The aircraft came down somewhere between that last airborne fix and now.
    // Report the midpoint, not "now" — with a 20 s poll that is a handful of
    // seconds of error, and after a tab has been backgrounded it halves the
    // gap instead of charging all of it to the flight.
    const gapMs = Date.now() - airborneAt;
    if (gapMs <= 10 * 60_000) {
      const t = airborneAt + gapMs / 2;
      state.ata[ataKey(f)] = { t, src: "radar" };
      saveAta();
      state.justLanded.set(f.flight, Date.now());
      notify(`${ataKey(f)}|landed`, `${f.flight} landed at YTZ`,
        `Touched down at ${fmt12FromDate(new Date(t))} from ${f.city}`);
    }
  }
}

/* The point query only sees ~460 km around YTZ, but LGA/BOS/ORD are farther.
   For flights due soon that aren't tracked yet, look their callsigns up
   directly (two per poll, rotating) so tracking starts at takeoff. */
async function lookupDistantFlights() {
  const nowMin = torontoMinutesNow();
  const pending = state.flights.filter((f) => {
    if (f.day !== "Today") return false;
    const st = f.status.toLowerCase();
    if (st === "cancelled" || st === "arrived" || state.ata[ataKey(f)]) return false;
    const s = state.aircraft.get(f.flight);
    if (s && Date.now() - s.ts < 60_000) return false;
    const dm = minutesOfDay(f.time) - nowMin;
    return dm > -20 && dm < 160;
  });
  if (!pending.length) return;
  for (let k = 0; k < Math.min(2, pending.length); k++) {
    const f = pending[(state.csCursor + k) % pending.length];
    const digits = f.flight.replace(/\D/g, "");
    const cands = f.airlineCls === "pd"
      ? ["PTR" + digits, "POE" + digits]
      : ["JZA" + digits.slice(1), "JZA" + digits];
    const cand = cands[state.csTry % cands.length];
    try {
      const r = await fetch(`https://api.airplanes.live/v2/callsign/${cand}`);
      if (!r.ok) continue;
      const d = await r.json();
      const ac = matchAircraft(f, d.ac || []);
      if (ac) ingestAircraft(f, ac);
    } catch {}
  }
  state.csCursor += 2;
  state.csTry++;
}

async function fetchAdsb() {
  try {
    const res = await fetch(ADSB_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = data.ac || [];
    for (const f of state.flights) {
      if (f.day !== "Today") continue;
      if (f.status.toLowerCase() === "cancelled") continue;
      const ac = matchAircraft(f, list);
      if (ac) ingestAircraft(f, ac);
    }
    await lookupDistantFlights();
    state.adsbFetchedAt = Date.now();
    state.adsbError = null;
  } catch (e) {
    state.adsbError = String(e.message || e);
  }
  updateMap();
  render();
}

/* ---------------- derived per-flight view ---------------- */
function minsUntilBoardTime(f) {
  let diff = minutesOfDay(f.time) - torontoMinutesNow();
  if (f.day === "Tomorrow") diff += 1440;
  return diff;
}

function fmtDur(min) {
  min = Math.round(min);
  if (min <= 0) return "due now";
  if (min < 60) return `in ${min} min`;
  return `in ${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} m`;
}

/* Minutes-since-Toronto-midnight for an epoch, used for ordering. */
function torontoMinutesOf(epoch) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(epoch));
  const get = (t) => +parts.find((p) => p.type === t).value;
  return (get("hour") % 24) * 60 + get("minute");
}

/* The time a flight is really expected on the ground: its recorded touchdown
   if it has landed, else the live radar prediction, else the airport's own
   current estimate. This is what the board is sorted by. */
function arrivalOrderMinutes(f) {
  // A cancelled flight has no meaningful expected arrival. The airport often
  // leaves a stale or drifted estimate on the row, which was throwing e.g. a
  // 3:05 PM cancellation down between the 5:55 and 6:48 arrivals. Hold it in
  // its originally scheduled slot so staff can see which slot went away.
  if ((f.status || "").toLowerCase() === "cancelled") {
    return minutesOfDay(f.sched || f.time);
  }
  const ata = state.ata[ataKey(f)];
  if (ata) return torontoMinutesOf(ata.t);
  const ac = state.aircraft.get(f.flight);
  if (ac && !ac.grounded && (ac.gs ?? 0) > 40 && Date.now() - ac.ts < 90_000) {
    const etaEpoch = ac.ts + ((ac.dist / (ac.gs * 1.852)) * 60 + 4) * 60_000;
    return torontoMinutesOf(etaEpoch);
  }
  return minutesOfDay(f.time);        // airport's live estimate
}

/* Minutes since a flight finished, or null if it hasn't. Uses the recorded
   arrival when we have one, otherwise the airport's own arrival time. Only
   applies to today — "Tomorrow" has nothing completed. */
function completedMinutesAgo(f) {
  if (f.day !== "Today") return null;
  const ata = state.ata[ataKey(f)];
  if (ata && ata.t) return (Date.now() - ata.t) / 60_000;
  if ((f.status || "").toLowerCase() === "arrived") {
    const mins = torontoMinutesNow() - minutesOfDay(f.time);
    // Guard the midnight wrap: a large negative means the arrival time is
    // "later today" only because the clock has rolled past it.
    return mins >= 0 ? mins : null;
  }
  return null;
}

function viewOf(f) {
  const st = f.status.toLowerCase();
  const ata = state.ata[ataKey(f)];
  const ac = state.aircraft.get(f.flight);
  const acFresh = ac && Date.now() - ac.ts < 90_000;

  const v = {
    schedTxt: fmt12(f.sched || f.time),
    schedSrc: f.schedSrc === "feed" ? "original published schedule"
      : f.schedSrc === "tomorrow_snapshot" ? "captured from yesterday's schedule"
      : "schedule as first published",
    etaMain: fmt12(f.time), etaSub: "", etaLive: false,
    ataTxt: "—", ataNote: "", ataApprox: false,
    statusTxt: f.status, statusCls: "ontime",
    ac: acFresh ? ac : null,
  };

  if (st === "cancelled") {
    v.statusCls = "cancelled";
    v.etaMain = "CANCELLED";
    v.etaSub = `was ${fmt12(f.sched || f.time)}`;
    return v;
  }

  const landed = !!ata || st === "arrived";

  if (landed) {
    v.statusTxt = "Landed"; v.statusCls = "landed";
    if (ata) {
      const t = new Date(ata.t);
      if (ata.src === "radar") {
        v.ataTxt = fmt12FromDate(t);
        v.ataNote = "Observed · ADS-B ground detection";
      } else {
        v.ataTxt = fmt12FromDate(t);
        v.ataApprox = true; v.ataNote = "Airport reported · approximate";
      }
    } else {
      // Arrived before we started watching: the airport's time column holds
      // its latest (actual-ish) arrival time.
      v.ataTxt = fmt12(f.time);
      v.ataApprox = true; v.ataNote = "Airport reported · approximate";
    }
    v.etaMain = v.ataTxt;
    v.etaSub = v.ataNote;
    return v;
  }

  // Delay against the original schedule, so the status word is honest even
  // when the airport is slow to relabel a flight.
  const schedM = minutesOfDay(f.sched || f.time);
  const estM = minutesOfDay(f.time);
  const lateBy = estM - schedM;

  // Status is computed from the airport's own two numbers (original schedule
  // vs current estimate) rather than copied from its status word, because the
  // two can disagree — a flight estimated 5 min after schedule was still
  // labelled "Early". Arithmetic on published times is self-consistent; the
  // airport's label is only used when a time is missing or unparseable.
  const haveTimes = /^\d{1,2}:\d{2}$/.test(f.sched || f.time) && /^\d{1,2}:\d{2}$/.test(f.time);
  if (haveTimes && lateBy >= 1) {
    v.statusCls = "delayed";
    v.statusTxt = `Late ${lateBy} min`;
  } else if (haveTimes && lateBy <= -1) {
    v.statusCls = "early";
    v.statusTxt = `Early ${Math.abs(lateBy)} min`;
  } else if (haveTimes) {
    v.statusTxt = "On Time";
  } else if (st === "delayed" || st === "late") {
    v.statusCls = "delayed";
    v.statusTxt = f.status || "Delayed";
  } else if (st === "early") {
    v.statusCls = "early";
    v.statusTxt = "Early";
  } else {
    v.statusTxt = f.status || "Scheduled";
  }

  if (acFresh && !ac.grounded && ac.gs > 40) {
    // Predicted touchdown from the live position: distance over ground speed
    // plus an approach-pattern buffer. Counts down between radar polls.
    // Uncertainty bands are honest estimates by distance, not guarantees.
    const etaEpoch = ac.ts + ((ac.dist / (ac.gs * 1.852)) * 60 + 4) * 60_000;
    const remain = (etaEpoch - Date.now()) / 60_000;
    const unc = ac.dist < 8 ? "±1 min" : ac.dist < 25 ? "±3 min" : ac.dist < 80 ? "±5 min" : "±10 min";
    const clock = fmt12FromDate(new Date(etaEpoch));
    // Under an hour out, minutes are what staff actually need; beyond that a
    // clock time is easier to plan around than "in 3 h 41 m".
    if (remain < 60) {
      v.etaMain = fmtDur(remain);
      v.etaSub = `${clock} · ADS-B prediction ${unc} · ${Math.round(ac.dist)} km out`;
    } else {
      v.etaMain = clock;
      v.etaSub = `ADS-B prediction ${unc} · ${Math.round(ac.dist)} km out`;
    }
    v.etaLive = true;
    v.statusTxt = ac.dist < 12 ? "On final" : ac.dist < 60 ? "Approaching" : "In flight";
    v.statusCls = "inflight";
  } else {
    // No airborne radar contact: fall back to the airport's own estimate.
    const dm = minsUntilBoardTime(f);
    const clock = fmt12(f.time);
    if (dm >= -2 && dm < 60) {
      v.etaMain = fmtDur(dm);
      v.etaSub = acFresh && ac.grounded && ac.dist > 60
        ? `${clock} · on the ground at ${f.code}`
        : `${clock} · Airport estimate`;
    } else {
      v.etaMain = clock;
      v.etaSub = acFresh && ac.grounded && ac.dist > 60
        ? `on the ground at ${f.code}`
        : (dm >= -2 ? "Airport estimate" : "Airport estimate · awaiting update");
    }
  }
  return v;
}

/* ---------------- rendering ---------------- */
/* FlightAware indexes these flights by ICAO designator + full flight number:
   AC8531 -> JZA8531, PD2938 -> POE2938. The live radar callsign sometimes
   drops a digit (JZA531) and 404s on FlightAware, so always build this form. */
function faIdent(f) {
  return (f.airlineCls === "pd" ? "POE" : "JZA") + f.flight.replace(/\D/g, "");
}

/* Flightradar24 has two different pages, and sending people to the wrong one is
   why the link "went to history instead of the flight".

     /data/flights/pd2938   flight HISTORY - past dates, no live aircraft
     /PTR2938               the LIVE map, aircraft selected

   The live page is keyed on the CALLSIGN the transponder is broadcasting, not
   the marketing flight number, and the two differ. Porter uses two blocks:
   PTR for the Dash 8 turboprops and POE for the Embraer E195-E2 jets, so the
   prefix cannot be assumed from the airline either. We already receive the real
   callsign over ADS-B, so use that and stop guessing.

   When nothing is in the air, the history page IS the correct destination -
   a live map link for a flight that is not flying shows an empty map. */
function fr24Url(f) {
  const s = state.aircraft.get(f.flight);
  // Use the callsign page whenever we have actually seen this aircraft recently,
  // airborne or just down. Flightradar24 keeps a flight selectable for a while
  // after landing, so this still lands on the flight itself rather than the
  // archive. Only when we have no recent sighting at all is the history page
  // the only thing that exists to link to.
  const seenRecently = s && s.cs && Date.now() - s.ts < 45 * 60_000;
  return seenRecently
    ? `https://www.flightradar24.com/${encodeURIComponent(s.cs)}`
    : `https://www.flightradar24.com/data/flights/${encodeURIComponent(f.flight.toLowerCase())}`;
}

function render() {
  const rows = $("rows");
  const q = state.search.trim().toLowerCase();
  // Drop flights that finished more than an hour ago: once a flight has
  // landed and been processed it is just clutter on an operational board.
  // Searching still reaches them, so nothing is truly lost.
  let retired = 0;
  const list = state.flights
    .filter((f) => f.day === state.tab)
    .filter((f) => {
      if (q) return true;                       // a search should find anything
      const done = completedMinutesAgo(f);
      if (done !== null && done > RETAIN_LANDED_MIN) { retired++; return false; }
      return true;
    })
    .filter((f) => !q ||
      f.flight.toLowerCase().includes(q) ||
      f.origin.toLowerCase().includes(q) ||
      f.code.toLowerCase().includes(q) ||
      f.airline.toLowerCase().includes(q))
    // Ordered by when each flight is ACTUALLY expected to arrive, so a flight
    // delayed from 16:00 to 18:00 drops below the 17:00 arrival — the order
    // staff need to work the hall, not the order originally scheduled.
    .sort((a, b) => arrivalOrderMinutes(a) - arrivalOrderMinutes(b));

  let html = "";
  for (const f of list) {
    const v = viewOf(f);
    const rowCls = ["flight-row"];
    if (v.statusCls === "landed") rowCls.push("landed");
    if (v.statusCls === "cancelled") rowCls.push("cancelled");
    const jl = state.justLanded.get(f.flight);
    if (jl && Date.now() - jl < 8_000) rowCls.push("flash");
    html += `
<tr class="${rowCls.join(" ")}" data-flight="${esc(f.flight)}">
  <td class="sched" title="${esc(v.schedSrc)}">${v.schedTxt}</td>
  <td class="flightno"><a href="https://www.flightaware.com/live/flight/${esc(faIdent(f))}" target="_blank" rel="noopener noreferrer" title="Track ${esc(f.flight)} on FlightAware">${esc(f.flight)}</a><a class="fr-badge" href="${esc(fr24Url(f))}" target="_blank" rel="noopener noreferrer" title="Track ${esc(f.flight)} on Flightradar24">FR24</a></td>
  <td class="airline"><svg class="airline-logo ${f.airlineCls}" role="img" aria-label="${esc(f.airline)}"><use href="#${f.airlineCls === "pd" ? "porter-logo" : "aircanada-logo"}"></use></svg></td>
  <td class="from"><span class="code">${esc(f.code)}</span><span class="city">${esc(f.city)}</span></td>
  <td class="eta${v.etaLive ? " live" : ""}${v.ataApprox ? " approx" : ""}${v.statusCls === "cancelled" ? " cxl" : ""}"><span class="eta-main">${esc(v.etaMain)}</span>${v.etaSub ? `<span class="eta-note">${esc(v.etaSub)}</span>` : ""}</td>
  <td class="status"><span class="chip ${v.statusCls}">${esc(v.statusTxt)}</span></td>

</tr>`;
    if (state.expanded.has(f.flight)) html += detailRow(f, v);
  }

  rows.innerHTML = html || `<td colspan="6" class="empty">${
    state.boardFetchedAt
      ? (q ? "No flights match your search." : `No U.S. arrivals listed for ${state.tab.toLowerCase()}.`)
      : state.boardError
        ? "Could not reach the arrivals feed — retrying automatically…"
        : "Loading arrivals…"
  }</td>`;

  // freshness / live indicator
  const fr = $("freshness");
  fr.textContent =
    `board ${state.boardFetchedAt ? ago(state.boardFetchedAt) + " ago" : "…"}` +
    ` · radar ${state.adsbFetchedAt ? ago(state.adsbFetchedAt) + " ago" : "…"}` +
    // Say so rather than letting flights silently disappear.
    (retired ? ` · ${retired} cleared over ${RETAIN_LANDED_MIN} min ago hidden` : "");
  // Health is reported per source rather than as one blanket "LIVE", so a
  // current radar feed can never make a stale flight board look healthy.
  const live = $("liveDot").parentElement;
  const boardAge = Date.now() - state.boardFetchedAt;
  const radarAge = Date.now() - state.adsbFetchedAt;
  const boardStale = boardAge > 5 * 60_000;
  const boardDead = boardAge > 20 * 60_000;
  const radarStale = !state.adsbFetchedAt || radarAge > 90_000;

  live.classList.toggle("down", (!state.boardFetchedAt && !!state.boardError) || boardDead);
  live.classList.toggle("stale", !!state.boardFetchedAt && (boardStale || radarStale) && !boardDead);
  $("liveLabel").textContent =
    !state.boardFetchedAt && state.boardError ? "OFFLINE"
      : boardDead ? "DATA STALE"
      : boardStale ? "FLIGHT DATA DELAYED"
      : radarStale ? "RADAR DEGRADED"
      : "ALL SOURCES LIVE";
  live.title =
    `Flight board: ${state.boardFetchedAt ? ago(state.boardFetchedAt) + " old" : "unavailable"}\n` +
    `Radar: ${state.adsbFetchedAt ? ago(state.adsbFetchedAt) + " old" : "unavailable"}`;

  const banner = $("banner");
  if (state.boardError && state.boardFetchedAt) {
    banner.hidden = false;
    banner.textContent = "Arrivals feed temporarily unreachable — showing last good data, retrying every minute.";
  } else banner.hidden = true;

  renderCancellations();
}

/* Cancelled U.S. flights today, inbound and outbound.
   Deliberately U.S. only: domestic flights do not clear customs, so a
   within-Canada cancellation is noise for this hall. An empty panel is a real
   answer here — "no U.S. cancellations today" — not a failure. */
function renderCancellations() {
  // One path only. state.cancels is maintained by every data source through
  // adoptCancels() and survives refreshes via the board cache, so this render
  // can never come up empty just because one particular source was slow.
  const items = (state.cancels || [])
    .filter((c) => c.us)
    .map((c) => ({
      flight: c.flight, time: c.time, origin: c.origin,
      kind: c.direction === "arrival" ? "ARRIVAL" : "DEPARTURE",
      prep: c.direction === "arrival" ? "from" : "to",
      us: true,
    }))
    .sort((a, b) => minutesOfDay(a.time) - minutesOfDay(b.time));
  $("cxlCount").textContent = items.length;
  $("cxlEmpty").hidden = !!items.length;
  const btn = $("alertsBtn");
  btn.innerHTML = `Alerts`;
  btn.classList.toggle("warn", items.length > 0);
  const list = $("cxlList");
  list.hidden = !items.length;
  list.innerHTML = items.map((r) => {
    const cls = r.flight.startsWith("PD") ? "pd" : r.flight.startsWith("AC") ? "ac" : "";
    const logo = cls
      ? `<svg class="airline-logo ${cls}" role="img"><use href="#${cls === "pd" ? "porter-logo" : "aircanada-logo"}"></use></svg>`
      : "";
    return `<div class="cxl-item${r.us ? " us" : " dom"}">
      <span class="fno">${esc(r.flight)}</span>
      <span class="dir">${r.kind}</span>
      ${logo}
      <span class="route">${r.prep} ${esc(r.origin)}</span>
      <span class="region">${r.us ? "U.S." : "DOMESTIC"}</span>
      <span class="was">was ${esc(fmt12(r.time))}</span>
    </div>`;
  }).join("");
}

function detailRow(f, v) {
  const ac = v.ac;
  let tele;
  if (ac) {
    const altTxt = ac.alt === "ground" ? "on ground" :
      typeof ac.alt === "number" ? `${ac.alt.toLocaleString()} ft` : "—";
    const spdTxt = ac.gs != null ? `${Math.round(ac.gs * 1.852)} km/h` : "—";
    let progress = "";
    if (f.olat != null) {
      const total = haversineKm({ lat: f.olat, lon: f.olon }, YTZ);
      const pct = Math.min(100, Math.max(2, 100 * (1 - ac.dist / total)));
      progress = `
<div class="progress">
  <div class="bar"><div class="fill" style="width:${pct.toFixed(1)}%"></div><span class="plane" style="left:${pct.toFixed(1)}%">✈</span></div>
  <div class="ends"><span>${esc(f.code)}</span><span>YTZ</span></div>
</div>`;
    }
    tele = `
<div class="tele">
  <div class="kv"><label>Callsign</label><b>${esc(ac.cs)}</b></div>
  <div class="kv"><label>Aircraft</label><b>${esc(ac.type)}</b> ${esc(ac.reg)}</div>
  <div class="kv"><label>Altitude</label><b>${esc(altTxt)}</b></div>
  <div class="kv"><label>Speed</label><b>${esc(spdTxt)}</b></div>
  <div class="kv"><label>Distance</label><b>${Math.round(ac.dist)} km</b></div>
  ${progress}
</div>`;
  } else {
    const st = f.status.toLowerCase();
    if (st === "arrived" || state.ata[ataKey(f)]) {
      let txt = `Landed at ${v.ataTxt} from ${esc(f.city)}.`;
      // The same route usually turns around: surface the next departure there.
      const nowMin = torontoMinutesNow();
      const nd = state.depRaw.find((d) =>
        d.day === "Today" && !d.flight.startsWith("TS") && d.origin === f.origin &&
        !/^(departed|cancelled)$/i.test(d.status) && minutesOfDay(d.time) > nowMin - 10);
      if (nd) txt += ` Next departure to ${esc(f.city)}: ${esc(nd.flight)} at ${fmt12(nd.time)} (${esc(nd.status)}).`;
      tele = txt;
    } else if (st === "cancelled") {
      tele = "Flight cancelled.";
    } else {
      const dm = minsUntilBoardTime(f);
      tele = dm > 5
        ? `Hasn't taken off yet — estimated to land at YTZ at ${fmt12(f.time)} (${fmtDur(dm)}).`
        : "Should be landing about now — waiting for the airport board to confirm.";
    }
  }
  return `<tr class="detail"><td colspan="6">${tele}</td></tr>`;
}

/* ---------------- landing alerts ---------------- */
const ALERT_KEY = "ytz-alerts-on";
const NOTIFIED_KEY = "ytz-notified-v1";
let notified;
try { notified = new Set(JSON.parse(localStorage.getItem(NOTIFIED_KEY) || "[]")); } catch { notified = new Set(); }

function alertsEnabled() {
  return localStorage.getItem(ALERT_KEY) === "1" &&
    "Notification" in window && Notification.permission === "granted";
}

function notify(key, title, body) {
  if (!alertsEnabled() || notified.has(key)) return;
  notified.add(key);
  try { localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...notified].slice(-300))); } catch {}
  const opts = { body, icon: "icon-192.png", badge: "icon-192.png", tag: key };
  // Android Chrome only allows notifications through the service worker.
  if (navigator.serviceWorker && navigator.serviceWorker.ready) {
    navigator.serviceWorker.ready
      .then((reg) => reg.showNotification(title, opts))
      .catch(() => { try { new Notification(title, opts); } catch {} });
  } else {
    try { new Notification(title, opts); } catch {}
  }
}

function refreshAlertsBtn() {
  const b = $("notifToggle");
  const on = alertsEnabled();
  b.classList.toggle("on", on);
  b.textContent = on ? "On" : "Off";
}

async function toggleAlerts() {
  if (!("Notification" in window)) { $("notifToggle").textContent = "Unsupported"; return; }
  if (alertsEnabled()) {
    localStorage.setItem(ALERT_KEY, "0");
  } else {
    const p = await Notification.requestPermission();
    if (p === "granted") {
      localStorage.setItem(ALERT_KEY, "1");
      notify(`welcome|${Date.now()}`, "Landing alerts on",
        "You'll be pinged when a flight turns final and the moment it touches down.");
    }
  }
  refreshAlertsBtn();
}

/* ---------------- live map ---------------- */
const MAP_KEY = "ytz-map-open";
/* Leaflet loads only when the map is opened, so a slow or filtered CDN can
   never block the arrivals board from painting. */
let leafletLoading = null;
function loadLeaflet() {
  if (typeof L !== "undefined") return Promise.resolve();
  if (leafletLoading) return leafletLoading;
  leafletLoading = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    css.crossOrigin = "";
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    s.crossOrigin = "";
    s.onload = resolve;
    s.onerror = () => { leafletLoading = null; reject(new Error("leaflet load failed")); };
    document.head.appendChild(s);
  });
  return leafletLoading;
}

let map = null;
const mapMarkers = {};
let lastMapKey = "";
let routeLines = [];
let originMarker = null;
/* Airliner silhouette (points north, so rotate by the true track directly). */
const PLANE_PATH = "M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z";

function initMap() {
  if (map || typeof L === "undefined") return;
  map = L.map("map", { zoomControl: true }).setView([YTZ.lat, YTZ.lon], 8);
  // Keep the OSM/CARTO data credit (their tile terms require it) but drop the
  // Leaflet prefix for a cleaner look.
  map.attributionControl.setPrefix("");
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO", maxZoom: 12,
  }).addTo(map);
  L.circleMarker([YTZ.lat, YTZ.lon], { radius: 6, color: "#ffb52e", fillColor: "#ffb52e", fillOpacity: 1 })
    .addTo(map).bindTooltip("YTZ · Billy Bishop");
}

function updateMap() {
  if (!map || $("mapWrap").hidden) return;
  const seen = new Set();
  const pts = [[YTZ.lat, YTZ.lon]];
  for (const f of state.flights) {
    if (f.day !== "Today") continue;
    const s = state.aircraft.get(f.flight);
    if (!s || s.lat == null || s.grounded || Date.now() - s.ts > 120_000) continue;
    seen.add(f.flight);
    pts.push([s.lat, s.lon]);
    const rot = Math.round(s.track || 0);
    const icon = L.divIcon({
      className: "",
      html: `<svg class="plane-svg ${f.airlineCls}${state.focus === f.flight ? " selected" : ""}" viewBox="0 0 24 24" style="transform:rotate(${rot}deg)"><path d="${PLANE_PATH}"/></svg>`,
      iconSize: [30, 30], iconAnchor: [15, 15],
    });
    let tip = `${f.flight} · ${Math.round(s.dist)} km`;
    if (state.focus === f.flight && s.gs > 40) {
      tip += ` · ~${Math.max(1, Math.round((s.dist / (s.gs * 1.852)) * 60 + 4))} min`;
    }
    if (mapMarkers[f.flight]) {
      mapMarkers[f.flight].setLatLng([s.lat, s.lon]);
      mapMarkers[f.flight].setIcon(icon);
      mapMarkers[f.flight].setTooltipContent(tip);
    } else {
      mapMarkers[f.flight] = L.marker([s.lat, s.lon], { icon })
        .addTo(map)
        .bindTooltip(tip, { permanent: true, direction: "right", offset: [12, 0], className: "plane-label" })
        // Clicking an aircraft opens the detail panel, the way Flightradar24
        // does it. Bound once at creation, not on every refresh, so the handler
        // is not re-registered 3 times a second while a flight is on final.
        .on("click", () => selectAircraft(f.flight));
    }
  }
  for (const k of Object.keys(mapMarkers)) {
    if (!seen.has(k)) { map.removeLayer(mapMarkers[k]); delete mapMarkers[k]; }
  }
  drawFocusRoute();
  renderAcPanel();          // keep the open panel's live numbers current
  // Re-frame only when the set of tracked planes changes, so user panning sticks.
  const key = [...seen].sort().join(",") + (state.focus || "");
  if (key !== lastMapKey) {
    lastMapKey = key;
    if (!state.focus && pts.length > 1) map.fitBounds(pts, { padding: [28, 28], maxZoom: 9 });
  }
}

/* ---------------- selected-aircraft panel ----------------
   Clicking a plane opens a detail panel over the map, the way Flightradar24
   does, instead of relying on the small tooltip label. */
function selectAircraft(flightNo) {
  state.focus = state.focus === flightNo ? null : flightNo;
  lastMapKey = "";                     // let the map re-frame on the new focus
  renderAcPanel();
  updateMap();
  const s = state.aircraft.get(state.focus);
  if (state.focus && s && s.lat != null) map.panTo([s.lat, s.lon], { animate: true });
}

function closeAcPanel() {
  state.focus = null;
  renderAcPanel();
  updateMap();
}

/* Rendered fresh on every radar tick so the numbers stay live while open. */
function renderAcPanel() {
  const panel = $("acPanel"), body = $("acPanelBody");
  if (!panel || !body) return;
  const fNo = state.focus;
  const f = fNo && state.flights.find((x) => x.flight === fNo && x.day === "Today");
  const s = fNo && state.aircraft.get(fNo);
  if (!f || !s || s.lat == null) { panel.hidden = true; return; }

  const v = viewOf(f);
  const kmh = s.gs != null ? Math.round(s.gs * 1.852) : null;
  const altTxt = typeof s.alt === "number" ? `${s.alt.toLocaleString()} ft`
    : s.grounded ? "on ground" : "—";

  // Distance flown, as a fraction of the whole route. Only meaningful when we
  // know where it started, so the bar is dropped rather than faked otherwise.
  let bar = "";
  if (f.olat != null) {
    const total = haversineKm({ lat: f.olat, lon: f.olon }, YTZ);
    const pct = total > 0 ? Math.max(0, Math.min(100, ((total - s.dist) / total) * 100)) : 0;
    bar = `<div class="ac-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="ac-barnote"><span>${Math.round(total - s.dist)} km flown</span>
      <span>${Math.round(s.dist)} km to run</span></div>`;
  }

  // Same arithmetic the board row uses, so the panel can never disagree with it.
  const etaCell = v.ataTxt !== "—"
    ? `<div class="ac-cell"><div class="k">Actual arrival</div><div class="v big green">${esc(v.ataTxt)}</div></div>`
    : `<div class="ac-cell"><div class="k">Expected</div><div class="v big">${esc(v.etaMain)}</div></div>`;

  body.innerHTML = `
    <div class="ac-head">
      <div class="ac-cs">${esc(s.cs || f.flight)}</div>
      <div class="ac-sub">${esc(f.flight)} · ${esc(f.airline)}</div>
      <span class="ac-type">${esc(s.type)} · ${esc(s.reg)}</span>
    </div>
    <div class="ac-route">
      <div class="ac-port"><div class="code">${esc(f.code || "—")}</div>
        <div class="city">${esc(f.city || "")}</div></div>
      <div class="ac-arrow">&#9992;</div>
      <div class="ac-port"><div class="code">YTZ</div><div class="city">Toronto City</div></div>
    </div>
    ${bar}
    <div class="ac-grid">
      <div class="ac-cell"><div class="k">Scheduled</div><div class="v">${esc(v.schedTxt)}</div></div>
      ${etaCell}
      <div class="ac-cell"><div class="k">Altitude</div><div class="v">${esc(altTxt)}</div></div>
      <div class="ac-cell"><div class="k">Speed</div><div class="v">${kmh != null ? kmh + " km/h" : "—"}</div></div>
      <div class="ac-cell"><div class="k">Distance</div><div class="v">${Math.round(s.dist)} km</div></div>
      <div class="ac-cell"><div class="k">Status</div><div class="v">${esc(v.statusTxt)}</div></div>
    </div>
    <div class="ac-links">
      <a href="${esc(fr24Url(f))}" target="_blank" rel="noopener noreferrer">Flightradar24</a>
      <a href="https://www.flightaware.com/live/flight/${esc(faIdent(f))}" target="_blank" rel="noopener noreferrer">FlightAware</a>
    </div>
    <div class="ac-note">${esc(v.etaSub || v.ataNote || "")}<br>
      Position from ADS-B, updated ${esc(ago(s.ts))}.</div>`;
  panel.hidden = false;
}

/* Route for the focused flight: solid = flown (origin to plane),
   dashed = remaining (plane to YTZ). */
function drawFocusRoute() {
  routeLines.forEach((l) => map.removeLayer(l));
  routeLines = [];
  if (originMarker) { map.removeLayer(originMarker); originMarker = null; }
  const fNo = state.focus;
  if (!fNo) return;
  const f = state.flights.find((x) => x.flight === fNo && x.day === "Today");
  const s = state.aircraft.get(fNo);
  const airborne = f && s && !s.grounded && s.lat != null && Date.now() - s.ts < 120_000;
  if (!airborne) return;
  const p = [s.lat, s.lon], y = [YTZ.lat, YTZ.lon];
  if (f.olat != null) {
    const o = [f.olat, f.olon];
    routeLines.push(L.polyline([o, p], { color: "#7f8ea0", weight: 2, opacity: .8 }).addTo(map));
    originMarker = L.circleMarker(o, { radius: 5, color: "#7f8ea0", fillColor: "#7f8ea0", fillOpacity: 1 })
      .addTo(map)
      .bindTooltip(`${f.code} · departed`, { permanent: true, direction: "left", className: "plane-label" });
  }
  routeLines.push(L.polyline([p, y], { color: "#d22630", weight: 2.5, dashArray: "7 7", opacity: .9 }).addTo(map));
  if (state.focusFit) {
    state.focusFit = false;
    const b = f.olat != null ? [[f.olat, f.olon], p, y] : [p, y];
    map.fitBounds(b, { padding: [34, 34] });
  }
}

function setMapOpen(open) {
  try { localStorage.setItem(MAP_KEY, open ? "1" : "0"); } catch {}
  $("mapWrap").hidden = !open;
  $("mapBtn").classList.toggle("on", open);
  if (open) {
    loadLeaflet().then(() => {
      initMap();
      setTimeout(() => { if (map) { map.invalidateSize(); lastMapKey = ""; updateMap(); } }, 80);
    }).catch(() => {}); // map is optional; the board must never depend on it
  }
}

/* ---------------- wiring ---------------- */
function setTab(tab) {
  state.tab = tab;
  // Alerts are a today-only feature: hide the button and panel on Tomorrow.
  $("alertsBtn").hidden = tab === "Tomorrow";
  if (tab === "Tomorrow") $("alertsPanel").hidden = true;
  $("tabToday").classList.toggle("active", tab === "Today");
  $("tabTomorrow").classList.toggle("active", tab === "Tomorrow");
  render();
}

$("acClose").addEventListener("click", closeAcPanel);
// Escape closes the panel, matching how every other overlay on the web behaves.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.focus) closeAcPanel();
});
$("tabToday").addEventListener("click", () => setTab("Today"));
$("tabTomorrow").addEventListener("click", () => setTab("Tomorrow"));
$("alertsBtn").addEventListener("click", () => {
  const p = $("alertsPanel");
  if (p.hidden) bump("feat-alerts");
  p.hidden = !p.hidden;
});
$("notifToggle").addEventListener("click", toggleAlerts);
$("sheetBtn").addEventListener("click", () => bump("feat-sheet"));
$("mapBtn").addEventListener("click", () => {
  const opening = $("mapWrap").hidden;
  if (opening) bump("feat-map");
  setMapOpen(opening);
});
$("search").addEventListener("input", (e) => { state.search = e.target.value; render(); });
$("rows").addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (a) { bump("feat-flightlink"); return; } // tracker links navigate natively
  const tr = e.target.closest("tr.flight-row");
  if (!tr) return;
  const id = tr.dataset.flight;
  const opening = !state.expanded.has(id);
  opening ? state.expanded.add(id) : state.expanded.delete(id);
  // Opening a row of a tracked airborne flight focuses it on the map:
  // zoom to the plane, draw its route, show remaining time.
  const s = state.aircraft.get(id);
  if (opening && s && !s.grounded && Date.now() - s.ts < 120_000) {
    state.focus = id;
    state.focusFit = true;
    setMapOpen(true);
    updateMap();
    $("mapWrap").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } else if (!opening && state.focus === id) {
    state.focus = null;
    if (map) updateMap();
  }
  render();
});


function tickClock() {
  const now = new Date();
  $("clock").textContent = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  }).format(now);
  $("clockSub").textContent = `${fmtClock(now)} · Toronto local`;
}
setInterval(tickClock, 1000);
tickClock();

let adsbTimer = null;
function nextAdsbDelay() {
  if (document.hidden) return ADSB_HIDDEN_INTERVAL_MS;
  let delay = ADSB_BASE_MS;
  for (const s of state.aircraft.values()) {
    if (Date.now() - s.ts < 120_000 && !s.grounded) {
      if (s.dist < 25) return ADSB_ULTRA_MS;
      if (s.dist < 80) delay = ADSB_FAST_MS;
    }
  }
  return delay;
}
function scheduleAdsb() {
  clearTimeout(adsbTimer);
  // Small jitter so many viewers on one office IP don't fire in lockstep.
  const jitter = 0.85 + Math.random() * 0.3;
  adsbTimer = setTimeout(() => fetchAdsb().then(scheduleAdsb), Math.round(nextAdsbDelay() * jitter));
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    fetchAdsb().then(scheduleAdsb);
    fetchBoard();
    checkForUpdate();
  } else {
    scheduleAdsb();
  }
});

/* Refetch the board when the Toronto day rolls over (Tomorrow becomes Today). */
let currentDay = torontoDateKey();
setInterval(() => {
  const d = torontoDateKey();
  if (d !== currentDay) {
    currentDay = d;
    state.ata = loadAta();
    state.cancels = [];      // yesterday's cancellations end at midnight
    state.cancelsAt = 0;
    fetchBoard();
  }
}, 60_000);

/* ---------------- anonymous usage counters ----------------
   Fire-and-forget hit counters (no personal data, just tallies) powering the
   private stats.html dashboard. Failures are silently ignored. */
const STATS_NS = "syedsgroup-ytz";
function bump(key) {
  try {
    fetch(`https://abacus.jasoncameron.dev/hit/${STATS_NS}/${key}`, { keepalive: true }).catch(() => {});
  } catch {}
}

/* ---------------- self-update ----------------
   Open tabs check for a newer deployed version every 5 minutes (and whenever
   the tab regains focus) and reload themselves once. No manual refreshing. */
function runningVer() {
  const s = document.querySelector('script[src*="app.js"]');
  const m = s && s.src.match(/[?&]v=(\d+)/);
  return m ? m[1] : "0";
}

async function checkForUpdate() {
  try {
    const res = await fetch(`index.html?upd=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const m = (await res.text()).match(/app\.js\?v=(\d+)/);
    if (!m || m[1] === runningVer()) return;
    // Reload once per discovered version (10 min cooldown guards against loops).
    const prev = (sessionStorage.getItem("upd-attempt") || "").split("|");
    if (prev[0] === m[1] && Date.now() - (+prev[1] || 0) < 10 * 60_000) return;
    sessionStorage.setItem("upd-attempt", `${m[1]}|${Date.now()}`);
    location.reload();
  } catch {}
}
setInterval(checkForUpdate, 5 * 60_000);

/* Wall-display safety net: a full page reload every 2 minutes so a screen left
   up all shift can never drift or get stuck on a stale render. Skipped while
   someone is actively searching or has a row open, so it never interrupts. */
setInterval(() => {
  if (document.hidden) return;
  if (state.search.trim() || state.expanded.size) return;
  if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
  location.reload();
}, 120_000);

/* Keep countdowns and "Xs ago" freshness text ticking. */
setInterval(render, 5_000);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

/* Show which build is running. A reviewer asking "is this the version you
   showed me?" should be able to read the answer off the page. */
(function stampBuild() {
  const el = $("buildTag");
  if (!el) return;
  const s = document.querySelector('script[src*="app.js"]');
  const m = s && s.src.match(/[?&]v=(\d+)/);
  el.textContent = `· Build ${m ? m[1] : "dev"}`;
})();

bump("opens");
bump(`opens-${torontoDateKey()}`);
try {
  if (!localStorage.getItem("ytz-visitor")) {
    localStorage.setItem("ytz-visitor", "1");
    bump("visitors");
  }
} catch {}

refreshAlertsBtn();
const mapPref = localStorage.getItem(MAP_KEY);
setMapOpen(mapPref !== null ? mapPref === "1" : true);

paintCachedBoard();
// Canonical airport table first, so nothing is ever mapped with the fallback
// copy; the board fetch starts immediately after regardless of the outcome.
loadReferenceData().finally(() => fetchBoard());
fetchDeps();
fetchAdsb().then(scheduleAdsb);
setInterval(fetchBoard, BOARD_INTERVAL_MS);
setInterval(fetchDeps, DEPS_INTERVAL_MS);
