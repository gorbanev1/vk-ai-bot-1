# GIGORAVE V188.119 — текстовый Astra-аудит по умолчанию

**Применение:** это PATCH поверх существующей рабочей папки GIGORAVE, а не полный автономный бот. Не удаляйте файлы, которых нет в ZIP, `.env`, SQLite, `data/audit-jobs`, outbox и старые задания. Сначала остановите процесс и сделайте резервную копию рабочей папки. Затем скопируйте содержимое ZIP поверх неё и запустите из обычного окна или WebStorm.

По умолчанию `PROJECT_ARCHIVE_INPUT_MODE=text`, `PROJECT_ARCHIVE_MULTIPASS_TRANSPORT=stream`, `PROJECT_ARCHIVE_AUDIT_CONCURRENCY=1`. Пропущенные, `auto`, пустые и неизвестные значения input mode приводят к текстовому MULTIPASS. Старая переменная `PROJECT_ARCHIVE_AUDIT_MULTIPASS=0` не выключает text mode. В text mode даже старое `PROJECT_ARCHIVE_MULTIPASS_TRANSPORT=background` приводится к stream. Экспериментальный `/files` SINGLE-SHOT доступен **только при явном** `PROJECT_ARCHIVE_INPUT_MODE=file`; его не включайте для текущего роутера.

Для проверки без env ожидается:

```text
[BOT BUILD] V188.119
[PROJECT AUDIT CONFIG] mode=multipass inputMode=text transport=stream concurrency=1
```

После отправки **одного малого тестового ZIP**: `document-received`, `source-persisted`, `archive-validated`, `source-files-filtered`, `text-multipass-start` с числом batches, `ai-batch-start` и `[AI RUNTIME TRANSPORT] preferred=stream`. В text mode не должны появляться `input-bundle-built`, `single-shot-start`, `[ASTRA INPUT FILE UPLOAD]` и `PROJECT_ARCHIVE_FILES_VARIANT_UNCONFIRMED`.

Если по-прежнему видите `[BOT BUILD] V188.117` или `inputMode=auto`, запущен старый процесс/старые исходники или используется другая рабочая папка. Остановите именно тот экземпляр и проверьте, куда указывают конфигурация запуска и `src/shared/buildVersion.js`.

Тесты: `npm run test:v188119`. Node.js 22 использовался для локальных тестов; `package.json` проекта декларирует Node.js >=24, поэтому для живого запуска соблюдайте требование проекта. **Реальные запросы к стороннему роутеру и Telegram в локальных тестах не выполнялись.** Из V188.118 сохраняется ограничение: автоматическое продолжение всего прерванного MULTIPASS-задания после рестарта не гарантировано; отдельные платные стадии не должны переотправляться без безопасного recovery. Не присылайте тот же большой ZIP как новое сообщение, рассчитывая продолжить старый `jobId`.
