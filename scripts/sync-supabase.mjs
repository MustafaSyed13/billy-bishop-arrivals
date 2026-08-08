// =====================================================================
//  THE IN PIPE:  airport board + radar  ──▶  your Supabase database
//
//  Runs inside GitHub Actions (free for public repos). Each run keeps sweeping
//  radar for ~4.4 minutes, then the next scheduled run takes over, so radar
//  coverage is effectively continuous at ~15 second resolution.
//
//  Why here instead of a Supabase Edge Function? Nothing to install, no CLI
//  login, and the secret key lives in GitHub's encrypted secret vault — never
//  in a file, never in a browser.
//
//  Requires two GitHub repo secrets:
//    SUPABASE_URL          https://crrrykfftzlzymmmawsn.supabase.co
//    SUPABASE_SERVICE_KEY  the sb_secret_... key  (WRITE access)
// =====================================================================

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
// DRY_RUN exercises every source fetch, parse and match, but writes nothing.
// Lets the whole pipeline be tested before any secret key exists.
const DRY_RUN = process.env.DRY_RUN === "1";

if (!DRY_RUN && (!SB_URL || !SB_KEY)) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}
if (DRY_RUN) console.log("*** DRY RUN — no database writes ***");

const ARRIVALS_URL = "https://www.billybishopairport.com/flights/arrivals/";
const DEPARTURES_URL = "https://www.billybishopairport.com/flights/departures/";
const ADSB_URL = "https://api.airplanes.live/v2/point/43.6275/-79.3962/250";

const YTZ = { lat: 43.6275, lon: -79.3962 };
const RUN_MS = process.env.DRY_RUN === "1" ? 20_000 : 265_000;  // ~4.4 min, then next run takes over
const SWEEP_MS = 15_000;  // radar sample every 15 s
const UA = "syedsgroup-ytz-board/1.0 (+ops dashboard)";

/* ---------------- reference data ----------------
   Loaded from the ONE canonical table shared with the frontend. Keeping a
   second copy here is what let the backend record Washington as DCA while the
   site displayed IAD for the same flight. Never re-inline this data. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REF = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "airports.json"), "utf8"));

const US_AIRPORTS = Object.fromEntries(
  Object.entries(REF.airports).map(([k, v]) => [k, { code: v.iata, city: v.airport || v.city }]));
const US_STATES = new Set(REF.usStates);
const AIRLINES = REF.airlines;

/* ---------------- helpers ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function torontoDate(offsetDays = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" })
    .format(new Date(Date.now() + offsetDays * 86_400_000));
}

/* Minutes since midnight, Toronto. Used for sanity-checking arrival claims. */
function torontoMinutesNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t) => +parts.find((p) => p.type === t).value;
  return (get("hour") % 24) * 60 + get("minute");
}

function schedMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
  return m ? +m[1] * 60 + +m[2] : null;
}

/* THE GUARD THAT WAS MISSING.
   The airport's "Today" table does not roll over at Toronto midnight — for a
   while after 00:00 it still lists the previous day's completed flights. That
   caused yesterday's "Arrived" statuses to be copied onto today's brand-new
   rows, stamping a dozen flights as landed at ~00:34 with delays of -500 to
   -1100 minutes. A flight scheduled for 18:00 cannot have landed at 00:34.
   So: an arrival is only believable once its scheduled time has essentially
   arrived (we allow 30 minutes early). */
function arrivalPlausible(schedLocal, nowMin) {
  const s = schedMinutes(schedLocal);
  if (s === null) return true;           // unknown schedule: don't block
  return nowMin >= s - 30;
}

/* Is a recorded board-sourced touchdown believable for this schedule?
   Rejects the midnight cluster while keeping genuinely late arrivals. */
function touchdownPlausible(schedLocal, touchdownIso) {
  const s = schedMinutes(schedLocal);
  if (s === null || !touchdownIso) return true;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(touchdownIso));
  const get = (t) => +parts.find((p) => p.type === t).value;
  const td = (get("hour") % 24) * 60 + get("minute");
  const diff = td - s;                   // minutes after schedule
  return diff >= -90 && diff <= 8 * 60;  // 1.5 h early .. 8 h late
}

