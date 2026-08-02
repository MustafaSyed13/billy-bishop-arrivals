// =====================================================================
//  YTZ Arrivals — canonical poller  (Supabase Edge Function, Deno)
//
//  Runs once a minute from pg_cron, and internally loops every SWEEP_MS so
//  radar is actually sampled ~6x/minute. Everything it decides (especially
//  touchdown times) is written to Postgres, so every staff device sees the
//  SAME landing time instead of each phone guessing on its own.
//
//  Deploy:  supabase functions deploy poll --no-verify-jwt
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ARRIVALS_URL = "https://www.billybishopairport.com/flights/arrivals/";
const DEPARTURES_URL = "https://www.billybishopairport.com/flights/departures/";
const ADSB_URL = "https://api.airplanes.live/v2/point/43.6275/-79.3962/250";

const YTZ = { lat: 43.6275, lon: -79.3962 };
const SWEEP_MS = 10_000;   // radar sample interval inside one invocation
const SWEEPS = 5;          // 5 sweeps + the initial one ≈ one minute
const BOARD_EVERY = 6;     // re-read the airport board once per invocation

/* ---------------- reference data ---------------- */
const US_AIRPORTS: Record<string, { code: string; city: string }> = {
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

const AIRLINES: Record<string, { name: string; callsigns: string[] }> = {
  PD: { name: "Porter", callsigns: ["PTR", "POE"] },
  AC: { name: "Air Canada", callsigns: ["JZA", "ACA", "ROU"] },
};

/* ---------------- helpers ---------------- */
function torontoDate(offsetDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" })
    .format(new Date(Date.now() + offsetDays * 86_400_000));
}

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const R = 6371, d = Math.PI / 180;
  const dLat = (b.lat - a.lat) * d, dLon = (b.lon - a.lon) * d;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function originInfo(origin: string) {
  const clean = origin.trim();
  const lower = clean.toLowerCase();
  for (const key of Object.keys(US_AIRPORTS)) {
    if (lower.startsWith(key)) return US_AIRPORTS[key];
  }
  const st = /,\s*([A-Z]{2})\s*$/.exec(clean);
  if (st && US_STATES.has(st[1])) {
    return { code: st[1], city: clean.replace(/,\s*[A-Z]{2}\s*$/, "") };
  }
  return null; // not a U.S. origin
}

type Row = { day: string; time: string; flight: string; origin: string; status: string };

function parseRows(html: string): Row[] {
  const rows: Row[] = [];
  const rowRe = /<tr[^>]*class=['"]item (Today|Tomorrow)['"][\s\S]*?<\/tr>/g;
  const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(html))) {
    const tds: string[] = [];
    let tm: RegExpExecArray | null;
    tdRe.lastIndex = 0;
    while ((tm = tdRe.exec(rm[0]))) tds.push(tm[1].replace(/<[^>]*>/g, "").trim());
    if (tds.length < 6) continue;
    const [, time, , flight, origin, status] = tds;
    if (!/^[A-Z]{2}\d{2,4}$/.test(flight)) continue;
    if (!/^\d{1,2}:\d{2}$/.test(time)) continue;
    rows.push({ day: rm[1], time, flight, origin, status });
  }
  return rows;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(`${url}?_=${Date.now()}`, {
    headers: { "User-Agent": "syedsgroup-ytz-board/1.0 (+ops dashboard)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return await res.text();
}

/* Match a scheduled flight to a live aircraft by callsign, guarding against
   look-alike callsigns from other airlines/routes. */
function matchAircraft(flightNo: string, acList: any[]) {
  const prefix = flightNo.slice(0, 2);
  const airline = AIRLINES[prefix];
  if (!airline) return null;
  const digits = flightNo.replace(/\D/g, "");
  const wanted = new Set<string>();
  for (const p of airline.callsigns) {
    wanted.add(p + digits);
    // Jazz sometimes drops the leading marketing digit: AC8548 -> JZA548
    if (p === "JZA" && digits.length === 4) wanted.add(p + digits.slice(1));
  }
  let best: any = null;
  for (const ac of acList) {
    const cs = (ac.flight || "").trim().toUpperCase();
    if (!wanted.has(cs)) continue;
    if (ac.lat == null || ac.lon == null) continue;
    if (!best || (ac.seen_pos ?? 99) < (best.seen_pos ?? 99)) best = ac;
  }
  return best;
}

/* ---------------- one sweep ---------------- */
async function sweep(sb: any, boardRows: Row[], serviceDate: string) {
  let acList: any[] = [];
  try {
    const res = await fetch(ADSB_URL, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) acList = (await res.json()).ac || [];
  } catch (_) { /* radar blip: keep board data, try again next sweep */ }

  const nowIso = new Date().toISOString();
  const updates: any[] = [];
  const events: any[] = [];

  // Existing rows so we never overwrite a touchdown we already recorded.
  const { data: existing } = await sb
    .from("flights")
    .select("id, touchdown_at, status")
    .eq("service_date", serviceDate);
  const known = new Map<string, any>((existing ?? []).map((r: any) => [r.id, r]));

  for (const r of boardRows) {
    if (r.day !== "Today") continue;
    const airline = AIRLINES[r.flight.slice(0, 2)];
    if (!airline) continue;                    // skip codeshare rows (TS…)
    const info = originInfo(r.origin);
    if (!info) continue;                       // U.S. origins only

    const id = `${serviceDate}|${r.flight}|${r.time}`;
    const prev = known.get(id);
    const statusLower = r.status.toLowerCase();

    const row: any = {
      id,
      service_date: serviceDate,
      flight_no: r.flight,
      airline: airline.name,
      origin_code: info.code,
      origin_city: info.city,
      est_local: r.time,
      status: r.status,
    };

    // ---- live radar ----
    const ac = matchAircraft(r.flight, acList);
    if (ac) {
      const dist = haversineKm({ lat: ac.lat, lon: ac.lon }, YTZ);
      const grounded = ac.alt_baro === "ground" ||
        (typeof ac.alt_baro === "number" && ac.alt_baro < 400 && (ac.gs ?? 999) < 80);
      row.aircraft_hex = ac.hex;
      row.aircraft_reg = ac.r ?? null;
      row.aircraft_type = ac.t ?? null;
      row.last_lat = ac.lat;
      row.last_lon = ac.lon;
      row.last_alt_ft = typeof ac.alt_baro === "number" ? ac.alt_baro : null;
      row.last_gs_kt = ac.gs ?? null;
      row.last_dist_km = Number(dist.toFixed(1));
      row.last_seen_at = nowIso;

      if (!grounded && (ac.gs ?? 0) > 40) {
        const minsOut = (dist / ((ac.gs || 200) * 1.852)) * 60 + 4;
        row.eta_predicted_at = new Date(Date.now() + minsOut * 60_000).toISOString();
      }

      // ---- canonical touchdown: on the ground, at the field, once only ----
      if (grounded && dist <= 4.5 && !prev?.touchdown_at) {
        row.touchdown_at = nowIso;
        row.touchdown_source = "adsb";
        row.touchdown_uncert_s = Math.round(SWEEP_MS / 2000);
        events.push({ flight_id: id, event_type: "landed",
          detail: { source: "adsb", dist_km: Number(dist.toFixed(2)), reg: ac.r ?? null } });
      }
    }

    // ---- board fallback: it flipped to Arrived and radar never saw it ----
    if (statusLower === "arrived" && !prev?.touchdown_at && !row.touchdown_at) {
      row.board_arrived_at = nowIso;
      if (prev && prev.status && prev.status.toLowerCase() !== "arrived") {
        row.touchdown_at = nowIso;
        row.touchdown_source = "board";
        row.touchdown_uncert_s = 300;           // board updates are coarse
        events.push({ flight_id: id, event_type: "landed", detail: { source: "board" } });
      }
    }

    if (statusLower === "cancelled" && prev && prev.status?.toLowerCase() !== "cancelled") {
      events.push({ flight_id: id, event_type: "cancelled", detail: { was_due: r.time } });
    }

    updates.push(row);
  }

  if (updates.length) {
    await sb.from("flights").upsert(updates, { onConflict: "id" });
  }
  if (events.length) {
    await sb.from("flight_events").insert(events);
  }
  return updates.length;
}

/* ---------------- publish the compact read payload ---------------- */
async function publishBoardState(sb: any, serviceDate: string, depRows: Row[]) {
  const { data: flights } = await sb
    .from("flights")
    .select("*")
    .in("service_date", [serviceDate, torontoDate(1)])
    .order("sched_local", { ascending: true });

  const cancellations = depRows
    .filter((r) => r.day === "Today" && r.status.toLowerCase() === "cancelled"
                   && !r.flight.startsWith("TS") && originInfo(r.origin))
    .map((r) => ({ flight: r.flight, time: r.time, origin: r.origin, direction: "departure" }));

  const payload = {
    v: 1,
    generated_at: new Date().toISOString(),
    service_date: serviceDate,
    flights: flights ?? [],
    departure_cancellations: cancellations,
  };

  await sb.from("board_state").upsert(
    { id: 1, payload, updated_at: new Date().toISOString() },
    { onConflict: "id" },
  );
}

/* ---------------- entry point ---------------- */
Deno.serve(async (_req) => {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const serviceDate = torontoDate();
  const started = Date.now();
  let sweeps = 0, tracked = 0;

  try {
    // Airport board: read once per invocation (it only changes ~1x/min).
    const [arrHtml, depHtml] = await Promise.all([
      fetchText(ARRIVALS_URL),
      fetchText(DEPARTURES_URL).catch(() => ""),
    ]);
    const arrRows = parseRows(arrHtml);
    const depRows = depHtml ? parseRows(depHtml) : [];

    if (arrRows.length < 5) throw new Error(`suspicious arrivals count: ${arrRows.length}`);

    // Preserve the original published schedule the first time we ever see a
    // flight; the airport mutates its time cell once a flight is delayed.
    const { data: existing } = await sb
      .from("flights").select("id, sched_local").eq("service_date", serviceDate);
    const haveSched = new Set((existing ?? []).filter((r: any) => r.sched_local).map((r: any) => r.id));
    const firstSeen = arrRows
      .filter((r) => r.day === "Today" && AIRLINES[r.flight.slice(0, 2)] && originInfo(r.origin))
      .map((r) => ({ id: `${serviceDate}|${r.flight}|${r.time}`, sched_local: r.time }))
      .filter((r) => !haveSched.has(r.id));

    // Radar sweeps across the minute.
    for (let i = 0; i <= SWEEPS; i++) {
      tracked = await sweep(sb, arrRows, serviceDate);
      sweeps++;
      if (firstSeen.length) {
        await sb.from("flights").upsert(firstSeen, { onConflict: "id", ignoreDuplicates: false });
      }
      if (i < SWEEPS) await new Promise((r) => setTimeout(r, SWEEP_MS));
    }

    await publishBoardState(sb, serviceDate, depRows);

    return Response.json({
      ok: true, service_date: serviceDate, sweeps, tracked,
      arrivals_parsed: arrRows.length, departures_parsed: depRows.length,
      ms: Date.now() - started,
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: String(err), sweeps, ms: Date.now() - started },
      { status: 500 },
    );
  }
});
