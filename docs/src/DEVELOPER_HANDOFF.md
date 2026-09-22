# V129 — Pop bumper power

V129 keeps the spacious V128 table but makes all three pop bumpers behave like active solenoid mechanisms: every valid contact gets a strong outward impulse, a guaranteed minimum exit speed, stronger particles/flash/screen shake, and a heavier strike sound. The layout, V126 shooter rollback, and V127 anti-loop ramp behavior are unchanged.

Current build: `events-v129-pinball-pop-bumper-power` (`0.129.0`).

# V127 — One-way ramps + tangent exits

V127 fixes the infinite ping-pong at the ends of the two dashed ramp arcs. Ramp mouths now behave as one-way pinball shots: only an up-table ball with sufficient velocity can enter. A descending ball crossing the artwork cannot be re-captured. Ramp exits preserve the cubic Bézier end tangent instead of reversing the horizontal velocity, and every exit gets a short lockout plus a small tangent clearance before normal playfield collision resumes.

Current build: `events-v127-pinball-one-way-ramp-exits` (`0.127.0`).

# V126 — Rounded shooter lane + re-plunge

V126 rebuilds the plunger/shooter geometry around a full-length right-side lane with a smooth crest. Weak plunges can roll back naturally and settle on the plunger for another launch without consuming a ball; successful plunges exit into a collision-clear patch of the playfield. Static cabinet and guide geometry is now built from tangent Bézier rails instead of sharp polygon corners.


Current build: `events-v126-rounded-pinball-shooter-return` (`0.126.0`).

# Gigorave Bot — Events V123

## V123: targeted AI audit cleanup + Telegram Mini App Pinball Psychosis

Текущая сборка: `events-v123-targeted-ai-cleanup-telegram-pinball-psychosis` (`0.123.0`). V123 включает невыпущенные отдельно изменения V122 и накладывается напрямую на V121.

### AI-аудит

Owner-команда `Гигорейв тест всех моделей` по-прежнему не трогает основной `OPENAI_COMPAT_API_KEY` владельца и GigaChat. Транспорт считается рабочим при содержательном ответе API; точное повторение `GIGORAVE_AUDIT_OK` хранится как отдельный флаг instruction compliance и больше не убивает модель. После двух основных проходов выполняется точечный третий круг только для реально неоднозначных text-результатов (timeout/network/5xx и HTTP 200 с нестандартным body). Raw/provider-specific поля ответа разбираются шире: `content`, `output_text`, `reasoning_content`, `reasoning`, `analysis` и вложенные content blocks.

После завершённого аудита V123 может удалить из рабочего `.env` только доказанно невалидные **чужие** ключи (`401`/provider-specific invalid-secret). Перед записью создаётся `.env.before-ai-key-cleanup-<timestamp>.bak`. Quota/429, credits, timeout, 5xx и provider restrictions не удаляются. Защищённые owner-контуры `OPENAI_COMPAT_API_KEY` и GigaChat не чистятся.

### Telegram Mini App: GIGORAVE // PINBALL PSYCHOSIS

В основное Telegram-меню добавлена `🎮 Пинбол`. При наличии `TELEGRAM_PINBALL_WEBAPP_URL=https://.../pinball/` кнопка открывает Mini App. Встроенный HTTP-сервер слушает `PINBALL_HTTP_HOST`/`PINBALL_HTTP_PORT` (по умолчанию `127.0.0.1:8787`) и отдаёт игру/API. Для Telegram нужен внешний HTTPS reverse proxy.

Пинбол использует фиксированный physics timestep, 2 нижних флиппера, плунжер, нудж/tilt, бамперы, slingshots, targets/rollovers, две рампы, scoop, skill-shot, ball-save, combo/multiplier, overdrive, multiball, jackpots, WebAudio, частицы, keyboard + touch controls. Управление на ПК: `A/←`, `D/→`, `Space`, `Q/W/E`, `P/Esc`, `R`.

Онлайн-рекорды сохраняются в SQLite `pinball_scores`. Клиент открывает score-session только после серверной HMAC-проверки Telegram `initData`; leaderboard отдаёт публичные display-name/score без секретов.

---

# Gigorave Bot — Events V121

## V121: two-pass provider-aware AI audit

