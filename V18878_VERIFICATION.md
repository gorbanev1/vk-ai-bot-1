# V188.78 verification

Проверка выполнена перед упаковкой финального ZIP.

- `npm run check:syntax` — OK
- `npm run check:imports` — OK
- `npm run check:named-imports` — OK
- `npm test` — 139/139 pass
- `npm run verify` — OK, включая release runtime-data guard

В активный regression run добавлены/сохранены проверки для:

- STONEHAND / multi-event Diesel schedule/gallery binding;
- chat message `#4928` clean-media/poster safety;
- `wall-240444315_7` provenance/media;
- Вадим Курылёв final dedupe;
- `Крыльевые романы` venue normalization;
- `Diesel Bar != Diesel Hall`;
- обычный `Бар X == Клуб X` venue-core behavior;
- `1/10` carousel UI sanitation и retrospective rejection;
- nested repost media;
- multiple verified posters on merged event;
- bounded VK reload after >=10 seconds;
- secondary stagger 10–20 seconds and minimum tab lifetime 180 seconds;
- immutable snapshot reused by all three contours;
- one-time startup poster repair marker semantics.
