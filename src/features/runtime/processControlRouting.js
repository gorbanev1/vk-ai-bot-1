function clean(value) {
    return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

export function parseProcessControlCommand(value) {
    const text = clean(value)
        .replace(/^(?:гигорейв|gigorave)[\s,:;—–-]*/iu, '')
        .replace(/[\s,:;—–-]*(?:гигорейв|gigorave)$/iu, '')
        .trim();
    if (!text) return null;

    if (/^(?:процессы|процессы\s+статус|активные\s+процессы|незаверш[её]нные\s+процессы|задачи|задачи\s+статус)$/iu.test(text)) {
        return { action: 'list' };
    }

    let match = text.match(/^(?:процесс|задача)\s+([\w-]+)$/iu);
    if (match) return { action: 'details', id: match[1] };

    if (/^(?:прервать|остановить|отменить|убить)\s+(?:все\s+)?(?:процессы|задачи)$/iu.test(text)) {
        return { action: 'stop-all' };
    }
    if (/^(?:прервать|остановить|отменить)\s+(?:мои\s+)?(?:процессы|задачи)$/iu.test(text)) {
        return { action: 'stop-mine' };
    }

    match = text.match(/^(?:прервать|остановить|отменить|убить)\s+(?:процесс|задачу)\s+([\w-]+)$/iu);
    if (match) return { action: 'stop-one', id: match[1] };

    return null;
}
