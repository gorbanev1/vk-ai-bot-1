# Gigorave V188.75 — protected DIESEL venue boundary

V188.75 is a focused dedupe correction on top of V188.74.

## Owner venue rule

Generic venue-type words remain non-identifying for normal venues: `бар`, `паб`, `pub`, `club`, `клуб`, `hall`, `зал`, `venue`, etc. are stripped from ordinary venue identity, so examples such as `Бар Крылья` and `Клуб Крылья` still compare by the meaningful core `Крылья`.

There is one explicit protected physical-space rule for the DIESEL brand:

- `Rock Bar DIESEL`, `Diesel Bar`, `DIESEL BAR`, `Дизель бар`, `Dizel pub` => DIESEL Bar space.
- `DIESEL HALL`, `Diesel Hall`, `Дизель холл`, `Дизель зал` => DIESEL Hall space.
- DIESEL Bar and DIESEL Hall are always different venues.

This hard venue boundary is evaluated before title/date/provenance shortcuts. It therefore cannot be overridden by an identical event title, date, participants, a shared `canonicalPostUrl`, or the final same-day parser-all sweep.

The second-contour AI prompt carries the same rule, although deterministic hard conflicts prevent the pair from reaching AI arbitration in the normal path.

## Snapshot invalidation

`EVENT_DEDUPE_ALGORITHM_VERSION` is bumped to `event-dedupe-v18875-diesel-space-boundary-1`, and the runtime build identifier is bumped to `events-v18875-diesel-venue-boundary-r1` so old dedupe snapshots are not reused under the changed venue contract.
