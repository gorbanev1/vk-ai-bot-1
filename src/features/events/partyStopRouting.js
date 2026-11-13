/**
 * Stop only the remainder of a manual party response in the same chat.
 * One generation is captured before routing; a newer "тусы стоп" invalidates
 * all older concurrent event requests, including while posters/AI are pending.
 */
const generations = new Map();
const requestTokens = new WeakMap();
const escaped = /(^|[^\p{L}\p{N}_])экранировать(?=$|[^\p{L}\p{N}_])/iu;
const stopCommand = /^(?:(?:гигорейв|гигарейв|gigorave)[\s,.:!?-]+)?тусы\s+стоп[.!?\s]*$/iu;
export function isEscapedCommandText(text) { return escaped.test(String(text ?? '')); }
export function isPartyStopCommand(text) { return stopCommand.test(String(text ?? '').trim()); }
function location(context) {
    const platform = String(context?.platform || (context?.telegramMessageThreadId !== undefined ? 'telegram' : 'vk')).toLowerCase();
    const peer = platform === 'telegram'
        ? (context?.externalPeerId ?? context?.peerId)
        : (context?.peerId ?? context?.externalPeerId);
    return platform + ':' + String(peer ?? '');
}
export function capturePartyRequest(context) {
    const key = location(context);
    const token = { key, generation: generations.get(key) || 0 };
    requestTokens.set(context, token);
    return token;
}
export function stopPartyRequests(context) {
    const key = location(context);
    const next = (generations.get(key) || 0) + 1;
    generations.set(key, next);
    return next;
}
export function partyRequestStopped(context) {
    const token = requestTokens.get(context) || capturePartyRequest(context);
    return token.generation !== (generations.get(token.key) || 0);
}
export function guardPartyContext(context) {
    const token = requestTokens.get(context) || capturePartyRequest(context);
    const guarded = new Proxy(context, {
        get(target, property, receiver) {
            if (property === 'send') {
                return (...args) => partyRequestStopped(guarded)
                    ? Promise.resolve(undefined)
                    : target.send(...args);
            }
            return Reflect.get(target, property, receiver);
        },
    });
    requestTokens.set(guarded, token);
    return guarded;
}
