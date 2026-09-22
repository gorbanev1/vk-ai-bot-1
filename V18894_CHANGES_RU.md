# Gigorave V188.94 — два режима удаления событий

## Что изменено

### 1. Обычное удаление
Команды `тусы удалить <название>` / `удалить тусу <название>` теперь делают **мягкое удаление**:
- совпадающие текущие карточки получают `status=ignored`;
- permanent fingerprint не создаётся;
- после нового парсинга/перепарсинга событие может появиться снова как заново собранная карточка.

Это режим для плохой/неудачно собранной карточки, которую лучше получить заново при следующем парсинге.

### 2. Удаление насовсем
Команды `тусы удалить насовсем <название>` / `удалить тусу навсегда <название>`:
- создают persisted запись в SQLite `event_permanent_blocks`;
- сохраняют точную дату события как обязательный hard-key;
- сохраняют название, участников, площадку/venue key, описание/evidence, source lineage, source item id, canonical/source URL, исходный текст источника, Vision metadata афиши и event tags;
- сразу скрывают совпадающие текущие карточки;
- на всех последующих путях записи/перепарсинга проверяют новый event против permanent fingerprint **до сохранения**.

Дата одна недостаточна: требуется event-specific identity (название/участники/содержательный overlap/Vision identity), чтобы permanent delete одной карточки multi-announcement поста не убивал соседнее событие той же даты.

### 3. Где permanent delete проверяется
Защита стоит на persistence-слое для:
- Telegram source events;
- VK wall events;
- VK chat events;
- QTickets events;
- manual events, включая `owner_manual`;
- `updateStoredEventRecordFromReparse`.

Таким образом проверка не зависит от одного UI handler и не обходится другим reparse/repair путём.

### 4. Старый blacklist
Старый title-only JSON blacklist больше не участвует в обычной выдаче и удалении:
- production-код больше не вызывает `addEventBlockRule()`;
- production-код больше не вызывает `filterBlockedEvents()`;
- старый файл доступен только для просмотра/снятия старых правил при миграции.

### 5. Восстановление
`вернуть тусу <название или #id>` деактивирует permanent fingerprint. После этого событие снова может быть добавлено новым парсингом.

## Регрессии
Добавлен `tests/events/v18894PermanentEventDeletion.test.mjs`:
- permanent delete переживает reparse;
- соседняя карточка того же multi-announcement поста не блокируется;
- soft delete может появиться снова;
- owner-manual permanent delete блокирует повторное добавление;
- owner-manual soft delete разрешает повторное добавление;
- routing различает обычное и permanent удаление;
- историческая cleanup-команда не удаляет старые события.
