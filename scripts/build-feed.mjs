// Fetches the Billy Bishop arrivals + departures pages and emits out/board.json.
// Runs inside GitHub Actions every ~5 minutes; the site reads the result from
// the `data` branch via raw.githubusercontent.com, so browsers never depend on
// CORS proxies for first paint. Exits non-zero on a bad parse so the previous
// good feed stays in place.
import { mkdir, writeFile } from "node:fs/promises";

const PAGES = {
  arrivals: "https://www.billybishopairport.com/flights/arrivals/",
  departures: "https://www.billybishopairport.com/flights/departures/",
};

const UA = "Mozilla/5.0 (compatible; billy-bishop-arrivals-feed; +https://github.com/MustafaSyed13/billy-bishop-arrivals)";

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
    const [_, time, __, flight, origin, status] = [tds[0], tds[1], tds[2], tds[3], tds[4], tds[5]];
    if (!/^[A-Z]{2}\d{2,4}$/.test(flight)) continue;
    if (!/^\d{1,2}:\d{2}$/.test(time)) continue;
    rows.push({ day: rm[1], time, flight, origin, status });
  }
  return rows;
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return await res.text();
}

const arrivals = parseRows(await fetchPage(PAGES.arrivals));
const departures = parseRows(await fetchPage(PAGES.departures));

// Sanity gates: a normal day has dozens of rows. Refuse to publish junk.
if (arrivals.length < 5) throw new Error(`suspicious arrivals row count: ${arrivals.length}`);
if (departures.length < 5) throw new Error(`suspicious departures row count: ${departures.length}`);

const feed = {
  v: 1,
  fetchedAt: new Date().toISOString(),
  arrivals,
  departures,
};

await mkdir("out", { recursive: true });
await writeFile("out/board.json", JSON.stringify(feed));
console.log(`feed ok: ${arrivals.length} arrivals, ${departures.length} departures`);
