# Archive — not in production

## DEPRECATED-supabase-edge-poll.ts
An earlier collector written as a Supabase Edge Function. **Never deployed.**
Superseded by `scripts/sync-supabase.mjs`, which runs on GitHub Actions and
needs no CLI install or login.

Kept only for reference. It contains its own copy of the airport table with the
**incorrect** `washington -> DCA` mapping — the exact class of bug that motivated
moving all reference data into `shared/airports.json`. Do not resurrect this file
without first pointing it at the shared table.

**There is exactly one active collector: `scripts/sync-supabase.mjs`.**
