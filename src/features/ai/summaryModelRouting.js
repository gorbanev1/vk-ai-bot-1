import { GPT_MODEL_ADVANCEMENT_ORDER } from './openAIRetryRouting.js';

/**
 * Summary workloads must obey the same cheapest-to-strongest ladder as the
 * rest of the bot. Sol/pro3 is deliberately the final emergency fallback,
 * never the default model for scheduled or hierarchical summaries.
 */
export const SUMMARY_MODEL_MODE_ORDER = Object.freeze([
    ...GPT_MODEL_ADVANCEMENT_ORDER,
]);

export function resolveSummaryStartMode() {
    return SUMMARY_MODEL_MODE_ORDER[0] || 'default';
}

/**
 * Summary calls share the bot-wide model-specific attempt budgets
 * (Luna 4, Sol 3, Astra 2), then advance to the next mode. A non-technical/content error is
 * returned to the caller immediately and must not burn the whole ladder.
 */
export function getSummaryModelFailoverOptions() {
    return {
        escalateToAdvanced: true,
        failoverMaxRounds: 1,
        failuresBeforeQuarantine: 4,
        useCredentialHealth: false,
        oneCandidatePerMode: true,
    };
}
