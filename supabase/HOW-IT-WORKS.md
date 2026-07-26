# How the whole thing works — plain English

Read this top to bottom once and you'll understand every moving part.

---

## 1. The big picture

There are only **three kinds of thing** in this system:

1. **Sources** — places the raw truth comes from (the airport, the radar network). We don't control these.
2. **The poller** — a small program that reads the sources every minute and writes down what it found.
3. **Storage + readers** — the database that holds the record, and the things that read it (your website, Power BI).

```
   ┌─────────────────────────┐        ┌──────────────────────────┐
   │  billybishopairport.com │        │    airplanes.live        │
   │  "the schedule board"   │        │  "the radar network"     │
   │                         │        │                          │
   │  flight #, origin,      │        │  every plane's live      │
   │  scheduled time, status │        │  lat/lon/altitude/speed  │
   └───────────┬─────────────┘        └────────────┬─────────────┘
               │                                   │
               │   read once a minute              │  read every 10 seconds
               └─────────────┬─────────────────────┘
                             ▼
              ┌──────────────────────────────────┐
              │   THE POLLER                     │
              │   (Supabase Edge Function)       │
              │                                  │
              │   • matches flights to planes    │
              │   • decides "this one landed"    │
              │   • writes everything down       │
              └──────────────┬───────────────────┘
                             ▼
              ┌──────────────────────────────────┐
              │   POSTGRES DATABASE (Supabase)   │
              │                                  │
              │   flights ......... the record   │
              │   flight_events ... the log      │
              │   board_state ..... fast snapshot│
              │   push_subscriptions .. phones   │
              └───────┬──────────────────┬───────┘
                      │                  │
                      ▼                  ▼
            ┌──────────────────┐  ┌────────────────┐
            │  YOUR WEBSITE    │  │   POWER BI     │
            │  (staff view it) │  │  (dashboards)  │
            └──────────────────┘  └────────────────┘
```

**The key idea:** the poller runs **once, on a server**. Not on each person's phone.
That's why everyone sees the same landing time — there's one brain making the
decision, not 50 phones each guessing separately.

---

## 2. Where the data actually comes from

### Source A — the airport's own board
`billybishopairport.com/flights/arrivals/`

This is a normal web page with a table on it. It gives us:
- flight number (`PD2938`)
- origin (`Boston, MA`)
- a time (this is the **scheduled** time, until the flight is delayed — then the
  airport *overwrites* it with the new estimate)
- status (`On Time` / `Delayed` / `Arrived` / `Cancelled`)

**What it does NOT give us:** the exact second the wheels touched the runway.
Its "Arrived" flips whenever someone/something updates it — could be minutes late.

### Source B — the radar network
`api.airplanes.live`

Every airliner constantly broadcasts its position, altitude, and speed over radio
(this is called **ADS-B**). Volunteers worldwide run receivers and pool the data.
It's free, and it's **the same raw data FlightAware sells**.

This gives us:
- exactly where each plane is, right now
- its altitude and speed
- whether it's on the ground

**This is how we know the real landing time.** Not by trusting a status label —
by watching the actual aircraft.

---

## 3. What the poller does, step by step

The file is `supabase/functions/poll/index.ts`. Here's the logic in order:

### Step 1 — read the airport board (once per run)
```ts
const [arrHtml, depHtml] = await Promise.all([
  fetchText(ARRIVALS_URL),
  fetchText(DEPARTURES_URL).catch(() => ""),
]);
const arrRows = parseRows(arrHtml);
```
`parseRows` digs the table rows out of the HTML and turns them into clean objects
like `{ flight: "PD2938", origin: "Boston, MA", time: "08:59", status: "Arrived" }`.

**Safety check:** if fewer than 5 rows come back, something is broken (page changed,
site down) — so we abort rather than wipe good data with garbage:
```ts
if (arrRows.length < 5) throw new Error(`suspicious arrivals count: ${arrRows.length}`);
```

### Step 2 — keep the ORIGINAL scheduled time
This is subtle but important. When a flight is delayed, the airport **replaces**
the time on their page. If we just copied it every minute, the original schedule
would be lost forever and you could never measure a delay.

So: the first time we ever see a flight, we save that time permanently and never
touch it again.
```ts
const firstSeen = arrRows
  .filter(...)
  .map((r) => ({ id: ..., sched_local: r.time }))
  .filter((r) => !haveSched.has(r.id));   // only if we've never recorded it
```

### Step 3 — read the radar (5–6 times per run)
Supabase's scheduler can only trigger something once a minute. But we want radar
every 10 seconds. Solution: the function triggers once a minute, then **loops
internally** with 10-second gaps:
```ts
for (let i = 0; i <= SWEEPS; i++) {
  tracked = await sweep(sb, arrRows, serviceDate);
  if (i < SWEEPS) await new Promise((r) => setTimeout(r, SWEEP_MS)); // wait 10s
}
```
One trigger per minute → six radar samples per minute.

### Step 4 — match each flight to a real plane
A flight number like `AC8548` is a *marketing* number. Over the radio the plane
identifies itself differently — Air Canada's regional flights broadcast as `JZA`,
Porter as `PTR` or `POE`. And sometimes a digit gets dropped (`AC8548` → `JZA548`).

So we build a list of every callsign it *could* be, then look for it:
```ts
for (const p of airline.callsigns) {
  wanted.add(p + digits);
  if (p === "JZA" && digits.length === 4) wanted.add(p + digits.slice(1));
}
```

