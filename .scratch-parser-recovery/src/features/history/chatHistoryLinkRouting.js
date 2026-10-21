/**
 * Owner-only routing for rebinding the durable history of a deleted group chat
 * to a replacement chat. Parsing stays platform-agnostic; the application layer
 * decides whether the sender is the owner and performs the migration.
 */

function normalize(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[«»"'`]/gu, ' ')
        .replace(/[.,!?;]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

export function parseChatHistoryLinkCommand(value) {
    let text = normalize(value);

    if (!text) {
        return { matched: false, sourcePeerId: null };
    }

    text = text.replace(/^\/?(?:гигорейв|gigorave)\s+/iu, '').trim();

    const commandMatch = text.match(
        /^(?:(?:привязать|привяжи|подцепить|подцепи|перенести|перенеси|восстановить|восстанови)\s+(?:(?:старую|старой)\s+)?(?:историю|историю\s+(?:чата|беседы)|чат|беседу)|(?:привязать|привяжи|подцепить|подцепи)\s+(?:старую\s+)?беседу)(?:\s+(?:из\s+)?(?:peer|пир)\s*:?\s*(-?\d+))?$/iu,
    );

    if (!commandMatch) {
        return { matched: false, sourcePeerId: null };
    }

    const parsedPeerId = commandMatch[1]
        ? Number(commandMatch[1])
        : null;

    return {
        matched: true,
        sourcePeerId: Number.isSafeInteger(parsedPeerId)
            ? parsedPeerId
            : null,
    };
}