Owner-команда `Гигорейв тест всех моделей` теперь тестирует только чужие/непроверенные AI-ключи: `OPENAI_COMPAT_API_KEY` (основной GPT endpoint владельца) исключён из аудита, GigaChat этой командой не тестируется. После первого параллельного прохода V121 автоматически запускает второй круг для всех неоднозначных ошибок: timeout/network, 429, 5xx, endpoint/model 404, payload 400/405/415/422 и ограничений доступа, которые не доказывают смерть секрета. Явный invalid-key (`401`, `API key not valid`) считается окончательным и повторно не долбится.

Reasoning/intelligence больше не проверяется одинаковым списком на всех моделях: набор уровней выбирается по provider/model. Baseline называется `default`; explicit `none` тестируется отдельно только там, где он имеет смысл. Текст считается успешным только при фактическом возврате контрольного `GIGORAVE_AUDIT_OK`. Для OpenAI-style второго круга используются альтернативные официальные endpoint-семейства; NVIDIA также больше не получает несовместимый `max_completion_tokens` там, где требуется `max_tokens`.

После завершения `ai_runtime_modes` пересобирается только из подтверждённых рабочих комбинаций. `retry_candidates.json` содержит остаточные FAIL уже **после** автоматического второго круга. Подробности: `PATCH_NOTES_EVENTS_V121_TWO_PASS_AI_AUDIT.txt` и `V120_LAST_AUDIT_ANALYSIS_FOR_V121.txt`.

Текущая сборка: `events-v121-two-pass-provider-aware-ai-audit` (`0.121.0`).

---

# Gigorave Bot — Events V120

## V120: bounded-concurrent AI audit

Owner-команда `Гигорейв тест всех моделей` больше не гоняет модели последовательно. По умолчанию одновременно тестируются до 6 text-моделей глобально, но не более 1 активной модели на один exact key. Внутри каждой модели baseline `non-stream` и `stream/SSE` уходят одновременно. Reasoning/intelligence уровни `minimal`, `low`, `medium`, `high`, `xhigh`, `max` идут параллельными батчами по 2 уровня, и для каждого уровня оба транспорта снова запускаются одновременно.

Каталоги ключей проверяются до 8 одновременно. Native image-generation идёт до 4 моделей одновременно с лимитом 1 на ключ; stream/SSE image probes также выполняются параллельно. Лимиты настраиваются через `AI_AUDIT_KEY_CONCURRENCY`, `AI_AUDIT_MODEL_CONCURRENCY`, `AI_AUDIT_PER_KEY_MODEL_CONCURRENCY`, `AI_AUDIT_REASONING_CONCURRENCY`, `AI_AUDIT_IMAGE_CONCURRENCY`, `AI_AUDIT_PER_KEY_IMAGE_CONCURRENCY`. Высокие значения могут искусственно вызвать 429, поэтому per-key лимиты по умолчанию консервативные.

`AUDIT_STATUS.json` во время длинных стадий содержит `completed/total`, лимиты параллелизма и ETA. Telegram также показывает прогресс и ETA. Transport-selection policy V119 не менялась.

Текущая сборка: `events-v120-concurrent-ai-audit-transport-matrix` (`0.120.0`). Подробности: `PATCH_NOTES_EVENTS_V120_CONCURRENT_AI_AUDIT.txt`.

---

# Gigorave Bot — Events V119

## V119: stream/non-stream + reasoning/intelligence transport matrix

