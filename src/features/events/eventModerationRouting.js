export function parseEventModerationCommand(value) {
    const text = String(value ?? '')
        .trim()
        .replace(/^гигорейв[\s,:-]*/iu, '')
        .trim();

    if (/^(?:(?:тусы|тусовки|события)\s+(?:удал[её]нные\s+нас(?:о|а)всем|удал[её]нные\s+навсегда|permanent\s+delete(?:d)?|вечный\s+бан)|(?:удал[её]нные\s+нас(?:о|а)всем|удал[её]нные\s+навсегда)\s+(?:тусы|тусовки|события))$/iu.test(text)) {
        return { action: 'permanent-list', query: '' };
    }

    if (/^(?:ч[её]рный\s+список\s+(?:тус|тусовок|событий)|blacklist\s+(?:тус|событий)|тусы\s+blacklist)$/iu.test(text)) {
        return { action: 'list', query: '' };
    }

    if (/^(?:(?:тусы|тусовки|события)\s+провер(?:ь|ить)|провер(?:ь|ить)\s+(?:тусы|тусовки|события))$/iu.test(text)) {
        return { action: 'verify', query: '' };
    }

    if (/^(?:тусы\s+дубли\s+статус|статус\s+(?:проверки\s+)?дубл(?:ей|икатов)\s+(?:тус|событий)?)$/iu.test(text)) {
        return { action: 'duplicates-status', query: '' };
    }

    if (/^(?:(?:тусы|события)\s+(?:метаданные\s+картинок|картинки\s+метаданные)(?:\s+(?:отч[её]т|проверить|ревью))?|(?:отч[её]т|ревью)\s+(?:по\s+)?метаданным\s+(?:картинок|афиш))$/iu.test(text)) {
        return { action: 'image-metadata-report', query: '' };
    }

    if (/^(?:тусы|события)\s+(?:картинки|афиши|изображения)\s+(?:полная\s+проверка|все\s+через\s+(?:ии|ai)|проверить\s+все)$/iu.test(text)) {
        return { action: 'image-metadata-full-audit', query: '' };
    }

    // Explicit source-media Vision pass. This is intentionally separate from
    // the ordinary metadata backfill: it rechecks every locally retained
    // source image, including orphan/source-only rows.
    if (/^(?:(?:тусы|события)\s+(?:(?:источники|исходники)\s+)?(?:картинки|афиши|изображения)\s+(?:через\s+)?(?:ии|ai|vision)|(?:тусы|события)\s+vision\s+(?:картинки|афиши|источники|исходники))$/iu.test(text)) {
        return { action: 'source-image-vision-audit', query: '' };
    }

    if (/^(?:(?:тусы|события)\s+(?:метаданные\s+картинок|картинки\s+метаданные)\s+(?:заполнить|добавить|распознать|backfill)|(?:заполнить|добавить|распознать)\s+метаданные\s+(?:картинок|афиш))$/iu.test(text)) {
        return { action: 'image-metadata-backfill', query: '' };
    }

    if (/^(?:(?:тусы|события)\s+(?:картинки|афиши)\s+(?:на\s+)?ревью|(?:ревью|выбрать)\s+(?:картинки|афиши)\s+(?:тус|событий)?)$/iu.test(text)) {
        return { action: 'poster-review', query: '' };
    }

    if (/^(?:(?:тусы|события)\s+(?:архив\s+)?(?:картинок|афиш)\s+(?:сжать|сжать\s+старые)|(?:сжать|архивировать)\s+(?:старые\s+)?(?:картинки|афиши))$/iu.test(text)) {
        return { action: 'archive-old-images', query: '' };
    }

    const refresh = text.match(/^(?:тусы|события)\s+(?:обновить|обнови|перепроверить|перепроверь)\s+(?:все\s+)?будущие(?:\s+(?:тусы|события|афиши))?(?:\s+(безфото|бф))?$/iu);
    if (refresh || /^(?:тусы|события)\s+будущие\s+(?:обновить|обнови)$/iu.test(text)) {
        return { action: 'refresh-upcoming-events', query: '', onlyMissingPoster: Boolean(refresh?.[1]) };
    }

    if (/^(?:тусы\s+дубли\s+(?:провер(?:ь|ить)|скан(?:ировать|ируй)?|dry\s*run)|(?:провер(?:ь|ить)|скан(?:ировать|ируй)?)\s+(?:базу\s+)?(?:тус|тусовок|событий)\s+на\s+дубли)$/iu.test(text)) {
        return { action: 'duplicates-deep', query: '' };
    }

    if (/^(?:тусы\s+(?:перепарсить|перепарсить\s+все|пересобрать)\s+(?:по\s+)?ссылк(?:и|ам)|(?:перепарсить|пересобрать)\s+(?:все\s+)?(?:тусы|события)\s+(?:по\s+)?ссылк(?:и|ам))$/iu.test(text)) {
        return { action: 'reparse-links', query: '' };
    }

    // Recovery is a separate owner operation even though it uses the same
    // proven URL reparse pipeline. Keeping a distinct action lets the bot
    // report missing source links and recovered source rows explicitly.
    if (/^(?:(?:тусы|события)\s+(?:источники|исходники|source)\s+(?:восстановить|добрать|backfill)|(?:восстановить|добрать)\s+(?:источники|исходники)\s+(?:тус|событий)?)$/iu.test(text)) {
        return { action: 'source-recovery', query: '' };
    }

    if (/^(?:тусы\s+дубли\s+(?:применить|очистить)|(?:применить|очистить)\s+дубли\s+(?:тус|тусовок|событий)|(?:дедуп|дедупликацию)\s+(?:тус|тусовок|событий)\s+(?:применить|запустить))$/iu.test(text)) {
        return { action: 'duplicates-apply', query: '' };
    }

    if (/^(?:(?:провер(?:ь|ить)|найти|покажи)\s+(?:тусы|события)?\s*(?:на\s+)?(?:совпадения|дубли|дубликаты)|(?:дубли|дубликаты|совпадения)\s+(?:тус|тусовок|событий))(?:\s+все)?$/iu.test(text)) {
        return { action: 'duplicates', query: '' };
    }

    let match = text.match(/^(?:верни|вернуть|разблокируй|разблокировать)\s+(?:тусу|тусовку|событие)\s*:?[\s]+(.+)$/iu);
    if (match) return { action: 'restore', query: match[1].trim() };

    match = text.match(/^(?:тусы|тусовки)\s+(?:верни|вернуть)\s*:?[\s]+(.+)$/iu);
    if (match) return { action: 'restore', query: match[1].trim() };

    if (/^(?:тусы|тусовки|события)\s+(?:исправить|исправь|редактировать|редактируй)\s*:?$/iu.test(text)) {
        return { action: 'edit-start', query: '' };
    }

    match = text.match(/^(?:тусы|тусовки|события)\s+(?:исправить|исправь|редактировать|редактируй)\s*:?\s+(.+)$/iu);
    if (match) return { action: 'edit', query: match[1].trim() };

    match = text.match(/^(?:исправить|исправь|редактировать|редактируй)\s+(?:тусу|тусовку|событие)\s*:?\s+(.+)$/iu);
    if (match) return { action: 'edit', query: match[1].trim() };

    match = text.match(/^(?:удали|удалить|убери|убрать|заблокируй|заблокировать)\s+(?:тусу|тусовку|событие)\s+(?:нас(?:о|а)всем|навсегда|перманентно)\s*:?\s+(.+)$/iu);
    if (match) return { action: 'delete-permanent', query: match[1].trim() };

    match = text.match(/^(?:тусы|тусовки|события)\s+(?:удали|удалить|убери|убрать)\s+(?:нас(?:о|а)всем|навсегда|перманентно)\s*:?\s+(.+)$/iu);
    if (match) return { action: 'delete-permanent', query: match[1].trim() };

    match = text.match(/^(?:удали|удалить|убери|убрать)\s+(?:нас(?:о|а)всем|навсегда|перманентно)\s+(?:тусу|тусовку|событие)\s*:?\s+(.+)$/iu);
    if (match) return { action: 'delete-permanent', query: match[1].trim() };

    match = text.match(/^(?:удали|удалить|убери|убрать|скрой|скрыть|заблокируй|заблокировать)\s+(?:тусу|тусовку|событие)\s*:?[\s]+(.+)$/iu);
    if (match) return { action: 'delete', query: match[1].trim() };

    match = text.match(/^(?:тусу|тусовку|событие)\s+(?:удали|удалить|убери|убрать|скрой|скрыть)\s*:?[\s]+(.+)$/iu);
    if (match) return { action: 'delete', query: match[1].trim() };

    match = text.match(/^(?:тусы|тусовки)\s+(?:удали|удалить|убери|убрать)\s*:?[\s]+(.+)$/iu);
    if (match) return { action: 'delete', query: match[1].trim() };

    return null;
}
