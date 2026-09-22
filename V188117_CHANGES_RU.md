# V188.117 — явный текстовый MULTIPASS по stream

- `PROJECT_ARCHIVE_INPUT_MODE=text` имеет приоритет над `PROJECT_ARCHIVE_AUDIT_MULTIPASS`
  при выборе маршрута, статусах job и предупреждениях оператору.
- Новый этап `text-multipass-start` фиксирует выбранный транспорт перед пакетной обработкой.
- `PROJECT_ARCHIVE_MULTIPASS_TRANSPORT=stream` запрещает background для всех
  мультипроходных Astra-запросов; в режиме `text` stream также используется по умолчанию.
  Для старого single-shot сохранилось управление `PROJECT_ARCHIVE_SINGLE_TRANSPORT`.
- Защита в `generateOpenAIText`: при текстовом проектном аудите непустой `inputFiles`
  отклоняется до любого вызова `uploadOpenAIInputFile`.
- Проверка CRC/фильтрация исходников, последовательная обработка и checkpoint каждого
  законченного batch сохранены; данные старых job directories не затрагиваются.
- Обновлён устаревший тест V188.107 и добавлен регрессионный V188.117.

Важно: сам ZIP не устанавливает окружение и не проверяет реальный Astra; применять
поверх полного рабочего проекта. MULTIPASS — несколько отдельных платных запросов,
не one-shot.
