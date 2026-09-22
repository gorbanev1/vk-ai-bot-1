# Gigorave V188.88 — CODE ONLY

Чистый архив исходного кода V188.88.

В архив входят:
- `src/` — приложение и runtime-код;
- `tests/` — активные и исторические regression-тесты;
- `scripts/` — проверки и maintenance;
- `miniapps/`, `assets/`, `docs/`;
- `package.json`, `pnpm-lock.yaml` и необходимые корневые файлы;
- `V18887_CHANGES_RU.md` — изменения текущего релиза;
- `V18886_CHANGES_RU.md` — предыдущий пакет исправлений афиш/дедупа.

Намеренно НЕ включены runtime/user data:
- `data/`;
- SQLite/DB, `-wal`, `-shm`;
- runtime logs/trace/jsonl;
- DOM snapshots/screenshots/cache;
- пользовательские media/uploads;
- `.env`, секреты и `node_modules`.

Версия package: `0.188.88`.
Build marker: `events-v18888-all-parties-compact-r1`.
