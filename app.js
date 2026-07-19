"use strict";
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
   Porter spells cities like "Boston, MA"; Air Canada like "Boston". */
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
  "washington":      { code: "DCA", city: "Washington National", lat: 38.8521, lon: -77.0377 },
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
  arrRaw: [],             // every arrival row (all airlines) for the cancellations panel
  depRaw: [],             // every departure row
  prevArr: new Map(),     // cancellation flip detection, arrivals
  prevDep: new Map(),     // cancellation flip detection, departures
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
};

/* ---------------- utilities ---------------- */
const $ = (id) => document.getElementById(id);

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
  return `${date}|${f.flight}`;
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

function buildFlight(day, time, flightNo, origin, status) {
  const prefix = flightNo.slice(0, 2);
  const airline = AIRLINES[prefix];
  if (!airline) return null;                 // drops TS/other codeshare rows
  const info = originInfo(origin);
  if (!info) return null;                    // drops non-US origins
  return {
    day, time, flight: flightNo, origin, status: status.trim(),
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
  const flights = j.arrivals.map((r) => buildFlight(r.day, r.time, r.flight, r.origin, r.status)).filter(Boolean);
  applyBoard(flights);
  state.arrRaw = j.arrivals;
  trackCancellations(j.arrivals, state.prevArr, "arrival");
  if (Array.isArray(j.departures) && j.departures.length) {
    state.depRaw = j.departures;
    trackCancellations(j.departures, state.prevDep, "departure");
    state.depsFetchedAt = t;
  }
  state.boardFetchedAt = t;
  state.boardError = null;
  try { localStorage.setItem(BOARD_CACHE_KEY, JSON.stringify({ t, flights })); } catch {}
  return true;
}

async function fetchBoard() {
  // Feed first: paints in ~200 ms. The live scrape below is fresher but slow
  // and rate-limited, so it upgrades the data in the background when it works.
  const feedP = fetchFeed().catch(() => null);
  feedP.then((j) => { if (j && applyFeed(j)) render(); });
  try {
    const raw = await fetchViaProxies(`${BOARD_URL}?_=${Date.now()}`);
    const flights = raw.map((r) => buildFlight(r.day, r.time, r.flight, r.origin, r.status)).filter(Boolean);
    applyBoard(flights);
    state.arrRaw = raw;
    trackCancellations(raw, state.prevArr, "arrival");
    state.boardFetchedAt = Date.now();
    state.boardError = null;
    try {
      localStorage.setItem(BOARD_CACHE_KEY, JSON.stringify({ t: Date.now(), flights }));
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
  if (!schedStore[k]) {
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
      state.ata[ataKey(f)] = { t: Date.now(), src: "board" };
      saveAta();
      state.justLanded.set(f.flight, Date.now());
      notify(`${ataKey(f)}|landed`, `${f.flight} landed at YTZ`,
        `Airport board marked it arrived at ${fmt12FromDate(new Date())}`);
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

async function fetchAdsb() {
  try {
    const res = await fetch(ADSB_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = data.ac || [];
    for (const f of state.flights) {
      if (f.day !== "Today") continue;
      const st = f.status.toLowerCase();
      if (st === "cancelled") continue;
      const ac = matchAircraft(f, list);
      if (!ac) continue;
      const dist = haversineKm({ lat: ac.lat, lon: ac.lon }, YTZ);
      const grounded = ac.alt_baro === "ground" ||
        (typeof ac.alt_baro === "number" && ac.alt_baro < 400 && (ac.gs ?? 999) < 80);
      const sample = {
        cs: (ac.flight || "").trim(), reg: ac.r || "—", type: ac.t || "—",
        alt: ac.alt_baro, gs: ac.gs ?? null, dist, grounded, ts: Date.now(),
        lat: ac.lat, lon: ac.lon, track: ac.track ?? ac.true_heading ?? 0,
      };
      state.aircraft.set(f.flight, sample);
      // Alert once when the aircraft turns final (inside 12 km, still flying).
      if (!grounded && dist < 12 && (ac.gs ?? 0) > 60) {
        const mins = Math.max(2, Math.round((dist / ((ac.gs || 200) * 1.852)) * 60 + 3));
        notify(`${ataKey(f)}|final`, `${f.flight} on final approach`,
          `${f.city} to YTZ - about ${mins} min to touchdown`);
      }
      // Touchdown detection: on the ground within ~4.5 km of the field.
      if (grounded && dist <= 4.5 && !state.ata[ataKey(f)]) {
        state.ata[ataKey(f)] = { t: Date.now(), src: "radar" };
        saveAta();
        state.justLanded.set(f.flight, Date.now());
        notify(`${ataKey(f)}|landed`, `${f.flight} landed at YTZ`,
          `Touched down at ${fmt12FromDate(new Date())} from ${f.city}`);
      }
    }
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

function viewOf(f) {
  const st = f.status.toLowerCase();
  const ata = state.ata[ataKey(f)];
  const ac = state.aircraft.get(f.flight);
  const acFresh = ac && Date.now() - ac.ts < 90_000;

  const v = {
    schedTxt: fmt12(f.sched || f.time),
    schedSrc: f.schedSrc === "tomorrow_snapshot" ? "captured from yesterday's schedule" : "schedule as first published",
    etaMain: fmt12(f.time), etaSub: "", etaLive: false,
    ataTxt: "—", ataNote: "", ataApprox: false,
    statusTxt: f.status, statusCls: "ontime",
    ac: acFresh ? ac : null,
  };

  if (st === "cancelled") { v.statusCls = "cancelled"; v.etaMain = "—"; v.etaSub = "cancelled"; return v; }

  const landed = !!ata || st === "arrived";

  if (landed) {
    v.statusTxt = "Landed"; v.statusCls = "landed";
    if (ata) {
      const t = new Date(ata.t);
      if (ata.src === "radar") {
        v.ataTxt = fmt12FromDate(t);
        v.ataNote = "detected · ADS-B radar";
      } else {
        v.ataTxt = `≈ ${fmt12FromDate(t)}`;
        v.ataApprox = true; v.ataNote = "board update time";
      }
    } else {
      // Arrived before we started watching: the airport's time column holds
      // its latest (actual-ish) arrival time.
      v.ataTxt = `≈ ${fmt12(f.time)}`;
      v.ataApprox = true; v.ataNote = "airport board";
    }
    v.etaMain = v.ataTxt;
    v.etaSub = v.ataNote;
    return v;
  }

  if (st === "delayed" || st === "late") v.statusCls = "delayed";
  else if (st === "early") v.statusCls = "early";

  if (acFresh && !ac.grounded && ac.gs > 40) {
    // Predicted touchdown from the live position: distance over ground speed
    // plus an approach-pattern buffer. Counts down between radar polls.
    // Uncertainty bands are honest estimates by distance, not guarantees.
    const etaEpoch = ac.ts + ((ac.dist / (ac.gs * 1.852)) * 60 + 4) * 60_000;
    const remain = (etaEpoch - Date.now()) / 60_000;
    const unc = ac.dist < 8 ? "±1 min" : ac.dist < 25 ? "±3 min" : ac.dist < 80 ? "±5 min" : "±10 min";
    v.etaMain = fmtDur(remain);
    v.etaSub = `${fmt12FromDate(new Date(etaEpoch))} · live ${unc} · ${Math.round(ac.dist)} km`;
    v.etaLive = true;
    v.statusTxt = ac.dist < 12 ? "On final" : ac.dist < 60 ? "Approaching" : "In flight";
    v.statusCls = "inflight";
  } else {
    // No radar contact yet: count down to the airport's current estimate.
    const dm = minsUntilBoardTime(f);
    v.etaSub = dm >= -2 ? `airport estimate · ${fmtDur(dm)}` : "airport estimate · awaiting update";
  }
  return v;
}

/* ---------------- rendering ---------------- */
/* FlightAware ident: the live radar callsign when we have one (most exact),
   otherwise Porter flights track as POE + number, Air Canada (Jazz) as QK + number. */
function faIdent(f, v) {
  if (v.ac && v.ac.cs) return v.ac.cs.replace(/\s+/g, "");
  return (f.airlineCls === "pd" ? "POE" : "QK") + f.flight.replace(/\D/g, "");
}

function render() {
  const rows = $("rows");
  const q = state.search.trim().toLowerCase();
  const list = state.flights
    .filter((f) => f.day === state.tab)
    .filter((f) => !q ||
      f.flight.toLowerCase().includes(q) ||
      f.origin.toLowerCase().includes(q) ||
      f.code.toLowerCase().includes(q) ||
      f.airline.toLowerCase().includes(q))
    .sort((a, b) => minutesOfDay(a.time) - minutesOfDay(b.time));

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
  <td class="flightno"><a href="https://www.flightaware.com/live/flight/${esc(faIdent(f, v))}" target="_blank" rel="noopener noreferrer" title="Track ${esc(f.flight)} on FlightAware">${esc(f.flight)}</a></td>
  <td class="airline"><svg class="airline-logo ${f.airlineCls}" role="img" aria-label="${esc(f.airline)}"><use href="#${f.airlineCls === "pd" ? "porter-logo" : "aircanada-logo"}"></use></svg></td>
  <td class="from"><span class="code">${esc(f.code)}</span><span class="city">${esc(f.city)}</span></td>
  <td class="eta${v.etaLive ? " live" : ""}${v.ataApprox ? " approx" : ""}"><span class="eta-main">${esc(v.etaMain)}</span>${v.etaSub ? `<span class="eta-note">${esc(v.etaSub)}</span>` : ""}</td>

</tr>`;
    if (state.expanded.has(f.flight)) html += detailRow(f, v);
  }

  rows.innerHTML = html || `<td colspan="5" class="empty">${
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
    ` · radar ${state.adsbFetchedAt ? ago(state.adsbFetchedAt) + " ago" : "…"}`;
  const live = $("liveDot").parentElement;
  const boardAge = Date.now() - state.boardFetchedAt;
  live.classList.toggle("down", !state.boardFetchedAt && !!state.boardError);
  live.classList.toggle("stale", !!state.boardFetchedAt && boardAge > 3 * BOARD_INTERVAL_MS);
  $("liveLabel").textContent =
    !state.boardFetchedAt && state.boardError ? "OFFLINE"
      : boardAge > 3 * BOARD_INTERVAL_MS ? "STALE" : "LIVE";

  const banner = $("banner");
  if (state.boardError && state.boardFetchedAt) {
    banner.hidden = false;
    banner.textContent = "Arrivals feed temporarily unreachable — showing last good data, retrying every minute.";
  } else banner.hidden = true;

  renderCancellations();
}

/* All of today's cancelled flights, arrivals and departures, any airline. */
function renderCancellations() {
  const cxl = $("cxl");
  const items = [];
  for (const r of state.arrRaw) {
    if (r.day === "Today" && !r.flight.startsWith("TS") && r.status.toLowerCase() === "cancelled") {
      items.push({ ...r, kind: "ARRIVAL", prep: "from" });
    }
  }
  for (const r of state.depRaw) {
    if (r.day === "Today" && !r.flight.startsWith("TS") && r.status.toLowerCase() === "cancelled") {
      items.push({ ...r, kind: "DEPARTURE", prep: "to" });
    }
  }
  items.sort((a, b) => minutesOfDay(a.time) - minutesOfDay(b.time));
  cxl.dataset.empty = items.length ? "0" : "1";
  $("cxlCount").textContent = items.length;
  const list = $("cxlList");
  list.hidden = !state.cxlOpen || !items.length;
  list.innerHTML = items.map((r) => {
    const cls = r.flight.startsWith("PD") ? "pd" : r.flight.startsWith("AC") ? "ac" : "";
    const logo = cls
      ? `<svg class="airline-logo ${cls}" role="img"><use href="#${cls === "pd" ? "porter-logo" : "aircanada-logo"}"></use></svg>`
      : "";
    return `<div class="cxl-item">
      <span class="fno">${esc(r.flight)}</span>
      <span class="dir">${r.kind}</span>
      ${logo}
      <span class="route">${r.prep} ${esc(r.origin)}</span>
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
    tele = st === "arrived" || state.ata[ataKey(f)]
      ? "Aircraft has landed — live tracking ended."
      : st === "cancelled"
        ? "Flight cancelled."
        : "Not yet visible on radar — the aircraft appears here once airborne and in range (~460 km).";
  }
  return `<tr class="detail"><td colspan="5">${tele}</td></tr>`;
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
  const b = $("alertsBtn");
  const on = alertsEnabled();
  b.classList.toggle("on", on);
  b.textContent = on ? "🔔 Alerts on" : "🔕 Alerts";
}

async function toggleAlerts() {
  if (!("Notification" in window)) { $("alertsBtn").textContent = "Alerts unsupported"; return; }
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
      html: `<svg class="plane-svg ${f.airlineCls}" viewBox="0 0 24 24" style="transform:rotate(${rot}deg)"><path d="${PLANE_PATH}"/></svg>`,
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
        .bindTooltip(tip, { permanent: true, direction: "right", offset: [12, 0], className: "plane-label" });
    }
  }
  for (const k of Object.keys(mapMarkers)) {
    if (!seen.has(k)) { map.removeLayer(mapMarkers[k]); delete mapMarkers[k]; }
  }
  drawFocusRoute();
  // Re-frame only when the set of tracked planes changes, so user panning sticks.
  const key = [...seen].sort().join(",") + (state.focus || "");
  if (key !== lastMapKey) {
    lastMapKey = key;
    if (!state.focus && pts.length > 1) map.fitBounds(pts, { padding: [28, 28], maxZoom: 9 });
  }
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
  $("tabToday").classList.toggle("active", tab === "Today");
  $("tabTomorrow").classList.toggle("active", tab === "Tomorrow");
  render();
}

$("tabToday").addEventListener("click", () => setTab("Today"));
$("tabTomorrow").addEventListener("click", () => setTab("Tomorrow"));
$("alertsBtn").addEventListener("click", toggleAlerts);
$("mapBtn").addEventListener("click", () => setMapOpen($("mapWrap").hidden));
$("search").addEventListener("input", (e) => { state.search = e.target.value; render(); });
$("rows").addEventListener("click", (e) => {
  if (e.target.closest("a")) return; // flight-number links go to FlightAware
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

$("cxlHead").addEventListener("click", () => {
  state.cxlOpen = !state.cxlOpen;
  render();
});

setInterval(() => { $("clock").textContent = fmtClock(new Date()); }, 1000);
$("clock").textContent = fmtClock(new Date());

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
  adsbTimer = setTimeout(() => fetchAdsb().then(scheduleAdsb), nextAdsbDelay());
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    fetchAdsb().then(scheduleAdsb);
    fetchBoard();
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
    fetchBoard();
  }
}, 60_000);

/* Keep countdowns and "Xs ago" freshness text ticking. */
setInterval(render, 5_000);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

refreshAlertsBtn();
const mapPref = localStorage.getItem(MAP_KEY);
setMapOpen(mapPref !== null ? mapPref === "1" : window.innerWidth > 860);

paintCachedBoard();
fetchBoard();
fetchDeps();
fetchAdsb().then(scheduleAdsb);
setInterval(fetchBoard, BOARD_INTERVAL_MS);
setInterval(fetchDeps, DEPS_INTERVAL_MS);
