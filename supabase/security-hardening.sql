-- =====================================================================
--  SECURITY HARDENING — run once in Supabase → SQL Editor
--
--  Problem this fixes:
--  The `flights` table was directly readable by the anonymous (publishable)
--  key that ships in the website's source. That table also carries columns
--  intended for internal operations — pax_count, crew_count, first_pax_at,
--  last_pax_at, gate, notes. They are empty today, but the moment anyone put
--  real operational data in them it would have been world-readable.
--
--  Fix: the public role loses direct table access and can only read a curated
--  view containing public aviation information. Operational columns are not
--  in the view, so they cannot be selected, guessed, or enumerated.
--
--  This is defence in depth: even a leaked publishable key exposes nothing
--  beyond what the airport already publishes plus public ADS-B observations.
-- =====================================================================

-- ---------- 1. Public view: public information only ----------
drop view if exists public.public_board cascade;

create view public.public_board as
select
  f.id,
  f.service_date,
  f.flight_no,
  f.airline,
  f.origin_code,
  f.origin_city,
  f.sched_local,                 -- original published schedule
  f.est_local,                   -- airport's current estimate
  f.status,                      -- airport-published status
  f.touchdown_at,                -- observed arrival (see arrival_method)
  f.touchdown_source,
  f.touchdown_uncert_s,
  f.eta_predicted_at,            -- independent ADS-B prediction
  -- Publicly observable ADS-B telemetry (broadcast in the clear by aircraft)
  f.aircraft_hex,
  f.aircraft_reg,
  f.aircraft_type,
  f.last_lat,
  f.last_lon,
  f.last_alt_ft,
  f.last_gs_kt,
  f.last_dist_km,
  f.last_seen_at,
  f.updated_at
  -- DELIBERATELY EXCLUDED: pax_count, crew_count, first_pax_at, last_pax_at,
  -- gate, notes, board_arrived_at. These are operational, not public.
from public.flights f;

alter view public.public_board set (security_invoker = true);

-- ---------- 2. Revoke direct table access from the public role ----------
revoke select on public.flights       from anon;
revoke select on public.flight_events from anon;

drop policy if exists "public read flights" on public.flights;
drop policy if exists "public read events"  on public.flight_events;

-- board_state stays readable: it is the sanitized snapshot the site renders.
-- (Its payload is assembled by the collector from public fields only.)

-- ---------- 3. Grant only the curated surface ----------
grant select on public.public_board to anon, authenticated;

-- Reporting views remain available for Power BI, which connects with the
-- database password rather than the publishable key.
revoke select on public.v_flight_performance from anon;
revoke select on public.v_daily_summary      from anon;
revoke select on public.v_origin_summary     from anon;
grant  select on public.v_flight_performance to authenticated;
grant  select on public.v_daily_summary      to authenticated;
grant  select on public.v_origin_summary     to authenticated;

-- ---------- 4. Verify ----------
-- After running, this should return ONLY: board_state, public_board
select table_name
from information_schema.role_table_grants
where grantee = 'anon' and privilege_type = 'SELECT' and table_schema = 'public'
order by table_name;
