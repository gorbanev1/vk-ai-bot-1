# Конфигурация

Полный безопасный шаблон находится в `.env.example`. Рабочий `.env` не входит в патчи/full-архивы.

## Пути runtime-данных и owner VK

По умолчанию основная SQLite находится в `data/bot.sqlite`. Для стендов, тестов и безопасной диагностики путь можно переопределить:

```dotenv
GIGORAVE_DATA_DIR=
GIGORAVE_DB_PATH=
BOT_DB_PATH=
GIGORAVE_STATE_DIR=
VK_OWNER_USER_ID=
BOT_OWNER_VK_ID=
```

`GIGORAVE_DB_PATH` имеет приоритет для основной SQLite; `BOT_DB_PATH` — совместимый alias. `GIGORAVE_DATA_DIR` задаёт каталог runtime-data и используется также для журналов рядом с БД. `GIGORAVE_STATE_DIR` остаётся отдельным постоянным каталогом user-level state. `VK_OWNER_USER_ID` (или совместимый `BOT_OWNER_VK_ID`) задаёт VK owner без правки исходников; если переменная не указана, сохраняется legacy ID для совместимости.

Тестовые runner'ы V188.66 автоматически создают временные `GIGORAVE_DATA_DIR`/`GIGORAVE_DB_PATH`. Если тестовый процесс пытается открыть production `data/bot.sqlite` без явной изоляции, запуск останавливается до открытия файла. На обычном production-экземпляре переопределять путь к БД не требуется.

## Основные группы

- VK: токен сообщества, group/owner ID и параметры Long Poll.
- Telegram: bot token, owner ID и polling.
- GPT: OpenAI-compatible base URL, API key, модели, streaming и дневные лимиты.
- GigaChat: необязательная интеграция для отдельных классификаторов.
- Google Maps: geocoding и timezone для мест натала/прашны.
- Playwright: профиль браузера и переключатели источников.


## Два VK-сообщества одновременно

Основное сообщество продолжает использовать старые переменные:

```dotenv
VK_TOKEN=
VK_GROUP_ID=
```

Для второй VK-встречи/сообщества добавлены отдельные необязательные переменные:

```dotenv
VK_EVENT_TOKEN=
VK_EVENT_GROUP_ID=
```

Если заполнены `VK_EVENT_TOKEN` и `VK_EVENT_GROUP_ID`, приложение запускает второй Long Poll и обрабатывает сообщения обоих сообществ одной логикой. Заполнять нужно обе переменные одновременно. Старый `VK_TOKEN` заменять токеном встречи не нужно. Для встречи `https://vk.ru/wall-240709021_13` значение `VK_EVENT_GROUP_ID` равно `240709021`.

## GPT image-2: платформенные лимиты

```dotenv
GPT_IMAGE_DAILY_LIMIT=5
TELEGRAM_GPT_IMAGE_DAILY_LIMIT=2
```

`GPT_IMAGE_DAILY_LIMIT` остаётся лимитом обычного пользователя VK. `TELEGRAM_GPT_IMAGE_DAILY_LIMIT` применяется только к Telegram и считается на пользователя суммарно между Telegram ЛС и группами. Владелец использует общий unlimited-механизм. Генерация и редактирование, которые реально вызывают `gpt-image-2`, списываются из одной image-квоты.

В Telegram кнопка `🖼 Изображение` включает постоянный режим: последующие обычные сообщения считаются промптами изображения до выбора другого пункта меню или явной не-image команды. Явные `рисуй`/`нарисуй` работают как image-команды независимо от текущего меню.

## Локальная астрология

```dotenv
EPHEMERIS_PATH=
ASTROLOGY_REQUIRE_SWISS_FILES=0
PRASHNA_KEEP_FULL_JSON=0
```

`EPHEMERIS_PATH` должен указывать на папку с файлами `*.se1`. При пустом пути используется явно отмеченный Moshier fallback. `ASTROLOGY_REQUIRE_SWISS_FILES=1` запрещает fallback и останавливает расчёт, если Swiss-файлы не найдены.

## Отдельные диагностические API-провайдеры

Эти переменные не заменяют основной `OPENAI_COMPAT_API_KEY` и не участвуют в обычных ответах бота. Они используются только owner-командами `api openai ...` и `api nvidia ...`.

```dotenv
OPENAI_DIRECT_API_KEY=
OPENAI_DIRECT_BASE_URL=https://api.openai.com/v1
OPENAI_DIRECT_MODEL=

NVIDIA_API_KEY=
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_MODEL_DEFAULT=
NVIDIA_IMAGE_BASE_URL=https://ai.api.nvidia.com/v1/genai
NVIDIA_IMAGE_MODEL=auto
NVIDIA_IMAGE_ATTEMPT_TIMEOUT_MS=360000
NVIDIA_IMAGE_TOTAL_TIMEOUT_MS=1200000
```

Ключи хранятся только в `.env`. Команды диагностики показывают провайдера, endpoint, модель, HTTP-статус и время запроса, но никогда не печатают секрет.

Для NVIDIA используйте:

