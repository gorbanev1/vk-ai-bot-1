# Gigorave V188.72 — VK photo identity + source reload

Build: `events-v18872-vk-photo-id-reload-poster-r1`

## What is fixed

### 1. VK gallery posters are resolved by `photo<owner>_<id>`, not recycled `currentSrc`

VK virtualizes multi-photo grids. In a real `rb_diesel / wall-117292629_13738` capture, two different photo cells could serialize the same CWT thumbnail and the STONEHAND poster disappeared before vision/poster matching.

V188.72 keeps each exact photo anchor identity and resolves it through `photos.getById`. The resolved URL replaces the potentially stale DOM URL for that exact attachment before image fingerprinting, vision and child-event poster matching. A complete photo-id resolution does not append duplicate size variants from `wall.getById`, so `[IMAGE N]` numbering stays stable.

### 2. Broken / empty VK source pages are reloaded automatically

If a configured VK source shows a transient load error (`Ошибка загрузки`, `Не удалось загрузить`, `Something went wrong`, etc.) or the document is already loaded but contains no wall/post DOM, the parser performs a bounded `page.reload()` in the same source tab and retries capture.

- maximum automatic reloads per source capture: 2;
- login/CAPTCHA pages are NOT reload-looped; existing manual-access handling owns them;
- a user-closed browser/page is still treated as an intentional stop.

### 3. Existing V188.71 event-media/dedupe behavior is retained

- generic venue type words (`бар`, `паб`, `клуб`, `hall`, etc.) do not split an otherwise identical venue core;
- merged duplicate events may keep several independently verified posters;
- single-event sources can retain several strong source images;
- multi-event schedule posters stay per-child verified and are not blindly copied to every child.

## Operator action

After installing V188.72, run `Гигорейв парсер все` once. This recaptures the configured VK sources with photo-id hydration and repairs stored poster bindings. Existing text-only cards whose old source cache contained only a stale/recycled thumbnail cannot obtain the missing bytes until that source is recaptured or API-hydrated.
