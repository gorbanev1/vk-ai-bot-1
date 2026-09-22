import { extractExplicitGptMode } from '../ai/gptModeRouting.js';
import { extractReasoningEffortModifier, getDefaultReasoningEffortForMode } from '../ai/reasoningEffortRouting.js';

// TXT uses exactly the same existing model modes and GPT_MODEL_* configuration as
// ordinary chat. No model family or effort is forced just because a file is TXT.
// Resolve the effort first: "terra max" is Terra + max, not the legacy "max" Astra alias.
export function resolveTextAttachmentModelChoice(requestText) {
    const original = String(requestText || '').trim();
    const unaddressed = original.replace(/^гигорейв\s*[,.:;!?-]?\s*/iu, '').trim();
    // The owner-only TXT route consumes this transport key BEFORE model routing.
    // It works with every configured model/effort and is never merely a request
    // to the model to ignore local chunking.
    const wholeFile = /(?:^|\s)\/txt_full(?=$|[\s,.;:!?])/iu.test(unaddressed);
    const cleanRequest = unaddressed.replace(/(?:^|\s)\/txt_full(?=$|[\s,.;:!?])/giu, ' ').replace(/\s{2,}/gu, ' ').trim();
    const explicitEffort = extractReasoningEffortModifier(cleanRequest);
    const parsed = extractExplicitGptMode(explicitEffort.body);
    let mode = parsed.mode;
    let prompt = parsed.body;

    // The ordinary mode parser recognises "gpt55"/"gpt54" and the mini/pro
    // aliases, but not the dotted IDs "gpt-5.5" and "gpt-5.4".
    if (parsed.source === 'implicit') {
        const dotted = /(?:^|[\s,;:!?()])gpt[-_\s]?5[.]([45])(?:\s|$|[,;:!?()])/iu.exec(prompt);
        if (dotted) {
            mode = dotted[1] === '5' ? 'gpt55' : 'gpt54';
            prompt = prompt.replace(dotted[0], ' ').replace(/\s{2,}/gu, ' ').trim();
        }
    }
    // Preserve the existing explicit shorthand "max" for Astra, without
    // accidentally changing "terra max" or "sol max" into Astra.
    if (mode === 'default' && parsed.source === 'implicit' &&
        /(?:^|[\s,;:!?()])max(?=$|[\s,;:!?()])/iu.test(cleanRequest)) {
        mode = 'astra';
    }
    let reasoningEffort = explicitEffort.effort || getDefaultReasoningEffortForMode(mode);
    // All adapter-advertised Astra levels, including none/default, may be
    // requested explicitly. Other modes use the same explicit levels as chat.
    const extraEffort = /(?:^|[\s,;:!?()])(?:reasoning|интеллект|уровень\s+интеллекта)\s*[:=]?\s*(none|default|minimal)(?=$|[\s,;:!?()])/iu.exec(prompt);
    if (extraEffort) {
        reasoningEffort = extraEffort[1].toLowerCase();
        prompt = prompt.replace(extraEffort[0], ' ').replace(/\s{2,}/gu, ' ').trim();
    } else if (mode === 'astra') {
        const standalone = /(?:^|[\s,;:!?()])(none|minimal)(?=$|[\s,;:!?()])/iu.exec(prompt);
        if (standalone) {
            reasoningEffort = standalone[1].toLowerCase();
            prompt = prompt.replace(standalone[0], ' ').replace(/\s{2,}/gu, ' ').trim();
        }
    }
    return { mode, reasoningEffort, prompt, wholeFile, explicitModel: mode !== 'default' || parsed.source !== 'implicit' };
}
