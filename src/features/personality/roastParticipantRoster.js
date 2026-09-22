function clean(value) {
    return String(value ?? '')
        .replace(/\s+/gu, ' ')
        .trim();
}

function normalizeScreenName(value) {
    return clean(value)
        .replace(/^@+/u, '')
        .replace(/^https?:\/\/(?:www\.)?vk\.(?:com|ru)\//iu, '')
        .replace(/^vk\.(?:com|ru)\//iu, '')
        .replace(/[/?#].*$/u, '')
        .trim();
}

export function extractVkTargetReference(query) {
    const raw = clean(query);
    const mentionMatch = raw.match(/\[(?:id)?(\d+)\|([^\]]+)\]/iu);

    if (mentionMatch) {
        return {
            userId: Number(mentionMatch[1]),
            screenName: '',
            displayName: clean(mentionMatch[2]).replace(/^@+/u, ''),
            source: 'vk-mention',
        };
    }

    const idMatch = raw.match(/(?:^|\s)(?:id)?(\d{1,12})(?:$|\s)/iu);
    if (idMatch) {
        return {
            userId: Number(idMatch[1]),
            screenName: '',
            displayName: '',
            source: 'vk-id',
        };
    }

    const linkMatch = raw.match(/(?:https?:\/\/(?:www\.)?vk\.(?:com|ru)\/|vk\.(?:com|ru)\/)([A-Za-z0-9_.-]+)/iu);
    const atMatch = raw.match(/(?:^|\s)@([A-Za-z0-9_.-]{3,})/u);
    const screenName = normalizeScreenName(linkMatch?.[1] || atMatch?.[1] || '');

    if (screenName) {
        return {
            userId: 0,
            screenName,
            displayName: `@${screenName}`,
            source: linkMatch ? 'vk-link' : 'vk-screen-name',
        };
    }

    return null;
}

function profileAliases(profile, fullName, screenName) {
    const id = Number(profile?.id ?? profile?.member_id ?? 0);
    const firstName = clean(profile?.first_name);
    const lastName = clean(profile?.last_name);

    return [
        fullName,
        firstName,
        lastName,
        screenName,
        screenName ? `@${screenName}` : '',
        id > 0 ? `id${id}` : '',
        id > 0 && fullName ? `[id${id}|${fullName}]` : '',
    ].filter(Boolean);
}

export function normalizeVkConversationMembers(payload) {
    const profiles = Array.isArray(payload?.profiles)
        ? payload.profiles
        : [];
    const items = Array.isArray(payload?.items)
        ? payload.items
        : [];
    const profilesById = new Map(
        profiles
            .map((profile) => [Number(profile?.id), profile])
            .filter(([id]) => Number.isSafeInteger(id) && id > 0),
    );
    const ids = items.length
        ? items
            .map((item) => Number(item?.member_id ?? item?.id))
            .filter((id) => Number.isSafeInteger(id) && id > 0)
        : [...profilesById.keys()];
    const seen = new Set();
    const participants = [];

    for (const userId of ids) {
        if (seen.has(userId)) {
            continue;
        }
        seen.add(userId);

        const profile = profilesById.get(userId) || {};
        const fullName = clean([
            profile.first_name,
            profile.last_name,
        ].filter(Boolean).join(' '));
        const screenName = normalizeScreenName(profile.screen_name || profile.domain || '');

        participants.push({
            userId,
            externalUserId: screenName,
            screenName,
            displayName: fullName || (screenName ? `@${screenName}` : `Участник ${userId}`),
            aliases: profileAliases(profile, fullName, screenName),
            lastSeenAt: 0,
            rosterSource: 'vk-conversation-members',
        });
    }

    return participants;
}

export function mergeRoastParticipants(primary, extra) {
    const merged = new Map();

    for (const participant of [
        ...(Array.isArray(primary) ? primary : []),
        ...(Array.isArray(extra) ? extra : []),
    ]) {
        const userId = Number(participant?.userId);
        if (!Number.isSafeInteger(userId) || userId <= 0) {
            continue;
        }

        const current = merged.get(userId) || {};
        const aliases = new Set([
            ...(Array.isArray(current.aliases) ? current.aliases : []),
            ...(Array.isArray(participant.aliases) ? participant.aliases : []),
            current.displayName,
            participant.displayName,
            current.externalUserId,
            participant.externalUserId,
            current.screenName,
            participant.screenName,
        ].map(clean).filter(Boolean));

        merged.set(userId, {
            ...participant,
            ...current,
            userId,
            displayName: clean(current.displayName || participant.displayName || `Участник ${userId}`),
            externalUserId: clean(current.externalUserId || participant.externalUserId),
            screenName: clean(current.screenName || participant.screenName),
            lastSeenAt: Math.max(
                Number(current.lastSeenAt ?? 0),
                Number(participant.lastSeenAt ?? 0),
            ),
            aliases: [...aliases],
            rosterSource: clean(current.rosterSource || participant.rosterSource),
        });
    }

    return [...merged.values()];
}

export function participantFromVkProfile(profile, fallbackReference = null) {
    const userId = Number(profile?.id);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        return null;
    }

    const fullName = clean([
        profile?.first_name,
        profile?.last_name,
    ].filter(Boolean).join(' '));
    const screenName = normalizeScreenName(
        profile?.screen_name ||
        profile?.domain ||
        fallbackReference?.screenName ||
        '',
    );

    return {
        userId,
        externalUserId: screenName,
        screenName,
        displayName: fullName || fallbackReference?.displayName || (screenName ? `@${screenName}` : `Участник ${userId}`),
        aliases: profileAliases(profile, fullName, screenName),
        lastSeenAt: 0,
        rosterSource: 'vk-users-get',
    };
}
