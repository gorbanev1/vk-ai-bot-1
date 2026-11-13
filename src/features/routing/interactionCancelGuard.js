/** Global cancellation is a control command, not a conversational keyword. */
export const BARE_CANCEL_RE=/^(?:отмена|отменить|отмени|cancel|стоп|сброс(?:ить)?(?:\s+(?:режим|состояние))?|отменить\s+отправку|выйти)[.!?\s]*$/iu;

export function isBareGlobalInteractionCancelPhrase(value){
 return BARE_CANCEL_RE.test(String(value??'').trim());
}

/**
 * DM: stand-alone cancellation is allowed (but meaningful only when pending).
 * Groups: an explicit bot address is always required; replying to a message
 * or continuing a chat session is NOT sufficient to cancel workflows.
 */
export function shouldHandleGlobalInteractionCancel({value,isPrivate=false,addressed=false}={}){
 return isBareGlobalInteractionCancelPhrase(value) && (isPrivate || addressed);
}
