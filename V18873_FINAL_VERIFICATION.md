# Gigorave V188.73 final verification

Build: `events-v18873-vision-poster-dom-ai-audit-r1`  
Package: `0.188.73`

This supersedes `Gigorave_V18873_full_candidate.zip`. The candidate was intentionally packaged while the active suite still contained 7 failures; it must not be used as the final release.

## Poster/media contract

- Source membership, image dimensions, or being the only source image are not proof that an image is an event poster.
- Event-level media requires explicit vision/manual verification.
- Multi-event posts use per-image vision facts and deterministic image-to-child-event matching.
- One image is not blindly assigned to multiple child events.
- DOM/media identity, local file mapping, vision output and final assignment are logged for forensic reconstruction.
- Source media remains preserved even when an unsafe event-level binding is cleared.
- A forced legacy media repair cannot re-promote source-only heuristic bindings; V188.73 vision-only safety is applied in the same call.

## Verification

- `npm run test:active`: **119/119 passed**.
- `npm run test:v18873`: **19/19 passed**.
- `npm run check:imports`: **OK (481 files)**.
- `npm run check:named-imports`: **OK (178 files, 0 missing)**.
- `npm run check:docs`: **OK (43 files)**.
- `npm run check:release-clean`: **OK**.
- Syntax: **481/481 JS/MJS/CJS files passed `node --check`** using parallel execution. The repository's sequential `npm run check:syntax` is functionally equivalent but exceeds this environment's command timeout because it starts a new Node process serially for every file.

## Active-suite expectation updates

The seven failures from the candidate were resolved rather than hidden:

1. Build-id assertion updated from V188.72 to V188.73.
2. Poster reason assertion updated to the stronger `date+title-phrase` reason.
3. The old test that blindly shared one calendar image among several child events was changed to the V188.73 one-to-one safety contract.
4. Legacy source-only poster statuses are now audit-only; only vision/manual statuses are delivery-safe.
5. Cross-post dedupe no longer merges unverified source photos into event media.
6. Clean-media recovery preserves source files but does not promote them to event posters without vision.
7. Historical collapsed-schedule repair no longer invents poster assignments without verified matching.

Additionally, a real code conflict was fixed: `backfillCleanLegacyPosterBindingsV18868({force:true})` could re-promote unsafe legacy media after V188.73 had invalidated it. Forced repair now immediately reapplies the V188.73 vision-only invalidation, so parser-all/repair cannot resurrect arbitrary photos.
