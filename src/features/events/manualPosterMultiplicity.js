// A photo is a source, not an event-count boundary.
export function manualPosterEvents(parsed) {
 const events=Array.isArray(parsed?.events)?parsed.events:parsed?.event?[parsed.event]:[];
 const structure=String(parsed?.structure||'');
 if(['not_event','uncertain'].includes(structure))return [];
 if(events.length>30)throw new Error('Manual poster event count exceeds 30');
 return events.filter(event=>event&&typeof event==='object'&&!Array.isArray(event)).map(event=>({
  ...event,structureDecision:structure|| (events.length>1?'multiple_events':'single_event'),
  structureReason:String(parsed?.structure_reason||''),sourceSegmentText:String(event.source_segment||''),
  isMultiAnnouncement:events.length>1||structure==='multiple_events',
 }));
}
export function manualPosterHint(event,hints,eventCount) {
 const date=String(event.date||event.eventDate||'');
 const matching=date?hints.filter(hint=>hint.date===date):[];
 if(matching.length===1)return matching[0];
 return eventCount===1&&hints.length===1&&(!date||!hints[0].date||hints[0].date===date)?hints[0]:{};
}