```text
Гигорейв nvidia
Гигорейв нвидиа
Гигорейв nvidia проверить
Гигорейв nvidia модели [фильтр]
Гигорейв nvidia доступные по этому апи ключу модели с описанием возможностей каждой
Гигорейв nvidia рабочая модель
Гигорейв nvidia тест [точный-id|#N|авто]
Гигорейв nvidia полный тест
Гигорейв nvidia запрос <точный-id|#N|авто> <текст>
Гигорейв nvidia примеры

Старый префикс `Гигорейв api nvidia ...` сохранён для совместимости.
```

`NVIDIA_MODEL_DEFAULT` необязателен: при пустом значении команда `тест` может выбрать вероятную chat/instruct-модель автоматически. Для воспроизводимой проверки лучше указать точный model id или номер `#N` из текущего каталога.

### NVIDIA Visual — генерация изображений

Тот же `NVIDIA_API_KEY` используется для облачных Visual endpoints на `https://ai.api.nvidia.com/v1/genai`. Текстовый каталог `GET https://integrate.api.nvidia.com/v1/models` не является каталогом image endpoints, поэтому графические модели проверяются отдельным реальным POST.

```text
Гигорейв nvidia нарисуй ночной Воронеж в стиле киберпанка
Гигорейв nvidia графика проверить
Гигорейв nvidia графика модели
Гигорейв nvidia нарисуй через flux.1-schnell рыжего кота-космонавта
```

В режиме `auto` бот последовательно пробует официальные hosted endpoints FLUX/Stable Diffusion и отправляет во VK или Telegram первое успешно созданное изображение. `NVIDIA_IMAGE_MODEL` можно оставить `auto` либо указать точный id из команды `nvidia графика модели`.


## V118: полный AI-аудит

Команда владельца:

```text
Гигорейв тест всех моделей
```

Источник ключей — только `.env`. Runtime не импортирует `parsed_secrets.txt`; устаревшие parsed-secrets файлы удаляются при старте. Поддерживаются номерные `OPENAI_API_KEY[_N]`, `ANTHROPIC_API_KEY[_N]`, `GEMINI_API_KEY[_N]`, `GROQ_API_KEY[_N]`, `HUGGINGFACE_API_KEY[_N]`, `NVIDIA_API_KEY[_N]`, а также `OPENAI_DIRECT_API_KEY` и `OPENAI_COMPAT_API_KEY`.

Полный лог: `AI_FULL_AUDIT_RESULTS/<timestamp>/report.txt`. Для следующего диагностического круга используйте `retry_candidates.json`. Рабочий реестр успешных режимов хранится в SQLite `ai_runtime_modes`; секретов в таблице нет.


## V139: Pinball disabled

Pinball больше не является runtime-функцией. Переменные `TELEGRAM_PINBALL_WEBAPP_URL`, `PINBALL_HTTP_ENABLED`, `PINBALL_HTTP_HOST`, `PINBALL_HTTP_PORT`, `PINBALL_INITDATA_MAX_AGE_SEC` оставлены только как legacy-конфигурация и V139 их не использует при запуске бота. Старый раздел ниже сохранён как историческая справка.

## V123: Telegram Mini App Pinball

```dotenv
TELEGRAM_PINBALL_WEBAPP_URL=https://example.com/pinball/
PINBALL_HTTP_ENABLED=1
PINBALL_HTTP_HOST=127.0.0.1
PINBALL_HTTP_PORT=8787
PINBALL_INITDATA_MAX_AGE_SEC=86400
```

`TELEGRAM_PINBALL_WEBAPP_URL` обязан быть публичным HTTPS URL, доступным Telegram-клиенту. Сам Node-процесс может слушать только localhost; Caddy/nginx/Cloudflare Tunnel/другой reverse proxy должен проксировать `/pinball/` и `/pinball/api/*` на `http://127.0.0.1:8787`. Если URL не настроен или не HTTPS, `🎮 Пинбол` остаётся обычной кнопкой и owner получает инструкцию настройки вместо Web App.

## V123: AI audit cleanup

```dotenv
AI_AUDIT_KEY_CONCURRENCY=8
AI_AUDIT_MODEL_CONCURRENCY=6
AI_AUDIT_PER_KEY_MODEL_CONCURRENCY=1
AI_AUDIT_REASONING_CONCURRENCY=2
AI_AUDIT_IMAGE_CONCURRENCY=4
AI_AUDIT_PER_KEY_IMAGE_CONCURRENCY=1
```

Массовый аудит исключает `OPENAI_COMPAT_API_KEY` и GigaChat. После полного завершения только явно невалидные чужие секреты могут быть удалены из `.env`; quota/429, timeout, credits, 5xx и ограничения проекта сохраняются. Перед изменением `.env` V123 делает timestamped backup.

## V140: таймауты обновления источника/предложки

- `EVENT_SOURCE_REFRESH_TIMEOUT_SECONDS` — budget быстрого `wall.getById` при обновлении уже сохранённого exact VK source. По умолчанию 15 секунд, допустимый диапазон 5–60.
- `EVENT_PROPOSAL_AI_TIMEOUT_SECONDS` — budget одного vision/text AI-запроса в контуре «Предложить тусу». По умолчанию 45 секунд, допустимый диапазон 10–120.

Оба параметра необязательны; безопасные defaults уже встроены.
