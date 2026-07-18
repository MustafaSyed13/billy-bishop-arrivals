# YTZ · U.S. Arrivals — Billy Bishop Live Board

A zero-backend, auto-updating arrivals board for **Billy Bishop Toronto City Airport (YTZ)**, showing **U.S.-origin flights only** (Porter & Air Canada).

**Live page:** https://mustafasyed13.github.io/ytz-arrivals/

## What it shows

| Column | Source |
|---|---|
| Sched / Flight / Airline / From / Status | Billy Bishop's official arrivals feed (refreshed every 60 s) |
| ETA (AM/PM) | Airport feed, refined live from the aircraft's actual position & speed when airborne |
| **ATA** | Detected live from the plane's ADS-B transponder — the page stamps the touchdown the moment the aircraft is on the ground at YTZ (radar polled every 20 s) |
| Gate | YTZ does not publish arrival gates in any public feed, so this stays "—" |

The page updates itself — no refresh needed. Click any row for live telemetry (altitude, speed, distance out, route progress).

## How it works

- **Schedule/status:** `billybishopairport.com/flights/arrivals/` fetched through free CORS-friendly readers (`r.jina.ai`, with `allorigins` / `codetabs` fallbacks), parsed client-side.
- **Live positions:** [airplanes.live](https://airplanes.live) community ADS-B API (free, no key), 250 nm around YTZ. Flights are matched by callsign (Porter `PTR`/`POE`, Air Canada Jazz `JZA`) with a Dash-8 type check.
- **ATA logic:** radar touchdown (best) → board status flip to "Arrived" while watching (approx) → airport's own updated time (approx). ATAs persist in `localStorage`.

Everything is static — GitHub Pages hosts three files (`index.html`, `style.css`, `app.js`). No build step, no server, no API keys.

## Disclaimer

Unofficial, informational only — always confirm with your airline or the airport.
