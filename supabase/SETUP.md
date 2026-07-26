# Backend setup — Supabase (free tier)

Everything here is free. Total time: about 15 minutes.
You only need to do **Part 1**; send me the two values at the end of it and I'll do the rest.

---

## Part 1 — Create the project  *(you do this)*

1. Go to **https://supabase.com** → **Start your project** → sign in with GitHub.
2. Click **New project**.
   - **Name:** `ytz-arrivals`
   - **Database password:** click *Generate*, then **save it somewhere safe** — you'll need it for Power BI later.
   - **Region:** `East US (North Virginia)` — closest to Toronto with lowest latency.
   - **Plan:** Free
3. Wait ~2 minutes while it provisions.
4. Go to **Project Settings → API** and copy these two values:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - **anon / public** key (a long `eyJ...` string)

> The **anon key is safe to share with me and safe to put in the website** — it only
> allows reading data that we explicitly mark public. Never share the
> `service_role` key or the database password.

**Send me the Project URL and the anon key, and I'll finish Parts 2–4.**

---

## Part 2 — Create the tables  *(I do this, or you can)*

Supabase → **SQL Editor** → **New query** → paste the entire contents of
`schema.sql` → **Run**. You should see `Success. No rows returned`.

This creates:

| Object | Purpose |
|---|---|
| `flights` | One row per flight per day — the system of record |
| `flight_events` | Audit trail: landed / cancelled / delayed |
| `board_state` | Compact JSON the website reads (fast path) |
| `push_subscriptions` | Devices signed up for the 10-minute landing alarm |
| `v_flight_performance` | **Power BI reads this** — per-flight with delay minutes |
| `v_daily_summary` | **Power BI reads this** — daily totals, cancellations, pax |
| `v_origin_summary` | **Power BI reads this** — passengers by origin airport |

---

## Part 3 — Deploy the poller

Install the CLI once:

```bash
npm install -g supabase
```

Then from the repo root:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy poll --no-verify-jwt
```

`YOUR_PROJECT_REF` is the subdomain in your Project URL
(`https://abcdefgh.supabase.co` → `abcdefgh`).

---

## Part 4 — Schedule it every minute

Supabase → **SQL Editor** → run this once (replace both placeholders):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'ytz-poll',
  '* * * * *',           -- every minute; the function itself sweeps radar every 10s
  $$
  select net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/poll',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb
  );
  $$
);
```

Check it's alive:

```sql
select * from cron.job_run_details order by start_time desc limit 5;
select updated_at, jsonb_array_length(payload->'flights') as flights from board_state;
```

---

## Part 5 — Connect Power BI  *(when you're ready for dashboards)*

1. Power BI Desktop → **Get Data** → **PostgreSQL database**
2. **Server:** `db.YOUR_PROJECT_REF.supabase.co`  **Database:** `postgres`
3. **Username:** `postgres`  **Password:** the database password from Part 1
4. Import the three `v_` views — they're already shaped for charts:
   - `v_daily_summary` → Total Passengers, Total Flights, Cancelled Flights tiles
   - `v_flight_performance` → delay analysis, on-time %, per-flight detail
   - `v_origin_summary` → Passengers by Origin Airport bar chart

Because these are **views**, they always reflect live data — refresh in Power BI
and the numbers update. No exports, no copy-paste.

---

## Filling in passenger counts

The public feeds don't publish passenger numbers, so those come from your sheets.
Two options once the backend is live:

- **Manual:** the Daily Sheet page gets a "Save to database" button — type the PAX
  counts once and they're stored permanently against that flight.
- **Bulk:** paste a day's counts and they're matched to flights by number + date.

Either way it lands in `flights.pax_count`, which the Power BI views already read.

---

## What this costs

Everything above fits inside Supabase's free tier:

| Resource | Free allowance | This project uses |
|---|---|---|
| Database | 500 MB | ~1 MB per year of flight history |
| Edge function calls | 500,000/month | ~43,000/month (1/minute) |
| Egress | 5 GB/month | depends on staff count — see note below |
| Realtime connections | 200 concurrent | only if we enable live push |

**Note on scale:** a single free project comfortably serves your whole staff.
If usage ever outgrows the egress allowance, the fix is a caching layer in front
(free), not a paid plan.
