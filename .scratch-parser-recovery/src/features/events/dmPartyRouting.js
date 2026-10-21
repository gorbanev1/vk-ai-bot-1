function normalize(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/[^\p{L}\p{N}@]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

const PARTY_SUBJECT_PATTERN = /(?:^|\s)(?:тус(?:а|у|е|ы|овка|овку|овке|овки)|вечеринк(?:а|у|е|и)|гиг(?:а|у|е)?|наш(?:а|у|ей)\s+тус(?:а|у|е)|ваш(?:а|у|ей)\s+тус(?:а|у|е)|твоя\s+тус(?:а|у|е)|следующ(?:ая|ую|ей)\s+тус(?:а|у|е|ы)|ближайш(?:ая|ую|ей)\s+тус(?:а|у|е|ы))(?:$|\s)/u;
const PUBLIC_EVENT_PATTERN = /(?:афиш|мероприят|концерт(?:ы|ов)?|куда\s+сходить|что\s+сегодня|событи|вечеринк(?:и|ок)|тус(?:ы|овки|овок)|на\s+выходн|на\s+недел|на\s+месяц)/u;
const DATE_PATTERN = /(?:когда|дата|число|во\s+сколько|время|сегодня|завтра|послезавтра|следующ|ближайш)/u;
const FORMAT_PATTERN = /(?:формат|музык|жанр|кто\s+игра|состав|артист|участник|помощ|организац|что\s+будет|как\s+будет)/u;
const INFO_PATTERN = /(?:подробност|информац|анонс|известн|где\s+узнать|когда\s+объяв|когда\s+появ)/u;
const ORGANIZER_PARTY_ANCHOR_PATTERN = /(?:наш(?:а|у|ей|и)?|ваш(?:а|у|ей|и)?|тво(?:я|ю|ей|и))\s+(?:тус(?:а|у|е|ы|овка|овку|овке|овки)|вечеринк(?:а|у|е|и)|гиг(?:а|у|е|и)?)/u;
const SINGULAR_NEAREST_PARTY_PATTERN = /(?:следующ(?:ая|ую|ей)|ближайш(?:ая|ую|ей))\s+(?:тус(?:а|у|е|ы|овка|овку|овке)|вечеринк(?:а|у|е)|гиг(?:а|у|е)?)/u;

export function classifyExplicitDmPartyRequest(value) {
    const text = normalize(value);

    if (!text) {
        return {
            matched: false,
            reason: 'empty',
            intents: [],
        };
    }

    const hasPrivatePartyAnchor = (
        ORGANIZER_PARTY_ANCHOR_PATTERN.test(text) ||
        SINGULAR_NEAREST_PARTY_PATTERN.test(text)
    );

    if (PUBLIC_EVENT_PATTERN.test(text) && !hasPrivatePartyAnchor) {
        return {
            matched: false,
            reason: 'public-events-request',
            intents: [],
        };
    }

    if (!PARTY_SUBJECT_PATTERN.test(` ${text} `)) {
        return {
            matched: false,
            reason: 'no-explicit-party-subject',
            intents: [],
        };
    }

    const intents = [];

    if (DATE_PATTERN.test(text)) {
        intents.push('party_date');
    }

    if (FORMAT_PATTERN.test(text)) {
        intents.push('party_format');
    }

    if (INFO_PATTERN.test(text)) {
        intents.push('party_info');
    }

    if (!intents.length) {
        return {
            matched: false,
            reason: 'party-subject-without-supported-intent',
            intents: [],
        };
    }

    return {
        matched: true,
        reason: 'explicit-party-question',
        intents,
    };
}
