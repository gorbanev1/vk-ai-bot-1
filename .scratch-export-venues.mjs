import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
const db = new DatabaseSync("data/bot.sqlite", { readOnly: true });
const cols = db.prepare("PRAGMA table_info(vk_events)").all().map((x) => x.name);
const dateCol = cols.includes("event_date") ? "event_date" : (cols.includes("date") ? "date" : "created_at");
const rows = db.prepare("SELECT venue, COUNT(*) AS count, MIN(" + dateCol + ") AS firstDate, MAX(" + dateCol + ") AS lastDate FROM vk_events WHERE TRIM(COALESCE(venue, '')) <> '' GROUP BY venue ORDER BY lower(venue)").all();
writeFileSync("data/event-venue-catalog.json", JSON.stringify({ generatedAt: new Date().toISOString(), source: "vk_events", totalDistinctVenues: rows.length, venues: rows }, null, 2));
console.log(JSON.stringify({ totalDistinctVenues: rows.length, dateCol }));
