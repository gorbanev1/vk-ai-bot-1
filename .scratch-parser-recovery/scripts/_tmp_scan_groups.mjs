await import('dotenv/config');
const { runEventDedupeMaintenanceForCurrentDatabase } = await import('../src/app/botApplication.js');
const result = await runEventDedupeMaintenanceForCurrentDatabase({ apply: false });
console.log(JSON.stringify(result.groups.map((g) => ({date:g.canonical?.eventDate,keep:g.keep,members:g.members.map((m)=>m.ref),titles:g.members.map((m)=>m.title)})).filter((g)=>g.titles.some((t)=>/origami|центр осени|манагер/iu.test(t))),null,2));
