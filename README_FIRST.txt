VK AI BOT — cumulative patch V107
Build: events-v107-industrial-dedupe-precision
Главное в V107:
- сохраняет весь V106: два VK-сообщества, Telegram, coords-requester registry и owner-рассылку;
- precision-first дедупликация афиши; DIESEL HALL != Diesel Bar;
- hard venue/time conflicts не переопределяются AI;
- generic title и один артист из большого лайнапа не считаются достаточной идентичностью;
- явная многодневность обязательна для склейки соседних дат;
- V3 verified snapshot автоматически инвалидирует старый dedupe cache;
- финальный fixed-point pass использует candidate blocking вместо скрытого O(N²).


Главное в V96:
- VK-беседа: DOM + VK API hydration репостов/wall/copy_history;
- image-only сообщения и афиши идут в vision, даже если текст сообщения пуст;
- «что на изображении» на reply к VK-repost гидратирует reply/wall и собирает до 8 картинок;
- автоматическая прокрутка VK-беседы идёт небольшими порциями, по умолчанию 10 сообщений, с ожиданием lazy-media;
- live parser работает до закрытия вкладки: ручная прокрутка через час/день всё ещё обрабатывается;
- финал VK-chat parsing = закрытие вкладки/явный stop; после очереди сообщений автоматически обновляется verified event cache;
- новая owner-команда «Гигорейв тусы проверить» делает полный тяжёлый AI/dedupe/merge pass;
- при старте бота этот полный pass НЕ запускается;
- обычные «тусы ...» / «тусы ... кратко» работают из data/event-verified-snapshot.json без AI на запрос;
- после одиночного публичного ручного парсинга snapshot обновляется автоматически;
- V95 complete-link dedupe, V90 blacklist, V89 single-pass browser и остальные предыдущие изменения сохранены.

Первое действие после установки:
Гигорейв тусы проверить

VK-беседа:
Гигорейв парсер chat:2000000022

См. PATCH_INSTALL_V96.txt и PATCH_NOTES_EVENTS_V96_CHAT_REPOST_VISION_LIVE_VERIFIED_EVENTS_CACHE.txt.