### Step 5 — decide if it landed  ← **this is the important part**
Two conditions must BOTH be true:
```ts
const grounded = ac.alt_baro === "ground" ||
  (typeof ac.alt_baro === "number" && ac.alt_baro < 400 && (ac.gs ?? 999) < 80);

if (grounded && dist <= 4.5 && !prev?.touchdown_at) {
  row.touchdown_at = nowIso;
  row.touchdown_source = "adsb";
}
```
- **`grounded`** — the plane reports being on the ground (or is below 400 ft and
  slower than 80 knots, which only happens on a runway)
- **`dist <= 4.5`** — it's within 4.5 km of Billy Bishop. This stops us recording
  a "landing" while the plane is still sitting at Newark before departure.
- **`!prev?.touchdown_at`** — we haven't already recorded a landing for this
  flight. **A landing time is written once and never overwritten.**

### Step 6 — fallback if radar missed it
Planes occasionally have transponder gaps. If radar never caught it but the
airport board flips to `Arrived`, we record that instead — but we **label it
honestly** as a less precise source:
```ts
row.touchdown_source = "board";
row.touchdown_uncert_s = 300;   // ±5 minutes, because board updates are coarse
```
That's why your board shows small notes like *"detected · ADS-B radar"* vs
*"airport board"* — so you always know how much to trust the number.

---

## 4. Every table — what fills it, what reads it

| Table | Who WRITES to it | Who READS it | What's in it |
|---|---|---|---|
| **`flights`** | The poller, automatically | Website, Power BI | One row per flight per day. The master record. |
| **`flight_events`** | The poller, automatically | Power BI / audits | Permanent log: "PD2938 landed at 08:46, source ADS-B". Never edited. |
| **`board_state`** | The poller, automatically | Website | A single row holding a JSON snapshot of everything. Exists purely for speed — the site grabs one row instead of running a big query. |
| **`push_subscriptions`** | **The website**, when a staff member taps "enable alarms" | The alarm sender | Each phone's push address. Locked down — no public read access, since these are device identifiers. |

### Inside `flights`, columns fall into three groups

**Group 1 — filled automatically from the airport board:**
`flight_no`, `airline`, `origin_code`, `origin_city`, `sched_local`, `est_local`, `status`

**Group 2 — filled automatically from radar:**
`touchdown_at` ← *the real landing time*
`touchdown_source`, `touchdown_uncert_s`, `aircraft_hex`, `aircraft_reg`,
`aircraft_type`, `last_lat`, `last_lon`, `last_alt_ft`, `last_gs_kt`,
`last_dist_km`, `eta_predicted_at`

**Group 3 — YOU fill these in (nothing public publishes them):**
`pax_count` ← passenger count from your morning paper sheet
`crew_count`
`first_pax_at` ← when the first passenger hit the hall
`last_pax_at` ← when the last one did
`gate`, `notes`

Group 3 is already built into the table, so when you start logging passenger
counts there's nothing to rebuild — the Power BI views are already reading those
columns.

---

## 5. The three views — calculated, not stored

A **view** is a saved question, not a copy of data. It runs fresh every time you
look at it. So there's no syncing, no stale exports.

### `v_flight_performance` — one row per flight, with the math done
Reads `flights`, adds:
- **`delay_minutes`** — landing time minus original schedule.
  Negative = early. This is why Step 2 (preserving the original time) mattered.
- **`hall_process_minutes`** — `last_pax_at` minus `first_pax_at`
- **`touchdown_local`** — the UTC timestamp converted to Toronto time
  (handles daylight saving automatically)

### `v_daily_summary` — one row per day
Reads `v_flight_performance` and counts things up: total flights, cancelled
flights, total passengers, average delay, Porter vs Air Canada split.
→ These are the big number tiles on your dashboard.

### `v_origin_summary` — one row per airport per day
Flights and passengers grouped by origin.
→ This is your "Passengers by Origin Airport" bar chart.

---

## 6. How the website connects

**Right now:** your site reads a JSON file that GitHub rebuilds every 5 minutes.
That's why it's fast, but landing times are decided independently on each device.

**Once we wire Supabase in**, it becomes:

```
website  ──GET──▶  board_state table  ──▶  one JSON row  ──▶  render the board
             (using the publishable key, read-only)
```

The website will use the **publishable key** — the safe one you sent me. It can
only *read*, and only the tables we explicitly marked readable. That's enforced by
**Row Level Security** — rules living inside the database itself:

```sql
create policy "public read flights" on public.flights for select using (true);
```
Translation: "anyone may SELECT (read) from flights." There is deliberately **no**
insert/update/delete policy, so even if someone grabbed the publishable key from
your website's code, **they could not change a single row.** Writing requires the
secret key, which lives only on the server.

Note `push_subscriptions` has **no read policy at all** — staff phone addresses
aren't public, not even readable.

**Important:** I'll keep the current GitHub feed as an automatic fallback. If
Supabase ever hiccups, the board keeps working off the old path instead of going
blank.

---

## 7. How Power BI connects

Power BI does **not** go through the website. It talks straight to the database:

```
Power BI  ──▶  PostgreSQL  ──▶  the three v_ views
   server:   db.crrrykfftzlzymmmawsn.supabase.co
   database: postgres
   user:     postgres
   password: (the one you saved — never sent to me)
```

Hit Refresh in Power BI and the numbers update, because the views recalculate
live. No CSV exports, no copy-paste.

---

## 8. Automatic vs manual — the honest split

| Automatic, forever, no human | You (or staff) enter once per flight |
|---|---|
| Flight number, origin, schedule | Passenger count |
| Delays, cancellations | First / last passenger in hall |
| **Exact landing time** | Gate, notes |
| Aircraft type & registration | Crew count |
| All delay & on-time math | |
| Daily/monthly rollups for Power BI | |

The whole point: the tedious part (watching flights, recording times) becomes
automatic. The part only a human knows (how many people walked through the hall)
stays a quick entry — and lands in the same database, so your dashboards see both
halves together.
