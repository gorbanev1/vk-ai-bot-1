const RECOVERY_POLICIES = [
    {
        matches: ({ name }) => name === 'startup-telegram-connect',
        policy: 'retry-by-connection-manager',
        action: 'reconnect-scheduled',
        ownerActionRequired: false,
        explanation: 'Telegram reconnect manager retries connection after startup.',
    },
    {
        matches: ({ name }) => name.startsWith('vk-history-recovery:'),
        policy: 'retry-idempotent-window',
        action: 'startup-cycle-scheduled',
        ownerActionRequired: false,
        explanation: 'A bounded history window is retried by the startup recovery cycle; stored messages are deduplicated.',
    },
    {
        matches: ({ name }) => name.startsWith('summary-hierarchy:'),
        policy: 'resume-from-durable-calendar-state',
        action: 'calendar-catch-up-scheduled',
        ownerActionRequired: false,
        explanation: 'Calendar maintenance rebuilds missing summary slices from durable batch state.',
    },
];

export function classifyInterruptedOperation(operation = {}) {
    const identity = {
        name: String(operation.name || ''),
        category: String(operation.category || ''),
    };
    if (identity.category === 'test' || identity.category.startsWith('test-')) {
        return {
            policy: 'ignore-test-artifact',
            action: 'test-checkpoint-abandoned',
            ownerActionRequired: false,
            explanation: 'A test operation checkpoint is ignored during production recovery.',
        };
    }
    const policy = RECOVERY_POLICIES.find((entry) => entry.matches(identity));
    if (policy) {
        const { matches, ...result } = policy;
        return result;
    }
    if (identity.category === 'parser' || identity.name.startsWith('parser-all')) {
        const depth = Number(operation.metadata?.autoRecoveryDepth || 0);
        if (depth >= 1) {
            return {
                policy: 'managed-parser-recovery-limit-reached',
                action: 'owner-can-resume-from-parser-cache',
                ownerActionRequired: true,
                explanation: 'Automatic cache recovery has reached its one-retry safety limit; an owner may use «Гигорейв парсер все восстановить».',
            };
        }
        return {
            policy: 'managed-parser-recovery',
            action: 'parser-cache-recovery-managed-separately',
            ownerActionRequired: false,
            explanation: 'Parser recovery uses its raw-cache and ledger checkpoint flow, with at most one automatic continuation.',
        };
    }
    if (identity.category === 'user-request') {
        return {
            policy: 'do-not-replay-user-request',
            action: 'request-not-repeated',
            ownerActionRequired: false,
            explanation: 'The interrupted request may have produced an external side effect and is not replayed automatically.',
        };
    }
    return {
        policy: 'owner-review-required',
        action: 'manual-resume-decision',
        ownerActionRequired: true,
        explanation: 'No registered restart policy exists; automatic replay could duplicate work or external effects.',
    };
}