Owner-команда `Гигорейв тест всех моделей` запускает новый первый проход с нуля: каталог `AI_FULL_AUDIT_RESULTS` очищается, затем для каждой обнаруженной text/chat комбинации key+model один и тот же baseline-запрос тестируется в реальном `non-stream` и реальном `stream/SSE`. Для каждой text-модели дополнительно проверяются reasoning/intelligence уровни `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; уровни кроме `none` проверяются отдельно в обоих транспортных режимах.

Политика runtime после успешного аудита: оба транспорта работают → `non_stream` основной, `stream` fallback; работает только stream → `stream` основной и один аварийный `non_stream` retry; работает только non-stream → используется только `non_stream`; оба провалились → key+model не попадает в `ai_runtime_modes`. Для каждого reasoning-уровня хранится своя transport policy, и основной OpenAI-compatible runtime учитывает её при выборе транспорта. Guard/safeguard/moderation модели не считаются обычными chat-моделями.

Image-generation также получает normal provider test + отдельный stream/SSE probe, где для провайдера есть соответствующий endpoint. `AUDIT_STATUS.json` показывает ход проверки, `AUDIT_DONE.json` создаётся после полного model/transport прохода, а Telegram присылает периодический прогресс и финальное сообщение `✅ Полный V119 AI transport-аудит завершён.`.

Текущая сборка: `events-v119-ai-transport-reasoning-matrix-runtime-routing` (`0.119.0`). Подробности: `PATCH_NOTES_EVENTS_V119_AI_TRANSPORT_REASONING_MATRIX.txt`.

---

# Gigorave Bot — Events V118

## V118: полный аудит всех AI-ключей/моделей + жёсткий Telegram home fast-path

Owner-команда `Гигорейв тест всех моделей` (после удаления обращения достаточно `тест всех моделей`) запускает фоновый live-аудит. Бот использует только ключи из текущего `.env`, получает каталог для каждого ключа, проверяет все распознанные text/chat-модели реальным коротким запросом и отдельно прогоняет все найденные image-generation модели. Полные ключи не пишутся в логи — только env-slot и маска.

Результаты сохраняются в `AI_FULL_AUDIT_RESULTS/<timestamp>/`: `report.txt`, `report.json`, `results.jsonl`, `retry_candidates.json`, `sol_summary.txt`, а графические результаты — во вложенной `GRAPHICS_MATRIX_RESULTS/`. После успешного полного прохода SQLite-таблица `ai_runtime_modes` атомарно пересобирается только из успешно проверенных `key + model + capability`; не прошедшие комбинации исчезают из рабочего реестра. Ошибки 401/403, 429, 5xx/network и endpoint/payload ошибки классифицируются отдельно, а `retry_candidates.json` содержит стратегию второго круга.

После аудита бот делает короткое техническое резюме через `gpt-5.6-sol` по `OPENAI_COMPAT_API_KEY`, если Sol доступна. `parsed_secrets.txt` больше никогда не читается runtime: при старте устаревшие `parsed_secrets.txt`, `parsed_secrets.jsonl` и `parsed-secrets.txt` удаляются без разбора содержимого.

Telegram: `/start`, `/menu`, `/home`, `главная`, `главное меню`, `домой` и `🏠 На главную` теперь обрабатываются внутри Telegram-адаптера до общего router и всегда возвращают основную owner/public клавиатуру. После `Вернуть тусу ...` owner-клавиатура также возвращается.

Текущая сборка: `events-v118-full-ai-audit-telegram-home-fastpath` (`0.118.0`).

---

# V108 QR code message/assets

Current build: `events-v108-qr-code-message-assets` (`0.108.0`). Keeps V107 industrial event dedupe and all earlier functionality. Adds public `куаркод` / `qr`, global SQLite `qr_code_settings`, default caption `89968257889 Сбер Игорь Анатольевич.`, and owner command `заменить сообщение куаркод`. Text-only update preserves the current QR image; text+image replaces both; image-only replaces only the image. The QR asset is stored locally under `data/qr-code/` and is sent with its caption in one VK/Telegram media message. No new env keys.

# Полная передача проекта разработчику

Основная документация находится в `docs/`. Этот файл содержит готовый handoff; для деталей см. `README.md` и `docs/00_START_HERE.md`.

# Передача проекта в новый чат

Этот файл можно приложить вместе с source archive. Ниже есть готовый текст, который следует вставить первым сообщением в новый чат.

## Готовый handoff prompt

```text
Продолжай разработку проекта Gigorave Bot из приложенного архива.

Текущая сборка: events-v108-qr-code-message-assets.
Основной entrypoint: src/index.js.
Главный orchestrator: src/app/botApplication.js.
Полная документация находится в docs/, начать с docs/00_START_HERE.md.

