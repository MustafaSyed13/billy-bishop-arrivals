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

/* ---------------- reference data ---------------- */
const US_AIRPORTS = {
  "new york-newark": { code: "EWR", city: "Newark" },
  "newark": { code: "EWR", city: "Newark" },
  "new york": { code: "LGA", city: "New York LaGuardia" },
  "boston": { code: "BOS", city: "Boston" },
  "chicago o'hare": { code: "ORD", city: "Chicago O'Hare" },
  "chicago-o'hare": { code: "ORD", city: "Chicago O'Hare" },
  "chicago-midway": { code: "MDW", city: "Chicago Midway" },
  "chicago midway": { code: "MDW", city: "Chicago Midway" },
  "washington-dulles": { code: "IAD", city: "Washington Dulles" },
  "washington": { code: "DCA", city: "Washington National" },
  "nashville": { code: "BNA", city: "Nashville" },
  "orlando": { code: "MCO", city: "Orlando" },
  "tampa": { code: "TPA", city: "Tampa" },
  "fort lauderdale": { code: "FLL", city: "Fort Lauderdale" },
  "fort myers": { code: "RSW", city: "Fort Myers" },
  "west palm beach": { code: "PBI", city: "West Palm Beach" },
  "myrtle beach": { code: "MYR", city: "Myrtle Beach" },
};
const US_STATES = new Set(["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN",
  "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC",
  "ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"]);
const AIRLINES = {
  PD: { name: "Porter", callsigns: ["PTR", "POE"] },
  AC: { name: "Air Canada", callsigns: ["JZA", "ACA", "ROU"] },
};

/* ---------------- helpers ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function torontoDate(offsetDays = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" })
    .format(new Date(Date.now() + offsetDays * 86_400_000));
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
async function sbUpsert(table, rows) {
  if (!rows.length) return;
  await sbFetch(table, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
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
function matchAircraft(flightNo, acList) {
  const airline = AIRLINES[flightNo.slice(0, 2)];
  if (!airline) return null;
  const digits = flightNo.replace(/\D/g, "");
  const wanted = new Set();
  for (const p of airline.callsigns) {
    wanted.add(p + digits);
    if (p === "JZA" && digits.length === 4) wanted.add(p + digits.slice(1));
  }
  let best = null;
  for (const ac of acList) {
    const cs = (ac.flight || "").trim().toUpperCase();
    if (!wanted.has(cs)) continue;
    if (ac.lat == null || ac.lon == null) continue;
    if (!best || (ac.seen_pos ?? 99) < (best.seen_pos ?? 99)) best = ac;
  }
  return best;
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
  `flights?select=id,sched_local,touchdown_at,status&service_date=in.(${serviceDate},${tomorrow})`);
const known = new Map((existing || []).map((r) => [r.id, r]));

// 3. Sync schedule + status for every tracked flight.
const boardEvents = [];
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

  // FALLBACK LANDING: radar can miss a flight (transponder gap, out of
  // coverage). If the board flips to Arrived and we have no radar touchdown,
  // record the board's word instead — clearly labelled as the coarser source
  // so the site can show it as approximate rather than pretending precision.
  if (statusLower === "arrived" && prev && !prev.touchdown_at &&
      prev.status && prev.status.toLowerCase() !== "arrived") {
    const nowIso = new Date().toISOString();
    row.board_arrived_at = nowIso;
    row.touchdown_at = nowIso;
    row.touchdown_source = "board";
    row.touchdown_uncert_s = 300;          // board updates are coarse: +/- 5 min
    boardEvents.push({ flight_id: id, event_type: "landed", detail: { source: "board" } });
    console.log(`LANDED (board) ${r.flight}`);
  }
  if (statusLower === "cancelled" && prev && prev.status &&
      prev.status.toLowerCase() !== "cancelled") {
    boardEvents.push({ flight_id: id, event_type: "cancelled", detail: { was_due: r.time } });
  }
  return row;
});
await sbUpsert("flights", baseRows);
if (boardEvents.length) await sbInsert("flight_events", boardEvents);
console.log(`synced ${baseRows.length} flight rows`);

// 3b. Remove rows for today/tomorrow that are no longer on the airport board
//     (schedule changed, or left over from an older id scheme). Keeps the
//     board from showing phantom flights.
const validIds = new Set(tracked.map(idOf));
const stale = (existing || []).map((r) => r.id).filter((id) => !validIds.has(id));
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

// 4. Sweep radar repeatedly for the rest of this run.
const deadline = Date.now() + RUN_MS;
let sweeps = 0, landings = 0;

while (Date.now() < deadline) {
  const acList = await fetchRadar();
  sweeps++;

  // Re-read just what's needed so a landing is never recorded twice.
  const cur = await sbFetch(
    `flights?select=id,touchdown_at&service_date=eq.${serviceDate}`);
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

    // THE LANDING DECISION: on the ground AND at this airport. The distance
    // test is what stops a plane taxiing at Newark being called "landed".
    if (grounded && dist <= 4.5) {
      row.touchdown_at = nowIso;
      row.touchdown_source = "adsb";
      row.touchdown_uncert_s = Math.round(SWEEP_MS / 2000);
      events.push({
        flight_id: id, event_type: "landed",
        detail: { source: "adsb", dist_km: Number(dist.toFixed(2)), reg: ac.r ?? null },
      });
      landings++;
      console.log(`LANDED ${r.flight} at ${nowIso} (${dist.toFixed(1)} km)`);
    }
    updates.push(row);
  }

  if (updates.length) await sbUpsert("flights", updates);
  if (events.length) await sbInsert("flight_events", events);

  // 5. Publish the compact snapshot the website reads (one row, one query).
  const all = await sbFetch(`flights?select=*&service_date=in.(${serviceDate},${tomorrow})`);
  const cancellations = depRows
    .filter((r) => r.day === "Today" && r.status.toLowerCase() === "cancelled" &&
                   !r.flight.startsWith("TS") && originInfo(r.origin))
    .map((r) => ({ flight: r.flight, time: r.time, origin: r.origin, direction: "departure" }));

  await sbUpsert("board_state", [{
    id: 1,
    payload: {
      v: 1,
      generated_at: new Date().toISOString(),
      service_date: serviceDate,
      tomorrow_date: tomorrow,
      flights: all || [],
      departure_cancellations: cancellations,
    },
    updated_at: new Date().toISOString(),
  }]);

  const left = deadline - Date.now();
  if (left > SWEEP_MS) await sleep(SWEEP_MS);
  else break;
}

console.log(`done: ${sweeps} radar sweeps, ${landings} landings recorded`);
