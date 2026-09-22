# Gigorave V188.63 — two-stage body + poster-vision AI gate

Build: `0.188.63`.

## What changed

The strict V188.62 body gate remains the first and cheapest stage. If the body does not contain enough evidence but the captured item has an image, parser-all now runs a narrow poster-vision gate **after every configured source has finished durable raw capture/cache** and before the main event-AI processing queue is released.

Poster gate reads only the image. It does not receive the post body, publication timestamp text or browser UI metadata. Its output is intentionally limited to:

- `Это афиша события: да/нет`
- `Название`
- `Дата`
- `Время`

An image can rescue an otherwise rejected item only when poster vision identifies an event poster with usable title/participants and at least one today/future event date. Past-only posters, images with no date/title and explicit `не афиша` results stay out of main AI.

Pure image announcements are recoverable now: a post such as `Ждём всех 🔥` plus a real dated poster can enter the queue even when the body has no date/title. The image itself must pass the poster gate; image presence alone is not enough.

## Capture/AI separation

The order is now:

1. capture all VK/Telegram raw DOM/messages/posts;
2. write durable raw cache and close finite source tabs;
3. run bounded poster-gate vision for body-rejected items with images;
4. recompute final admission and write the AI queue audit;
5. release the main event processing/AI queue.

This preserves the rule that model calls do not compete with browser capture.

## Diagnostics

Owner output now includes:

- how many images were checked by poster gate;
- how many items were rescued only by poster evidence;
- queue previews marked `источник: текст` or `источник: афиша`;
- `run-ai-queue.audit.txt`, including items blocked after poster gate and the exact poster-gate rejection reason;
- the machine-readable queue report with `dateSource=poster-vision`, `admissionPath=poster-vision-rescue`, body rejection reason and poster evidence.

Publication/UI timestamps still cannot create an event date. `publishedAt` can only disambiguate the year after a day/month has already been visibly found in body/poster evidence.

## Cost controls

Poster gate is deliberately narrow and cheaper than the main extraction pass. Defaults:

- concurrency: `MANUAL_PARSER_POSTER_GATE_CONCURRENCY=3`;
- at most `MANUAL_PARSER_POSTER_GATE_MAX_IMAGES=3` images per item;
- no advanced-model escalation for the poster gate itself.

The normal full poster extraction remains downstream for items that actually pass admission.

## Regression

- `npm run check:syntax` — PASS
- `npm run check:imports` — PASS
- `npm run check:named-imports` — PASS
- `npm run check:docs` — PASS
- `npm run test:v18863` — **41/41 PASS**
