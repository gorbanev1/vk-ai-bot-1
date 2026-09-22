# Gigorave V188.101 — GPT-6 Astra + reasoning=max

Максимальная команда: `Гигорейв astra max <запрос>` или `Гигорейв астра max <запрос>`.

- Новый mode `astra` → `gpt-6-astra`.
- У Astra reasoning по умолчанию `max`.
- `max/latest/самая продвинутая модель` теперь выбирают Astra; `pro3/sol/сол` остаются GPT-5.6 Sol.
- Astra идёт через Responses API даже без файлов; `temperature` не отправляется.
- Если `reasoning=max` не поддержан конкретным endpoint, он не удаляется тихим compatibility retry.
- Явный Astra route не подменяется Grok/xAI.
- Добавлены `GPT_MODEL_ASTRA` и `GPT_ASTRA_DAILY_LIMIT`; Astra добавлена в vision/astrology ladder и Telegram menu.
