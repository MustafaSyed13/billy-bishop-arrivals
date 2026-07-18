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
const ADSB_URL = "https://api.airplanes.live/v2/point/43.6275/-79.3962/250";
const BOARD_INTERVAL_MS = 60_000;
const ADSB_INTERVAL_MS = 20_000;
const ADSB_HIDDEN_INTERVAL_MS = 60_000;
const STORE_KEY = "ytz-ata-v1";

/* Proxies tried in order; the last one that worked is tried first next time.
   jina is asked for raw HTML: the markdown view only carries the airport
   page's visible "Today" table, while the HTML holds Tomorrow rows too. */
const PROXIES = [
  { url: (u) => `https://r.jina.ai/${u}`, headers: { "x-respond-with": "html" } },
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
  aircraft: new Map(),    // flightNo -> latest matched ADS-B sample
  ata: loadAta(),         // "YYYY-MM-DD|PD2720" -> {t: epochMs, src}
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

function parseBoardText(text) {
  const flights = [];
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
      if (tds.length >= 6) {
        const f = buildFlight(rm[1], tds[1], tds[3], tds[4], tds[5]);
        if (f) flights.push(f);
      }
    }
  } else {
    // markdown table from the jina.ai reader
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("|")) continue;
      const c = t.split("|").map((x) => x.trim()).slice(1, -1);
      if (c.length < 6) continue;
      if (!/^(Today|Tomorrow)$/i.test(c[0])) continue;
      if (!/^[A-Z]{2}\d{2,4}$/.test(c[3])) continue;
      if (!/^\d{1,2}:\d{2}$/.test(c[1])) continue;
      const f = buildFlight(c[0][0].toUpperCase() + c[0].slice(1).toLowerCase(), c[1], c[3], c[4], c[5]);
      if (f) flights.push(f);
    }
  }
  return flights;
}

async function fetchBoard() {
  const target = `${BOARD_URL}?_=${Date.now()}`;
  let lastErr = null;
  for (let i = 0; i < PROXIES.length; i++) {
    const idx = (state.proxyIdx + i) % PROXIES.length;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25_000);
      const p = PROXIES[idx];
      const res = await fetch(p.url(target), { signal: ctrl.signal, headers: p.headers || {} });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const flights = parseBoardText(text);
      if (!flights.length) throw new Error("no rows parsed");
      state.proxyIdx = idx;
      applyBoard(flights);
      state.boardFetchedAt = Date.now();
      state.boardError = null;
      render();
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  state.boardError = lastErr ? String(lastErr.message || lastErr) : "unknown";
  render();
}

function applyBoard(flights) {
  for (const f of flights) {
    const key = `${f.flight}|${f.day}`;
    const prev = state.prevStatus.get(key);
    const now = f.status.toLowerCase();
    // Board flipped to "Arrived" while we watch and radar never caught the
    // touchdown -> stamp an approximate ATA at the moment of the flip.
    if (prev && prev !== "arrived" && now === "arrived" && !state.ata[ataKey(f)]) {
      state.ata[ataKey(f)] = { t: Date.now(), src: "board" };
      saveAta();
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
      };
      state.aircraft.set(f.flight, sample);
      // Touchdown detection: on the ground within ~4.5 km of the field.
      if (grounded && dist <= 4.5 && !state.ata[ataKey(f)]) {
        state.ata[ataKey(f)] = { t: Date.now(), src: "radar" };
        saveAta();
      }
    }
    state.adsbFetchedAt = Date.now();
    state.adsbError = null;
  } catch (e) {
    state.adsbError = String(e.message || e);
  }
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
    schedTxt: fmt12(f.time),
    etaMain: fmt12(f.time), etaSub: "", etaLive: false,
    ataTxt: "—", ataNote: "", ataApprox: false,
    statusTxt: f.status, statusCls: "ontime",
    ac: acFresh ? ac : null,
  };

  if (st === "cancelled") { v.statusCls = "cancelled"; v.etaMain = "—"; return v; }

  const landed = !!ata || st === "arrived";

  if (landed) {
    v.statusTxt = "Landed"; v.statusCls = "landed";
    if (ata) {
      const t = new Date(ata.t);
      if (ata.src === "radar") {
        v.ataTxt = fmt12FromDate(t);
        v.ataNote = "touchdown · live radar";
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
    const etaEpoch = ac.ts + ((ac.dist / (ac.gs * 1.852)) * 60 + 4) * 60_000;
    const remain = (etaEpoch - Date.now()) / 60_000;
    v.etaMain = fmtDur(remain);
    v.etaSub = `${fmt12FromDate(new Date(etaEpoch))} · live radar · ${Math.round(ac.dist)} km out`;
    v.etaLive = true;
    v.statusTxt = ac.dist < 12 ? "On final" : ac.dist < 60 ? "Approaching" : "In flight";
    v.statusCls = "inflight";
  } else {
    // No radar contact yet: count down to the airport's current estimate.
    const dm = minsUntilBoardTime(f);
    v.etaSub = dm >= -2 ? fmtDur(dm) : "awaiting update";
  }
  return v;
}

/* ---------------- rendering ---------------- */
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
    html += `
<tr class="${rowCls.join(" ")}" data-flight="${esc(f.flight)}">
  <td class="sched">${v.schedTxt}</td>
  <td class="flightno">${esc(f.flight)}</td>
  <td class="airline"><span class="airline-tag ${f.airlineCls}">${esc(f.airline)}</span></td>
  <td class="from"><span class="code">${esc(f.code)}</span><span class="city">${esc(f.city)}</span></td>
  <td class="eta${v.etaLive ? " live" : ""}${v.ataApprox ? " approx" : ""}"><span class="eta-main">${esc(v.etaMain)}</span>${v.etaSub ? `<span class="eta-note">${esc(v.etaSub)}</span>` : ""}</td>
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
  return `<tr class="detail"><td colspan="6">${tele}</td></tr>`;
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
$("search").addEventListener("input", (e) => { state.search = e.target.value; render(); });
$("rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr.flight-row");
  if (!tr) return;
  const id = tr.dataset.flight;
  state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
  render();
});

setInterval(() => { $("clock").textContent = fmtClock(new Date()); }, 1000);
$("clock").textContent = fmtClock(new Date());

let adsbTimer = null;
function scheduleAdsb() {
  clearInterval(adsbTimer);
  const ms = document.hidden ? ADSB_HIDDEN_INTERVAL_MS : ADSB_INTERVAL_MS;
  adsbTimer = setInterval(fetchAdsb, ms);
}
document.addEventListener("visibilitychange", () => {
  scheduleAdsb();
  if (!document.hidden) { fetchAdsb(); fetchBoard(); }
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

/* Keep relative "Xs ago" freshness text ticking. */
setInterval(render, 10_000);

fetchBoard();
fetchAdsb();
setInterval(fetchBoard, BOARD_INTERVAL_MS);
scheduleAdsb();
