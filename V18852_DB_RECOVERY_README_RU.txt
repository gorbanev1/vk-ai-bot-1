Gigorave V188.52 — DB lineage guard / безопасная сверка после случайной перезаписи bot.sqlite

ВАЖНО
- Текущий data/bot.sqlite НЕ заменяется автоматически.
- Новые сообщения, уже записанные после случайной перезаписи, считаются отдельным active-only tail.
- Они НЕ делают старую базу «актуальной», если из неё исчезли строки, присутствующие в healthy backup.
- Новый healthy backup из такой подозрительно откатившейся БД не создаётся.

1. СВЕРКА ЖИВОЙ БД С ПОСЛЕДНИМ HEALTHY BACKUP

  npm run db:compare-backup

Команда делает консистентный VACUUM INTO snapshot живой БД и сравнивает его с последним
healthy backup. Живой bot.sqlite не изменяется.

Ключевые поля вывода:
- backupOnly — исторические строки, которые есть в backup, но отсутствуют в active;
- activeOnly — строки, которые есть только в active;
- activeOnlyTail — новые строки после frontier backup; это нормальный новый хвост и он сохраняется;
- activeOnlyHistorical — расхождение внутри старого диапазона.

Если backupOnly > 0, это сильный признак, что активная БД откатилась/была перезаписана.
Отчёт сохраняется в data/recovery-audit/.

2. СОБРАТЬ КАНДИДАТ НА ВОССТАНОВЛЕНИЕ БЕЗ ЗАМЕНЫ ЖИВОЙ БД

  npm run db:build-recovery-candidate

Алгоритм намеренно идёт от ТЕКУЩЕЙ БД:
- делается snapshot текущего bot.sqlite вместе с committed WAL;
- этот snapshot становится основой кандидата;
- из healthy backup дозаливаются отсутствующие append-only исторические строки;
- surrogate AUTOINCREMENT id не переносятся для messages/bot_request_events, чтобы новые строки,
  уже получившие переиспользованные id после отката, не блокировали восстановление старой истории;
- natural keys (например peer_id + conversation_message_id) сохраняют дедупликацию;
- исходный data/bot.sqlite не изменяется.

Результат:
  data/recovery-candidates/bot-reconciled-<timestamp>.sqlite
  data/recovery-candidates/bot-reconciled-<timestamp>.json

Кандидат проходит PRAGMA quick_check и повторную lineage-сверку.

3. ЧТО STARTUP GUARD ДЕЛАЕТ САМ

При запуске active DB сравнивается с последним healthy backup ДО создания нового backup.
Если active SQLite формально исправна, но потеряла append-only историю:

  [DB LINEAGE GUARD] ACTIVE_DB_OLDER_THAN_BACKUP ...

Новый healthy backup из этой БД блокируется. Бот не перезаписывает active DB автоматически.
Это специально: после аварии в active уже могут быть новые сообщения, которые нельзя потерять.

Контролируемые append-only источники V188.52:
- messages
- vk_message_archive
- bot_request_events
- chat_membership_events

Для них отсутствие backup-key в active является нарушением lineage независимо от того,
сколько новых сообщений успело прийти после перезаписи.
