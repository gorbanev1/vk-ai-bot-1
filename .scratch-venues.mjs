import { DatabaseSync } from "node:sqlite";
const db=new DatabaseSync("data/bot.sqlite",{readOnly:true});
for(const r of db.prepare("SELECT venue, COUNT(*) n FROM vk_events WHERE TRIM(COALESCE(venue,''))<>'' GROUP BY venue ORDER BY lower(venue)").all()) console.log(JSON.stringify(r));
