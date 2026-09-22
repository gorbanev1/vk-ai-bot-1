# V188.59 — multi-announcement / multi-poster parser hardening

- Removed hidden 8-image pre-AI fingerprint cap; public posts can carry all 12 admitted source images through poster vision.
- Preserves explicit AI `image_indexes` instead of letting fuzzy fallback overwrite the selected poster.
- Adds Russian month-name date matching for poster-to-event fallback binding.
- Filters VK logged-in profile avatars (`ava=1`) from post poster candidates in both exact DOM and legacy extraction.
- Adds `poster-vision.batch_start` / `poster-vision.batch_complete` trace coverage with discovered/completed/failed image numbers.
- Raises public multi-event extraction output budget to 6000 tokens and reinforces one-event-per-announcement instructions.
- Retains V188.58 parser timeout and VK legacy owner-isolation fixes.
