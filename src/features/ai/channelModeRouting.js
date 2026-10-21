function clean(value) {
    return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

export function parseAiChannelModeCommand(value) {
    const text = clean(value).replace(/^(?:гигорейв|gigorave)[\s,:;—–-]*/iu, '').trim();
    if (/^(?:канал\s+астра|астра\s+канал|переключи(?:ться)?\s+на\s+астру|включи\s+астру)$/iu.test(text)) {
        return { action: 'astra' };
    }
    if (/^(?:обычный\s+канал|канал\s+обычный|верни\s+обычный\s+канал|выключи\s+астру)$/iu.test(text)) {
        return { action: 'ordinary' };
    }
    if (/^(?:канал\s+статус|статус\s+канала|какой\s+канал)$/iu.test(text)) {
        return { action: 'status' };
    }
    return null;
}
