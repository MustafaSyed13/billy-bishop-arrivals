-- =====================================================================
--  YTZ Arrivals — canonical backend schema  (SYED'S GROUP)
--  Run this once in Supabase → SQL Editor → New query → Run.
--
--  Design notes:
--   * flights   = one row per real flight per day. This is the system of
--                 record that Power BI / SQL reporting reads from later.
--   * events    = immutable audit trail (landed, cancelled, delayed...).
--   * board_state = single row holding the compact JSON the website reads,
--                 so the read path is one tiny query instead of a join.
--   * All timestamps are stored in UTC (timestamptz). Toronto local time is
--     derived on read via AT TIME ZONE 'America/Toronto' so DST is automatic.
-- =====================================================================

-- ---------- flights: the system of record ----------
create table if not exists public.flights (
  id                  text primary key,          -- '2026-07-26|PD2938|08:59'
  service_date        date        not null,      -- Toronto calendar day
  flight_no           text        not null,      -- 'PD2938'
  airline             text        not null,      -- 'Porter' | 'Air Canada'
  origin_code         text,                      -- 'BOS'
  origin_city         text,                      -- 'Boston, MA'
  sched_local         text,                      -- '08:59' original published
  est_local           text,                      -- '08:46' airport's live estimate
  status              text,                      -- On Time/Delayed/Arrived/Cancelled
  -- canonical arrival truth --------------------------------------------
  touchdown_at        timestamptz,               -- exact wheels-down (UTC)
  touchdown_source    text,                      -- 'adsb' | 'board'
  touchdown_uncert_s  integer,                   -- +/- seconds confidence
  board_arrived_at    timestamptz,               -- when board first said Arrived
  -- live tracking snapshot ---------------------------------------------
  aircraft_hex        text,
  aircraft_reg        text,
  aircraft_type       text,
  last_lat            double precision,
  last_lon            double precision,
  last_alt_ft         integer,
  last_gs_kt          double precision,
  last_dist_km        double precision,
  last_seen_at        timestamptz,
  eta_predicted_at    timestamptz,               -- predicted touchdown (UTC)
  -- operations columns you'll fill in later -----------------------------
  pax_count           integer,
  crew_count          integer,
  first_pax_at        timestamptz,
  last_pax_at         timestamptz,
  gate                text,
  notes               text,
  --
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists flights_service_date_idx on public.flights (service_date desc);
create index if not exists flights_flight_no_idx    on public.flights (flight_no);
create index if not exists flights_touchdown_idx    on public.flights (touchdown_at);

-- ---------- events: immutable audit trail ----------
create table if not exists public.flight_events (
  id           bigserial primary key,
  flight_id    text        not null references public.flights(id) on delete cascade,
  event_type   text        not null,   -- 'landed' | 'cancelled' | 'delayed' | 'final_approach'
  detail       jsonb,
  occurred_at  timestamptz not null default now()
);
create index if not exists flight_events_flight_idx on public.flight_events (flight_id, occurred_at desc);

-- ---------- board_state: the fast read path ----------
create table if not exists public.board_state (
  id          integer primary key default 1,
  payload     jsonb       not null,
  updated_at  timestamptz not null default now(),
  constraint board_state_singleton check (id = 1)
);

-- ---------- push subscribers (for the 10-minute alarm) ----------
create table if not exists public.push_subscriptions (
  id           bigserial primary key,
  endpoint     text unique not null,
  p256dh       text not null,
  auth         text not null,
  label        text,                      -- optional: staff name/station
  created_at   timestamptz not null default now(),
  last_sent_at timestamptz
);

-- =====================================================================
--  Reporting views — point Power BI at these
-- =====================================================================

-- Per-flight performance, in Toronto local time, ready for a dashboard.
create or replace view public.v_flight_performance as
select
  f.service_date,
  f.flight_no,
  f.airline,
  f.origin_code,
  f.origin_city,
  f.sched_local,
  to_char(f.touchdown_at at time zone 'America/Toronto', 'HH24:MI') as touchdown_local,
  f.touchdown_source,
  f.status,
  f.pax_count,
  f.crew_count,
  case when f.status ilike 'cancelled' then true else false end as is_cancelled,
  -- minutes late vs the original published schedule (negative = early)
  case
    when f.touchdown_at is null or f.sched_local is null then null
    else round(extract(epoch from (
           (f.touchdown_at at time zone 'America/Toronto')
           - (f.service_date + f.sched_local::time)
         )) / 60.0)::int
  end as delay_minutes,
  case
    when f.first_pax_at is not null and f.last_pax_at is not null
      then round(extract(epoch from (f.last_pax_at - f.first_pax_at)) / 60.0)::int
    else null
  end as hall_process_minutes
from public.flights f;

-- One row per day: the numbers your summary dashboard wants.
create or replace view public.v_daily_summary as
select
  service_date,
  count(*)                                              as total_flights,
  count(*) filter (where status ilike 'cancelled')      as cancelled_flights,
  count(*) filter (where touchdown_at is not null)      as landed_flights,
  sum(pax_count)                                        as total_pax,
  round(avg(delay_minutes) filter (where delay_minutes is not null), 1) as avg_delay_minutes,
  count(*) filter (where airline = 'Porter')            as porter_flights,
  count(*) filter (where airline = 'Air Canada')        as air_canada_flights
from public.v_flight_performance
group by service_date
order by service_date desc;

-- Busiest origins, for the "Passengers by Origin Airport" chart.
create or replace view public.v_origin_summary as
select
  service_date,
  origin_code,
  count(*)         as flights,
  sum(pax_count)   as total_pax
from public.v_flight_performance
where origin_code is not null
group by service_date, origin_code
order by service_date desc, total_pax desc nulls last;

-- =====================================================================
--  Security: public site may READ, only the service key may WRITE.
-- =====================================================================
alter table public.flights            enable row level security;
alter table public.flight_events      enable row level security;
alter table public.board_state        enable row level security;
alter table public.push_subscriptions enable row level security;

drop policy if exists "public read flights"     on public.flights;
drop policy if exists "public read events"      on public.flight_events;
drop policy if exists "public read board_state" on public.board_state;

create policy "public read flights"     on public.flights            for select using (true);
create policy "public read events"      on public.flight_events      for select using (true);
create policy "public read board_state" on public.board_state        for select using (true);
-- push_subscriptions intentionally has NO public select policy (contains
-- device endpoints). Inserts happen through an edge function only.

-- Keep updated_at honest.
create or replace function public.touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end $$ language plpgsql;

drop trigger if exists flights_touch on public.flights;
create trigger flights_touch before update on public.flights
  for each row execute function public.touch_updated_at();