Обязательные правила работы:
1. Не переписывай проект с нуля и не теряй накопленные функции.
2. Перед изменениями прочитай docs/ARCHITECTURE.md, docs/BEHAVIOR_AND_COMMANDS.md и docs/DATABASE.md.
3. Новый код импортируй из структурированных папок; корневые src/*.js — совместимые re-export файлы.
4. Каждый новый релиз получает следующий номер V42, V43 и т. д. и новый BOT_PATCH_VERSION.
5. Сначала сделай рабочую копию полного проекта, затем patch только с изменёнными файлами.
6. Никогда не включай .env, токены, data/bot.sqlite, браузерный профиль и пользовательские данные в patch.
7. После изменений запусти npm/pnpm verify, node --check, проверку импортов, тест архива и поиск секретов.
8. Реальные VK/Telegram/GPT API без моих токенов не считаются проверенными — указывай это честно.
9. Не используй Kubernetes: проект рассчитан на один процесс и SQLite.
10. Не возвращай предметную логику в src/index.js. Чистые правила выноси в features/shared и покрывай тестами.

Критическая текущая логика:
- GPT по умолчанию gpt-5.4-mini.
- pro=Luna, pro2=Terra, pro3=Sol.
- Для mini/gpt54/gpt55 натал и прашна локально используют packet=maximum.
- pro/pro2/pro3 по умолчанию model-only, но `локалэфемериды`/`локал`/`расчёт локально` принудительно включает maximum-пакет.
- Пакет и аудит передаются модели без публикации технического JSON в чат; критическая неполнота прекращает запрос.
- Натал всегда развёрнутый. Прашна без уточнения остаётся краткой, но слова «подробно», «глубокий разбор», «максимальный техрасчёт» и любой режим pro/pro2/pro3 включают развёрнутый технический профиль без лимита 2–3 абзаца.
- GigaChat только по явному слову «гигачат».
- Явная память изолирована по peer_id; забывание ставит active=0.
- Скрейперы запускаются только вручную.
- Событие сохраняется только при наличии сути, даты и конкретного места.
- Владелец может вручную добавлять события; при ссылке браузер открывает страницу и оставляет вкладку.
- Роль и теплоту может менять любой участник текущего диалога.
- Фоновые реплики только в ролях быдло/дурачила, через 1–60 минут; сценарии: беседа 40%, в воздух 40%, участник 20%; генерация всегда Luna/Terra 50/50, шаблон только fallback.
- Активное общение отвечает примерно на каждое десятое содержательное сообщение холодно, цинично и грубо; модель случайно Luna/Terra 50/50.
- Telegram owner видит кнопку добавления события; обычные пользователи её не видят.
- В справке ЛС нет команд групповых чатов и упоминаний групповой беседы.

Перед ответом сначала изучи файлы и покажи, какие конкретно модули будут изменены. После этого реально измени архив, а не только опиши решение.
```

## Что приложить к новому чату

Минимум:

1. полный source archive V46 без секретов и рабочей базы;
2. этот `CHAT_HANDOFF.md`;
3. при проблеме — точный console log и скриншот;
4. при проблеме данных — обезличенный пример строки, не всю базу.

Для продолжения существующих данных новая версия должна накладываться на локальный проект пользователя, где уже лежат `.env` и `data/bot.sqlite`.

## Нерешённые технические долги

- `src/app/botApplication.js` всё ещё около 10 тысяч строк.
- `src/infrastructure/database/index.js` около 4 тысяч строк.
- Нет live integration test environment.
- Точность model-only астрологии зависит от выбранной модели. Локальный maximum зависит от файлов Swiss; аудит явно показывает Moshier fallback и optional-пробелы.
- Длинные Sol-streams иногда падают по capacity/terminated; retry не гарантирует успех.

## Последняя проверенная функциональность

V101 по прямому owner-запросу одноразово обновляет сохранённый ответ `корды`: координаты + добровольный донат + правила + старт 17:00 + ссылка на группу. После миграции owner может снова заменить текст через `корды сообщение`, и рестарт его не откатит.

V100 фиксирует ближайшую организаторскую тусу одним fast-path ответом без DM-notice дубля, разделяет `ближайшая туса` и `ближайшие тусы`, отключает повторный случайный DM AI notice и локально обрабатывает координаты до/после публичного окна.

## V104 complete event-quality workflow

V104 Complete includes V97–V102 coords/nearest-party behavior, V103 non-destructive whole-DB dedupe registry, and V104 event-quality workflows: public proposals with owner moderation + 24h auto-approve, repeat-source update confirmation, VK wall post-photo priority, mass source-link reparse, Telegram single media-card delivery, fuzzy event removal/restore, and the public Telegram party-menu warning.