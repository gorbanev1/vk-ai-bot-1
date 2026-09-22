# V188.75 verification

Release identity:
- package: `0.188.75`
- build: `events-v18875-diesel-venue-boundary-r1`
- dedupe algorithm: `event-dedupe-v18875-diesel-space-boundary-1`

## Venue contract verified

- `Diesel Bar`, `Rock Bar DIESEL`, `Дизель бар`, `Dizel pub` are the protected DIESEL Bar space.
- `DIESEL HALL`, `Diesel Hall`, `Дизель холл`, `Дизель зал` are the protected DIESEL Hall space.
- Bar-space vs Hall-space is a deterministic `different-venue` hard conflict.
- Identical title/date/participants cannot override it.
- Shared `canonicalPostUrl` cannot override it.
- Final parser-all same-day sweep cannot override the hard conflict because it reuses deterministic comparison.
- Ordinary venue type words remain ignored for non-protected brands (`Бар Крылья` == `Клуб Крылья` by meaningful venue core).

## Tests/checks

- `npm run test:v18875`: **13/13 passed**.
- `npm run test:active`: **120/120 passed**.
- Full syntax (`node --check`, all `src/tests/scripts`, parallelized in the verification harness): **483/483 passed**.
- Import check: **OK (483 files)**.
- Named import check: **OK (178 files, missing=0)**.
- Documentation links: **OK (48 files)**.
- Release runtime-data guard: **OK**.

The repository's sequential `npm run check:syntax` launches one Node process per file and exceeded the execution harness wall-clock limit; the same `node --check` operation was therefore run over all 483 files in parallel and completed with zero failures.
