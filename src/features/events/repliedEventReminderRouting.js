// Pure routing for a reply to an exact, bot-authored VK event card.
export function parseRepliedEventReminderRequest(raw) {
    const text = String(raw ?? '').replace(/\s+/gu, ' ').trim();
    const head = text.match(/^(напоминай|напомни(?:ть)?|напоминать|форси(?:ть)?|форсируй)\s+([\s\S]+)$/iu);
    if (!head) return null;
    let tail = head[2].trim();
    const personal = /^мне(?:\s|$)/iu.test(tail);
    tail = tail.replace(/^(?:всем|мне)(?=\s|$)\s*/iu, '');
    tail = tail.replace(/^(?:(?:об|о|про)\s+)?(?:этом|эту|этой|это|данном|данную)\s+(?:событии|событие|тусу|тусе|вечеринке|вечеринку|мероприятии|мероприятие)(?=\s|$)\s*/iu, '');
    tail = tail.replace(/(?:^|\s)до\s+(?:самого\s+)?(?:начала|старта)\s*(?:этого\s+)?(?:события|мероприятия|концерта|тусы|тусовки|вечеринки)?\s*$/iu, '').trim();
    tail = tail.replace(/(?:^|\s)до\s+(?:дня|даты)\s+(?:мероприятия|события)\s*$/iu, '').trim();
    tail = tail.replace(/^каждые\s+сутки\b/iu, 'каждый день');
    if (/(?:каждый\s+день|ежедневно)/iu.test(tail)) {
        tail = tail.replace(/(\d+|два|три|четыре)\s+(?:раза|раз)(?=\s|$)(?!\s+в\s+день)/giu, '$1 раза в день');
    }
    if (!tail) return { valid: false, personal, error: 'Нужно указать расписание. Например: каждый день 2 раза в день с 10:00 до 18:00 до начала мероприятия.' };
    const verb = /^(?:напомни|напомнить)$/iu.test(head[1]) ? 'напомни' : 'напоминай';
    return { valid: true, personal, command: verb + ' мне ' + tail };
}

export function extractSourceUrlsFromRepliedEventCard(text) {
    const value = String(text ?? '');
    if (!/(?:^|\n)\s*🎸\s*\S/u.test(value) || !/(?:^|\n)\s*📅\s*\S/u.test(value)) return [];
    const section = value.match(/(?:^|\n)\s*Источники?:\s*([\s\S]*?)(?=\n\s*(?:❗|🔔|📅\s*«)|$)/iu)?.[1];
    if (!section) return [];
    return [...new Set((section.match(/https?:\/\/[^\s()<>'"«»]+/giu) || []).map(x=>x.replace(/[.,;!?]+$/u,'')).filter(Boolean))];
}

export function eventCardDateAndTitle(text) {
    const value=String(text??'');
    const title=value.match(/(?:^|\n)\s*🎸\s*([^\r\n]+)/u)?.[1]?.trim() || '';
    const d=value.match(/(?:^|\n)\s*📅\s*(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(20\d{2})/iu);
    const months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
    const iso=d ? d[3]+'-'+String(months.indexOf(d[2].toLowerCase())+1).padStart(2,'0')+'-'+String(d[1]).padStart(2,'0') : '';
    return { title, date: iso };
}

// Explicit address is required for arbitrary quoted VK messages.
export function parseRepliedVkForwardReminder(raw) {
    const prefix=String(raw??'').trim().match(/^гигорейв(?:[,:.!]+\s*|\s+)([\s\S]*)$/iu);
    if(!prefix)return null;
    const verb=prefix[1].trim().match(/^(напомни(?:ть)?|напоминай|напоминать|форси(?:ть)?|форсируй)(?=\s|$)\s*([\s\S]*)$/iu);
    if(!verb)return null;
    let schedule=verb[2].trim()
        .replace(/^(?:(?:мне|всем)\s+)?(?:(?:об|о|про)\s+)?(?:(?:это|эту|этом|данное|данном|исходное)\s+)?(?:сообщение|сообщении|пост|посте|текст|тексте)(?=\s|$)\s*/iu,'')
        .replace(/^(?:мне|всем)(?=\s|$)\s*/iu,'')
        .replace(/^(?:это|его|сообщение|пост)(?=\s|$)\s*/iu,'')
        .replace(/\s+в\s+(?:эту\s+)?беседу\s*$/iu,'')
        .replace(/\s+в\s+(?:этот\s+)?чат\s*$/iu,'').trim();
    if(/(?:каждый\s+день|ежедневно)/iu.test(schedule))
        schedule=schedule.replace(/(\d+|два|три|четыре)\s+раза?(?!\s+в\s+день)(?=\s|$)/giu,'$1 раза в день');
    if(!schedule)return {valid:false,error:'Укажи расписание: «Гигорейв, напоминай это сообщение каждый день в 10:00».'};
    const base=/^(?:напомни|напомнить)$/iu.test(verb[1])?'напомни':'напоминай';
    return {valid:true,command:base+' мне '+schedule+' переслать сообщение'};
}

// Never use reply_to: VK forwards the original message with attachments.
export function buildVkForwardReminderParams({peerId,sourcePeerId,sourceCmid,sourceMessageId,randomId,keyboard}) {
    const to=Number(peerId),from=Number(sourcePeerId),cmid=Number(sourceCmid||0),id=Number(sourceMessageId||0);
    if(!Number.isSafeInteger(to)||to<2000000000||from!==to||(!Number.isSafeInteger(cmid)||cmid<=0)&&(!Number.isSafeInteger(id)||id<=0))
        throw new Error('VK forward needs an exact source in the same conversation');
    return {peer_id:to,random_id:Number(randomId),message:'🔔 Напоминание — пересылаю исходное сообщение:',
        forward:JSON.stringify({peer_id:from,...(cmid>0?{conversation_message_ids:[cmid]}:{message_ids:[id]}),is_reply:false}),
        ...(keyboard?{keyboard}:{})};
}