/* Convert a Toronto wall-clock "HH:MM" on a given service date into a real UTC
   instant. Tries both possible offsets and keeps the one that round-trips back
   to the same local time, so DST is handled without a date library. */
function torontoLocalToUtcIso(dateStr, hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""))) return null;
  const hh = String(+m[1]).padStart(2, "0"), mm = m[2];
  for (const offset of [4, 5]) {              // EDT, then EST
    const guess = new Date(`${dateStr}T${hh}:${mm}:00Z`);
    guess.setUTCHours(guess.getUTCHours() + offset);
    const back = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(guess);
    if (back === `${hh}:${mm}`) return guess.toISOString();
  }
  return null;
}

function haversineKm(a, b) {
  const R = 6371, d = Math.PI / 180;
  const dLat = (b.lat - a.lat) * d, dLon = (b.lon - a.lon) * d;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function originInfo(origin) {
  const clean = String(origin || "").trim();
  const lower = clean.toLowerCase();
  for (const key of Object.keys(US_AIRPORTS)) {
    if (lower.startsWith(key)) return US_AIRPORTS[key];
  }
  const st = /,\s*([A-Z]{2})\s*$/.exec(clean);
  if (st && US_STATES.has(st[1])) {
    return { code: st[1], city: clean.replace(/,\s*[A-Z]{2}\s*$/, "") };
  }
  return null;                     // not a U.S. origin -> not tracked
}

/* ---------------- Supabase over plain REST ----------------
   No SDK required: creating the tables created these URLs automatically. */
async function sbFetch(path, opts = {}) {
  if (DRY_RUN) {
    if ((opts.method || "GET") !== "GET") {
      console.log(`  [dry] would ${opts.method} ${path.split("?")[0]}`);
      return null;
    }
    return [];                     // pretend the table is empty
  }
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase ${opts.method || "GET"} ${path} -> ${res.status} ${await res.text()}`);
  }
  if (res.status === 204) return null;
  return await res.json().catch(() => null);
}

// upsert = update the row when this id already exists, otherwise insert it.
// This is what makes re-running every few minutes safe: never duplicates.
//
// PostgREST requires every object in one batch to have exactly the same keys.
// Our rows legitimately differ (only a landed flight carries touchdown_at), so
// we group by key-signature and send one batch per shape. We deliberately do
// NOT pad missing keys with null — that would blank out a landing time we had
// already recorded.
async function sbUpsert(table, rows) {
  if (!rows.length) return;
  const groups = new Map();
  for (const row of rows) {
    const sig = Object.keys(row).sort().join(",");
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(row);
  }
  for (const batch of groups.values()) {
    await sbFetch(table, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(batch),
    });
  }
}

// PATCH = update an existing row in place. Required when clearing fields:
// an upsert would attempt an INSERT first and trip the NOT NULL constraints
// on service_date / flight_no / airline.
async function sbPatch(table, filter, patch) {
  await sbFetch(`${table}?${filter}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
}

async function sbInsert(table, rows) {
  if (!rows.length) return;
  await sbFetch(table, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
}

/* ---------------- reading the sources ---------------- */
function parseRows(html) {
  const rows = [];
  const rowRe = /<tr[^>]*class=['"]item (Today|Tomorrow)['"][\s\S]*?<\/tr>/g;
  const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
  let rm;
  while ((rm = rowRe.exec(html))) {
    const tds = [];
    let tm;
    tdRe.lastIndex = 0;
    while ((tm = tdRe.exec(rm[0]))) tds.push(tm[1].replace(/<[^>]*>/g, "").trim());
    if (tds.length < 6) continue;
    const time = tds[1], flight = tds[3], origin = tds[4], status = tds[5];
    if (!/^[A-Z]{2}\d{2,4}$/.test(flight)) continue;
    if (!/^\d{1,2}:\d{2}$/.test(time)) continue;
    rows.push({ day: rm[1], time, flight, origin, status });
  }
  return rows;
}

async function fetchPage(url) {
  const res = await fetch(`${url}?_=${Date.now()}`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return await res.text();
}

async function fetchRadar() {
  try {
    const res = await fetch(ADSB_URL, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    return (await res.json()).ac || [];
  } catch {
    return [];                    // a radar blip must never crash the run
  }
}

/* Marketing number (AC8548) -> the callsign the aircraft actually broadcasts.
   Jazz sometimes drops the leading digit, hence the extra candidate. */
const MAX_FIX_AGE_S = 120;   // ignore position fixes older than this

/* Marketing flight number -> the callsign the aircraft actually broadcasts.
   Exact callsigns are trusted outright. The Jazz shortened form (AC8548 ->
   JZA548) is only accepted as a LAST RESORT, because JZA548 can legitimately
   be a completely different Jazz flight — matching it blindly is how a flight
   still en route gets attributed to an aircraft already on the ground here. */
function matchAircraft(flightNo, acList) {
  const airline = AIRLINES[flightNo.slice(0, 2)];
  if (!airline) return null;
  const digits = flightNo.replace(/\D/g, "");

  const exact = new Set(airline.callsigns.map((p) => p + digits));
  const loose = new Set();
  for (const p of airline.callsigns) {
    if (p === "JZA" && digits.length === 4) loose.add(p + digits.slice(1));
  }

  const pick = (set, requireType) => {
    let best = null;
    for (const ac of acList) {
      const cs = (ac.flight || "").trim().toUpperCase();
      if (!set.has(cs)) continue;
      if (ac.lat == null || ac.lon == null) continue;
      if ((ac.seen_pos ?? 0) > MAX_FIX_AGE_S) continue;      // stale fix
      // Every scheduled YTZ arrival is a Dash 8 or Embraer; a type mismatch on
      // an already-fuzzy callsign means it is almost certainly another flight.
      if (requireType && ac.t && !/^(DH8|E19|E29|E75)/.test(ac.t)) continue;
      if (!best || (ac.seen_pos ?? 99) < (best.seen_pos ?? 99)) best = ac;
    }
    return best;
  };

  return pick(exact, false) || (loose.size ? pick(loose, true) : null);
}

/* ===================== the run ===================== */
const serviceDate = torontoDate();
const tomorrow = torontoDate(1);

// 1. Read the airport board once — it only republishes about once a minute.
const arrHtml = await fetchPage(ARRIVALS_URL);
const depHtml = await fetchPage(DEPARTURES_URL).catch(() => "");
const arrRows = parseRows(arrHtml);
const depRows = depHtml ? parseRows(depHtml) : [];

// Refuse to write garbage if the airport page is broken or blocking us.
if (arrRows.length < 5) {
  console.error(`Refusing to sync: only ${arrRows.length} arrival rows parsed`);
  process.exit(1);
}
console.log(`parsed ${arrRows.length} arrivals, ${depRows.length} departures`);

// Only U.S.-origin Porter / Air Canada arrivals get tracked.
const tracked = arrRows.filter((r) =>
  AIRLINES[r.flight.slice(0, 2)] && originInfo(r.origin) &&
  (r.day === "Today" || r.day === "Tomorrow"));

/* A flight's id must NEVER change, or a delay would create a second row
   instead of updating the first. So the id must not contain the time (the
   airport rewrites that when a flight slips). Instead: date + flight number +
   which occurrence it is that day, since a few flight numbers genuinely fly
   twice in one day (e.g. PD2120 morning and afternoon). */
const occurrence = new Map();
const idMap = new Map();                      // board row -> stable id
for (const r of tracked) {
  const date = r.day === "Tomorrow" ? tomorrow : serviceDate;
  const key = `${date}|${r.flight}`;
  const n = occurrence.get(key) ?? 0;
  occurrence.set(key, n + 1);
  idMap.set(r, `${key}|${n}`);
}
const idOf = (r) => idMap.get(r);

// 2. What do we already know? Never overwrite a recorded landing, and never
//    lose the original schedule once the airport mutates its time cell.
const existing = await sbFetch(
  `flights?select=id,service_date,sched_local,touchdown_at,touchdown_source,status&service_date=in.(${serviceDate},${tomorrow})`);
const known = new Map((existing || []).map((r) => [r.id, r]));

// 3. Sync schedule + status for every tracked flight.
const boardEvents = [];
const nowMin = torontoMinutesNow();
let rolloverSkips = 0;
let vetoedLandings = 0;

/* Take a radar reading BEFORE trusting any board status, so a claimed arrival
   can be checked against where the aircraft physically is. Keyed by flight id.
   A failed radar fetch yields an empty map, which simply disables the veto —
   we never block a landing just because radar was unavailable. */
const radarView = new Map();
{
  const acNow = await fetchRadar();
  if (acNow.length) {
    for (const r of tracked) {
      const id = idOf(r);
      const ac = matchAircraft(r.flight, acNow);
      if (!ac) continue;
      const dist = haversineKm({ lat: ac.lat, lon: ac.lon }, YTZ);
      radarView.set(id, {
        dist,
        alt: typeof ac.alt_baro === "number" ? ac.alt_baro : null,
        grounded: ac.alt_baro === "ground" ||
          (typeof ac.alt_baro === "number" && ac.alt_baro < 400 && (ac.gs ?? 999) < 80),
        // seen_pos is seconds since that position was actually observed, so a
        // long-stale fix can't masquerade as a current one.
        ageMs: Math.max(0, (ac.seen_pos ?? 0)) * 1000,
      });
    }
  }
}
const baseRows = tracked.map((r) => {
  const id = idOf(r);
  const prev = known.get(id);
  const info = originInfo(r.origin);
  const statusLower = r.status.toLowerCase();
  const row = {
    id,
    service_date: r.day === "Tomorrow" ? tomorrow : serviceDate,
    flight_no: r.flight,
    airline: AIRLINES[r.flight.slice(0, 2)].name,
    origin_code: info.code,
    origin_city: info.city,
    est_local: r.time,
    status: r.status,
  };
  // First sighting wins for the original schedule; never touched again.
  if (!prev || !prev.sched_local) row.sched_local = r.time;

  // Reject an "Arrived"/"Departed" status for a flight whose scheduled time is
  // still in the future — that only happens during the airport's post-midnight
  // rollover, when its board still lists yesterday's flights under "Today".
  const schedForCheck = row.sched_local || (prev && prev.sched_local) || r.time;
  const believable = arrivalPlausible(schedForCheck, nowMin);
  if (!believable && /^(arrived|departed)$/.test(statusLower)) {
    row.status = prev && prev.status ? prev.status : "Scheduled";
    rolloverSkips++;
  }

  // FALLBACK LANDING: radar can miss a flight (transponder gap, out of
  // coverage). If the board flips to Arrived and we have no radar touchdown,
  // record the board's word instead — clearly labelled as the coarser source
  // so the site shows it as approximate rather than pretending precision.
  // Use the time the AIRPORT publishes in that row, not our own clock. Using
  // now() recorded "when we noticed", so any gap between runs stamped a whole
  // batch of flights with one identical (wrong) time.
  // RADAR VETO: the airport board sometimes reports "Arrived" while the
  // aircraft is demonstrably still in the air. Observed live: PD2132 flagged
  // arrived while our own radar had it 404 km out at 9,825 ft doing 314 kt;
  // PD2394 at 212 km / 21,000 ft; PD2726 at 109 km / 21,650 ft. Believing the
  // board in that situation is exactly the "says Landed but FlightAware says
  // 15 minutes out" complaint. When two sources contradict each other, trust
  // the physical observation and withhold the landing rather than guess.
  const liveTrack = radarView.get(id);
  const radarSaysAirborne = !!liveTrack && !liveTrack.grounded &&
    liveTrack.ageMs < 4 * 60_000 && liveTrack.dist > 15;
  if (radarSaysAirborne && statusLower === "arrived") {
    vetoedLandings++;
    console.log(`VETO board-arrived ${r.flight}: radar has it ${Math.round(liveTrack.dist)} km out` +
      `${liveTrack.alt != null ? ", " + liveTrack.alt + " ft" : ""} ` +
      `(${Math.round(liveTrack.ageMs / 1000)}s old)`);
  }

  if (believable && !radarSaysAirborne && statusLower === "arrived" && prev && !prev.touchdown_at &&
      prev.status && prev.status.toLowerCase() !== "arrived") {
    const rowDate = r.day === "Tomorrow" ? tomorrow : serviceDate;
    const reported = torontoLocalToUtcIso(rowDate, r.time);
    if (reported) {
      row.board_arrived_at = new Date().toISOString();
      row.touchdown_at = reported;
      row.touchdown_source = "board";
      row.touchdown_uncert_s = 600;        // airport board times are coarse
      boardEvents.push({ flight_id: id, event_type: "landed",
        detail: { source: "board", reported_local: r.time } });
      console.log(`LANDED (board) ${r.flight} reported ${r.time}`);
    }
  }
  if (statusLower === "cancelled" && prev && prev.status &&
      prev.status.toLowerCase() !== "cancelled") {
    boardEvents.push({ flight_id: id, event_type: "cancelled", detail: { was_due: r.time } });
  }
  return row;
});
// SELF-HEAL contradicted landings: a board-sourced arrival recorded while our
// own telemetry had the aircraft airborne and far away is not a landing. Clear
// it so the row reverts to an honest "expected" rather than a false "Landed".
for (const row of baseRows) {
  const t = radarView.get(row.id);
  const prev = known.get(row.id);
  if (!prev || !prev.touchdown_at || prev.touchdown_source !== "board") continue;
  if (t && !t.grounded && t.ageMs < 4 * 60_000 && t.dist > 15) {
    row.touchdown_at = null;
    row.touchdown_source = null;
    row.touchdown_uncert_s = null;
    console.log(`CLEARED false board landing ${row.flight_no}: radar ${Math.round(t.dist)} km out`);
  }
}

await sbUpsert("flights", baseRows);
if (boardEvents.length) await sbInsert("flight_events", boardEvents);
console.log(`synced ${baseRows.length} flight rows` +
  (rolloverSkips ? ` (${rolloverSkips} rollover status rejected)` : "") +
  (vetoedLandings ? ` (${vetoedLandings} board landings vetoed by radar)` : ""));

// 3a. SELF-HEAL: scrub board-sourced touchdowns that cannot be real. The
//     midnight-rollover bug wrote a cluster of them; this clears any that
//     already exist and would otherwise poison the delay metrics forever.
//     Applied regardless of source — a time that cannot be real is wrong even
//     if radar reported it — but the window is wide enough (90 min early to
//     8 h late) that genuine early or heavily delayed arrivals survive.
// Scans EVERY recorded touchdown, not just today's — the rollover bug fired
// once per night for several nights, so the damage spans past dates that a
// today-only scan would never revisit.
const repairScan = await sbFetch(
  "flights?select=id,service_date,sched_local,est_local,touchdown_at,touchdown_source&touchdown_at=not.is.null");
const clears = [];      // impossible -> wipe
const rewrites = [];    // board-sourced -> restate as the airport's own time

// Find "we noticed them all at once" stamps. Before landings required an
// observed airborne->ground transition, a run starting after a coverage gap
// found several aircraft already parked and wrote them all with that sweep's
// single clock reading — so the bad rows are identical to the millisecond.
// Two aircraft cannot touch down at the same instant on one runway, so any
// repeated timestamp is the bug, never a coincidence. Matching exactly (rather
// than within a window) means genuinely bunched arrivals are never touched.
const clustered = new Set();
{
  const byStamp = new Map();
  for (const row of (repairScan || [])) {
    if (!row.touchdown_at) continue;
    const key = `${row.service_date}|${row.touchdown_at}`;
    if (!byStamp.has(key)) byStamp.set(key, []);
    byStamp.get(key).push(row.id);
  }
  for (const ids of byStamp.values()) {
    if (ids.length >= 2) for (const id of ids) clustered.add(id);
  }
}

for (const row of (repairScan || [])) {
  if (!row.touchdown_at) continue;
  if (clustered.has(row.id)) {
    const reported = row.est_local ? torontoLocalToUtcIso(row.service_date, row.est_local) : null;
    if (reported && touchdownPlausible(row.sched_local, reported)) {
      // Already restated on an earlier run: leave it be rather than re-PATCHing
      // the same value every five minutes.
      if (reported !== row.touchdown_at) rewrites.push({ id: row.id, touchdown_at: reported });
    } else {
      console.log(`clearing clustered observe-time landing ${row.id} td=${row.touchdown_at}`);
      clears.push(row.id);
    }
    continue;
  }
  if (!touchdownPlausible(row.sched_local, row.touchdown_at)) {
    console.log(`clearing ${row.id} (${row.touchdown_source}) sched=${row.sched_local} td=${row.touchdown_at}`);
    clears.push(row.id);
    continue;
  }
  // Older board rows hold "when we noticed", which clustered whenever runs were
  // skipped. Restate them as the airport's published arrival time.
  if (row.touchdown_source === "board" && row.est_local) {
    const reported = torontoLocalToUtcIso(row.service_date, row.est_local);
    if (reported && reported !== row.touchdown_at &&
        touchdownPlausible(row.sched_local, reported)) {
      rewrites.push({ id: row.id, touchdown_at: reported });
    }
  }
}
if (!DRY_RUN) {
  for (const id of clears) {
    await sbPatch("flights", `id=eq.${encodeURIComponent(id)}`, {
      touchdown_at: null, touchdown_source: null,
      touchdown_uncert_s: null, board_arrived_at: null,
    });
  }
  for (const rw of rewrites) {
    await sbPatch("flights", `id=eq.${encodeURIComponent(rw.id)}`,
      { touchdown_at: rw.touchdown_at, touchdown_source: "board", touchdown_uncert_s: 600 });
  }
}
if (clears.length || rewrites.length) {
  console.log(`REPAIRED: ${clears.length} cleared, ${rewrites.length} restated from airport times` +
    (DRY_RUN ? " [dry]" : ""));
}

// 3b. Remove rows that are no longer on the airport board — but ONLY ones that
//     never happened. The airport drops flights from its board a few hours
//     after they land, so deleting everything absent from the board was
//     destroying completed flights from history: the collector would wake after
//     a gap, find the morning's arrivals gone from the board, and erase them.
//     That is why older days under-count Air Canada. A flight that has an
//     arrival recorded, or whose scheduled time has already passed, is history
//     and is never deleted. Only genuinely-removed future flights are cleared.
const validIds = new Set(tracked.map(idOf));
const isProtectedHistory = (row) => {
  if (row.touchdown_at) return true;                     // it happened
  if ((row.status || "").toLowerCase() === "cancelled") return true;  // it was cancelled
  if (row.service_date && row.service_date !== serviceDate) return true;  // a past day
  const s = schedMinutes(row.sched_local);
  return s !== null && nowMin >= s;                      // its slot has passed
};
const stale = (existing || [])
  .filter((r) => !validIds.has(r.id) && !isProtectedHistory(r))
  .map((r) => r.id);
if (stale.length && !DRY_RUN) {
  // One at a time: ids contain '|' and ':' which are awkward to batch safely
  // inside a PostgREST in.() list, and stale rows are only ever a handful.
  for (const id of stale) {
    await sbFetch(`flights?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
  }
  console.log(`removed ${stale.length} stale rows`);
} else if (stale.length) {
  console.log(`  [dry] would remove ${stale.length} stale rows`);
}

// 3c. BACKFILL: correct historical rows whose origin code disagrees with the
//     canonical airport table. The collector only ever revisits flights on
//     today's board, so rows written before shared/airports.json existed keep
//     stale codes forever (e.g. Washington recorded as DCA instead of IAD) and
//     would silently skew any historical reporting.
const cityToCode = new Map();
for (const v of Object.values(REF.airports)) {
  cityToCode.set((v.airport || v.city).toLowerCase(), v.iata);
  cityToCode.set(v.city.toLowerCase(), v.iata);
}
const CODE_ALIASES = { DCA: "IAD" };   // corrections confirmed by airport staff
try {
  const historical = await sbFetch("flights?select=id,origin_code,origin_city");
  const fixes = [];
  for (const row of (historical || [])) {
    const want = CODE_ALIASES[row.origin_code];
    if (!want || want === row.origin_code) continue;
    const canonical = Object.values(REF.airports).find((a) => a.iata === want);
    fixes.push({
      id: row.id,
      origin_code: want,
      origin_city: canonical ? (canonical.airport || canonical.city) : row.origin_city,
    });
  }
  if (fixes.length && !DRY_RUN) {
    // PATCH, not upsert: an upsert carrying only a few columns makes Postgres
    // attempt an INSERT, which then fails on NOT NULL columns like service_date.
    for (const fix of fixes) {
      const { id, ...cols } = fix;
      await sbFetch(`flights?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(cols),
      });
    }
    console.log(`BACKFILLED ${fixes.length} rows to canonical airport codes`);
  } else if (fixes.length) {
    console.log(`  [dry] would backfill ${fixes.length} origin codes`);
  }
} catch (err) {
  console.log(`origin backfill skipped: ${err.message}`);
}

// 4. Sweep radar repeatedly for the rest of this run.
const deadline = Date.now() + RUN_MS;
let sweeps = 0, landings = 0, unobservedArrivals = 0;
// id -> ms timestamp of the last fix showing this aircraft airborne.
const lastAirborneAt = new Map();
// Widest airborne->ground bracket we will still convert into a touchdown time.
// Beyond this the midpoint is a guess, and a guess is worse than the airport's
// own published time.
const MAX_LANDING_GAP_MS = 10 * 60_000;

while (Date.now() < deadline) {
  const acList = await fetchRadar();
  sweeps++;

  // Re-read just what's needed so a landing is never recorded twice.
  const cur = await sbFetch(
    `flights?select=id,touchdown_at,last_alt_ft,last_gs_kt,last_seen_at&service_date=eq.${serviceDate}`);
  const curMap = new Map((cur || []).map((r) => [r.id, r]));

  const updates = [];
  const events = [];
  const nowIso = new Date().toISOString();

  for (const r of tracked) {
    if (r.day !== "Today") continue;                  // only today can land now
    if (r.status.toLowerCase() === "cancelled") continue;
    const id = idOf(r);
    if (curMap.get(id)?.touchdown_at) continue;       // already landed, leave alone

    const ac = matchAircraft(r.flight, acList);
    if (!ac) continue;

    const dist = haversineKm({ lat: ac.lat, lon: ac.lon }, YTZ);
    const grounded = ac.alt_baro === "ground" ||
      (typeof ac.alt_baro === "number" && ac.alt_baro < 400 && (ac.gs ?? 999) < 80);

    const row = {
      id,
      service_date: serviceDate,
      flight_no: r.flight,
      airline: AIRLINES[r.flight.slice(0, 2)].name,
      aircraft_hex: ac.hex ?? null,
      aircraft_reg: ac.r ?? null,
      aircraft_type: ac.t ?? null,
      last_lat: ac.lat,
      last_lon: ac.lon,
      last_alt_ft: typeof ac.alt_baro === "number" ? ac.alt_baro : null,
      last_gs_kt: ac.gs ?? null,
      last_dist_km: Number(dist.toFixed(1)),
      last_seen_at: nowIso,
    };

    // Airborne: publish a predicted touchdown so the board can count down.
    if (!grounded && (ac.gs ?? 0) > 40) {
      const minsOut = (dist / ((ac.gs || 200) * 1.852)) * 60 + 4;
      row.eta_predicted_at = new Date(Date.now() + minsOut * 60_000).toISOString();
    }

    // Remember the last moment this aircraft was definitely still flying. That
    // instant, paired with the first moment it is definitely down, brackets the
    // real touchdown. Evidence carries across runs: the previous run's stored
    // telemetry proves the aircraft was airborne when it was last written.
    const prevRow = curMap.get(id);
    if (!grounded && (ac.gs ?? 0) > 40) {
      lastAirborneAt.set(id, Date.now());
    } else if (!lastAirborneAt.has(id) && prevRow?.last_seen_at &&
               ((prevRow.last_alt_ft ?? 0) > 1500 || (prevRow.last_gs_kt ?? 0) > 120)) {
      lastAirborneAt.set(id, Date.parse(prevRow.last_seen_at) || 0);
    }

    // THE LANDING DECISION: an aircraft we watched flying is now on the ground
    // at this airport. Each gate stops a failure we actually hit:
    //   grounded        - it is down
    //   dist <= 4.5     - down HERE, not taxiing at Newark before departure
    //   airborneAt      - we witnessed it flying, so this really is a landing
    //                     and not just the first time we looked. Without this,
    //                     a collector run starting after a coverage gap found
    //                     several aircraft already parked and stamped them all
    //                     "landed now" — how three flights ended up sharing one
    //                     wrong time about 25 minutes after they really landed.
    const airborneAt = lastAirborneAt.get(id);
    if (grounded && dist <= 4.5 && airborneAt) {
      // Touchdown happened between the last airborne fix and now. Take the
      // midpoint rather than "now": with 15 s sweeps that is a few seconds of
      // error, and across a run boundary it halves the error instead of
      // charging the whole gap to the flight.
      const gapMs = Date.now() - airborneAt;
      if (gapMs > MAX_LANDING_GAP_MS) {
        // Too coarse to call. The airport's published time beats a guess.
        unobservedArrivals++;
      } else {
        const td = new Date(airborneAt + gapMs / 2).toISOString();
        row.touchdown_at = td;
        row.touchdown_source = "adsb";
        row.touchdown_uncert_s = Math.round(gapMs / 2000);
        events.push({
          flight_id: id, event_type: "landed",
          detail: { source: "adsb", dist_km: Number(dist.toFixed(2)), reg: ac.r ?? null,
                    bracket_s: Math.round(gapMs / 1000) },
        });
        landings++;
        console.log(`LANDED ${r.flight} at ${td} (${dist.toFixed(1)} km, ±${Math.round(gapMs / 2000)}s)`);
      }
    } else if (grounded && dist <= 4.5) {
      // On the ground here, but we never saw it fly: the airport's published
      // time is the honest answer, not our observation time.
      unobservedArrivals++;
    }
    updates.push(row);
  }

  if (updates.length) await sbUpsert("flights", updates);
  if (events.length) await sbInsert("flight_events", events);

  // 5. Publish the compact snapshot the website reads (one row, one query).
  const all = await sbFetch(`flights?select=*&service_date=in.(${serviceDate},${tomorrow})`);
  // EVERY cancellation, both directions, U.S. and domestic. Filtering out
  // domestic ones hid all of them on days when only Ottawa/Montreal cancelled.
  // The client groups them; it does not need them pre-filtered.
  const cancelOf = (rows, direction) => rows
    .filter((r) => r.day === "Today" && r.status.toLowerCase() === "cancelled" &&
                   !r.flight.startsWith("TS"))
    .map((r) => {
      const us = originInfo(r.origin);
      return {
        flight: r.flight,
        time: r.time,
        origin: r.origin,
        direction,
        us: !!us,
        code: us ? us.code : null,
      };
    });
  const cancellations = [...cancelOf(arrRows, "arrival"), ...cancelOf(depRows, "departure")];

  await sbUpsert("board_state", [{
    id: 1,
    payload: {
      v: 1,
      generated_at: new Date().toISOString(),
      service_date: serviceDate,
      tomorrow_date: tomorrow,
      flights: all || [],
      cancellations,                       // all cancellations, both directions
      departure_cancellations: cancellations.filter((c) => c.direction === "departure"),
    },
    updated_at: new Date().toISOString(),
  }]);

  const left = deadline - Date.now();
  if (left > SWEEP_MS) await sleep(SWEEP_MS);
  else break;
}

console.log(`done: ${sweeps} radar sweeps, ${landings} landings recorded` +
  (unobservedArrivals ? `, ${unobservedArrivals} arrivals left to the board (no observed transition)` : ""));
