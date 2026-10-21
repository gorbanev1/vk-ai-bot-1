from pathlib import Path
r=Path(__file__).parent
p=r/'src/app/botApplication.js'
s=p.read_text(encoding='utf-8')
s=s.replace('    saveOperationCheckpoint,','    saveOperationCheckpoint as persistOperationCheckpoint,',1)
a=s.index('// Read the newest interrupted parser-all checkpoint')
b=s.index('async function addOwnerManualScraperSource',a)
s=s[:a]+s[b:]
s=s.replace('let parserAllRecoveryContext = null;','')
s=s.replace("import { BOT_PATCH_VERSION }", "import { loadLatestParserAllRecovery, mergeParserAllCheckpoint, buildParserRecoveryNotice, dismissParserAllRecovery, parserRecoveryCommand } from '../features/scrapers/parserAllRecovery.js';\nimport { BOT_PATCH_VERSION }",1)
pos=s.index('function runDetachedSupervisedOperation(')
s=s[:pos]+'''function saveOperationCheckpoint(checkpoint, options) {
    const operation = getCurrentOperation();
    return persistOperationCheckpoint(/^parser-all(?:$|[:-])/u.test(operation?.name || '')
        ? mergeParserAllCheckpoint(operation.checkpoint, checkpoint) : checkpoint, options);
}

async function notifyParserRecovery(recovery) {
    if (!recovery || recovery.reason === 'superseded' || !telegramBotStarted || !telegramOwnerExternalUserId) return false;
    if (existsSync(recovery.noticePath)) return false;
    const notice = buildParserRecoveryNotice(recovery);
    await telegramBot.api.sendMessage({ chatId: telegramOwnerExternalUserId, text: notice.text, replyMarkup: notice.replyMarkup });
    writeFileSync(recovery.noticePath, new Date().toISOString(), 'utf8');
    return true;
}

''' + s[pos:]
s=s.replace('''    const promise = runSupervisedOperation({
        name,
        category,
        metadata,
        timeoutMs,
    }, task);''','''    let operationId = '';
    const promise = runSupervisedOperation({
        name,
        category,
        metadata,
        timeoutMs,
    }, (operation) => {
        operationId = operation.id;
        return task(operation);
    });
    if (/^parser-all(?:$|[:-])/u.test(name || '')) {
        const notify = () => notifyParserRecovery(loadLatestParserAllRecovery({
            partyPool: metadata.partyPool || PARTY_POOL_PRIMARY, expectedId: operationId,
        })).catch((error) => console.warn('[PARSER RECOVERY NOTICE FAILED]', formatPrivateError(error)));
        void promise.then(notify, notify).catch((error) => console.warn('[PARSER RECOVERY LOOKUP FAILED]', formatPrivateError(error)));
    }''',1)
s=s.replace('Автоматически продолжать их пока нельзя; сохранённый checkpoint оставлен для разбора.', 'Сохранённые checkpoint проверены; для доступного кэша парсера отправлено отдельное предложение продолжить.')
s=s.replace("if (reason === 'startup' && interruptedOperationsFromPriorRun.length)", "if (interruptedOperationsFromPriorRun.length)",1)
pos=s.index('                if (interruptedOperationsFromPriorRun.length)')
s=s[:pos]+'''                for (const partyPool of [PARTY_POOL_PRIMARY, PARTY_POOL_SECONDARY]) {
                    try {
                        const recovery = loadLatestParserAllRecovery({ partyPool });
                        if (recovery && !listActiveOperations().some((operation) => operation.id === recovery.id)) {
                            await notifyParserRecovery(recovery);
                        }
                    } catch (error) {
                        console.warn('[PARSER STARTUP RECOVERY NOTICE FAILED]', formatPrivateError(error));
                    }
                }
''' + s[pos:]
s=s.replace('async function startAllManualScraperSources({ incrementalOnly = false, partyPool = PARTY_POOL_PRIMARY } = {}) {\n    const recovery = parserAllRecoveryContext;', 'async function startAllManualScraperSources({ incrementalOnly = false, partyPool = PARTY_POOL_PRIMARY, recovery = null } = {}) {')
s=s.replace('    const sources = getManualScraperSources(normalizedPool);\n\n    if (!sources.length)', '''    const configuredSources = getManualScraperSources(normalizedPool);
    const sources = recovery?.sourceIds?.length
        ? configuredSources.filter((source) => recovery.sourceIds.includes(source.id)) : configuredSources;

    if (!sources.length)''',1)
s=s.replace('    cachedItems = null,\n} = {}) {\n    const normalizedPool', '    cachedItems = null,\n    resumeCompletedSince = 0,\n} = {}) {\n    const normalizedPool',1)
a=s.index('async function startManualScraperSource(')
b=s.index('async function pinFailedScraperSourceForOwner',a)
part=s[a:b].replace('cachedItems,\n','cachedItems,\n        resumeCompletedSince,\n')
s=s[:a]+part+s[b:]
s=s.replace("        const isVkBrowserSource = source.kind === 'vk-chat' || source.kind === 'vk-public';", "        const isVkBrowserSource = !recovery?.cacheRows?.has(source.id) && (source.kind === 'vk-chat' || source.kind === 'vk-public');",1)
s=s.replace('                cachedItems: recovery?.cacheRows?.get(source.id)?.items || null,','''                cachedItems: recovery?.cacheRows?.get(source.id)?.items || null,
                resumeCompletedSince: recovery && !recovery.originalIncrementalOnly
                    ? Math.floor(Date.parse(recovery.startedAt) / 1000) : 0,''',1)
needle='    const expectedSourceCount = normalizedPool === PARTY_POOL_PRIMARY ? 16 : null;'
s=s.replace(needle,'''    saveOperationCheckpoint({
        kind: 'parser-all', phase: 'parser-capture', partyPool: normalizedPool,
        sourceIds: sources.map((source) => source.id), tracePath: diagnostics.relativeLogPath,
        recoveryStartedAt: recovery?.startedAt || getCurrentOperation()?.startedAt,
        recoveryIncrementalOnly: recovery?.originalIncrementalOnly ?? incrementalOnly,
        captures: recovery ? [...recovery.cacheRows].map(([sourceId, row]) => ({ sourceId, cachePath: row.path, itemCount: row.itemCount })) : [],
    }, { event: 'parser.checkpoint.manifest' });
''' + needle,1)
s=s.replace("            ...captureProgress,\n        }, { event: 'parser.checkpoint.capture-progress' });", "            ...captureProgress,\n            captures: [...captureState.values()].map(({ sourceId, cachePath, itemCount, error }) => ({ sourceId, cachePath, itemCount, error })),\n        }, { event: 'parser.checkpoint.capture-progress' });",1)
s=s.replace('async function handleManualScraperCommand(context, requestText) {', "async function handleManualScraperCommand(context, requestText, { recoveryCheckpointId = '' } = {}) {",1)
s=s.replace('        const recovery = command.recover ? loadLatestParserAllRecovery() : null;','''        const activeParser = listActiveOperations().find((operation) => operation.category === 'parser');
        if (activeParser) {
            await context.send(`⚠️ Парсер уже работает: ${activeParser.id}. Статус: «процессы». Дождись завершения или останови его перед восстановлением.`);
            return true;
        }
        const recovery = command.recover ? loadLatestParserAllRecovery({ partyPool: commandPartyPool, expectedId: recoveryCheckpointId }) : null;
        if (recovery?.reason === 'superseded') {
            await context.send('Эта кнопка относится к старому запуску. Его заменил более новый «парсер все».');
            return true;
        }
        if (recovery && !recovery.available) {
            await context.send(buildParserRecoveryNotice(recovery).text);
            return true;
        }''',1)
s=s.replace('Незавершённого parser-all checkpoint с доступным кэшем не найдено. Запусти «парсер все» заново.', 'Последний запуск завершён, продолжение отклонено или checkpoint отсутствует. Старые запуски не возобновляются. Для нового прохода: «парсер все».',1)
s=s.replace('''            cleanOnly
                ? `Запускаю «парсер все чисто»''','''            command.recover ? `▶️ Продолжаю парсер с сохранённого кэша (${effectivePartyPool}).` : cleanOnly
                ? `Запускаю «парсер все чисто»''',1)
s=s.replace('                parserAllRecoveryContext = recovery;\n                run = await startAllManualScraperSources({ incrementalOnly: cleanOnly, partyPool: effectivePartyPool });\n                parserAllRecoveryContext = null;', '                run = await startAllManualScraperSources({ incrementalOnly: cleanOnly, partyPool: effectivePartyPool, recovery });',1)
s=s.replace('                parserAllRecoveryContext = null;\n','')
a=s.index('    if (command.all) {'); b=s.index('    if (!command.sourceId)',a)
part=s[a:b].replace('partyPool: commandPartyPool,','partyPool: effectivePartyPool,')
part=part.replace('loadLatestParserAllRecovery({ partyPool: effectivePartyPool,', 'loadLatestParserAllRecovery({ partyPool: commandPartyPool,')
s=s[:a]+part+s[b:]
s=s.replace("                    'Кэш уже обработанных источников сохранён. Для бесшовного продолжения выполни: «парсер все восстановить».',", "                    'Сохранённый checkpoint проверяется. Возможность продолжения и состояние кэша придут отдельным сообщением.',",1)
s=s.replace("                kind: 'parser-all-clean',\n                phase: 'completed',\n                partyPool,", "                kind: 'parser-all-clean',\n                phase: processingSummary?.ok === true && !pending.length ? 'completed' : 'completed-with-warnings',\n                partyPool,",1)
pos=s.index('    const confirm = data.match(/^event_delete',s.index('async function handleTelegramEventCardCallbackUpdate'))
s=s[:pos]+'''    const parserRecovery = data.match(/^parser_(resume|keep):([a-z0-9-]+)$/u);
    if (parserRecovery) {
        if (!isOwnerContext(context) || !isPrivateContext(context)) {
            await context.answerCallbackQuery({ text: 'Только владелец в личном чате.', showAlert: true }).catch(() => {});
            return true;
        }
        await context.answerCallbackQuery().catch(() => {});
        const recovery = [PARTY_POOL_PRIMARY, PARTY_POOL_SECONDARY]
            .map((partyPool) => loadLatestParserAllRecovery({ partyPool, expectedId: parserRecovery[2] }))
            .find((entry) => entry?.id === parserRecovery[2] && entry.reason !== 'superseded');
        if (!recovery) {
            await context.send('Этот запуск уже завершён, заменён новым или его продолжение отклонено.');
            return true;
        }
        if (parserRecovery[1] === 'keep') {
            dismissParserAllRecovery(recovery);
            await context.send('Оставляю сохранённый результат. Этот запуск больше не предлагается к восстановлению.');
            return true;
        }
        return handleManualScraperCommand(context, parserRecoveryCommand(recovery.partyPool), { recoveryCheckpointId: recovery.id });
    }
''' + s[pos:]
s=s.replace("        '• тусы источники восстановить", "        '• парсер все восстановить — продолжить последний незавершённый проход из кэша; готовые записи не повторяются. Для второго пула: «тусы второстепенные парсер все восстановить».',\n        '• тусы источники восстановить",1)
p.write_text(s,encoding='utf-8',newline='')
p=r/'src/features/scrapers/scraperCommandRouting.js'; s=p.read_text(encoding='utf-8')
s=s.replace('        const all = cleanOnly || /', '        const recover = /^(?:все|all)\\s+(?:восстановить|resume)$/u.test(tail);\n        const all = cleanOnly || recover || /',1)
s=s.replace('            cleanOnly,\n            help:', '            cleanOnly: cleanOnly || recover,\n            recover,\n            help:',1); p.write_text(s,encoding='utf-8',newline='')
p=r/'tests/scrapers/scraperCommandRouting.test.mjs'; s=p.read_text(encoding='utf-8'); s=s.replace('partyPool = PARTY_POOL_PRIMARY \\}', 'partyPool = PARTY_POOL_PRIMARY, recovery = null \\}'); p.write_text(s,encoding='utf-8',newline='')
p=r/'src/features/scrapers/manualParserCleanSkip.js'; s=p.read_text(encoding='utf-8'); s=s.replace('    incrementalOnly,','    incrementalOnly,\n    resumeCompletedSince = 0,',1); s=s.replace('    if (previous && isFinalStatus', '    if (Number(resumeCompletedSince) > 0 && Number(previous?.processedAt || 0) < Number(resumeCompletedSince)) return false;\n    if (previous && isFinalStatus',1); p.write_text(s,encoding='utf-8',newline='')
for name in ['vk/vkPublicScraper.js','telegram/telegramHtmlScraper.js','vk/vkChatEventScraper.js']:
    p=r/'src/platforms'/name; s=p.read_text(encoding='utf-8'); s=s.replace('        cachedItems = null,','        cachedItems = null,\n        resumeCompletedSince = 0,',1)
    if name.endswith('vkChatEventScraper.js'):
        s=s.replace('                    ledgerBefore.contentHash && ledgerBefore.contentHash === rawContentHash', '                    ledgerBefore.contentHash && ledgerBefore.contentHash === rawContentHash &&\n                    (!resumeCompletedSince || Number(ledgerBefore.processedAt || 0) >= resumeCompletedSince)',1)
        s=s.replace("                if (typeof hydrateMessageEvidence === 'function' &&\n                    (message.hasRepostEvidence", "                if (!Array.isArray(cachedItems) && typeof hydrateMessageEvidence === 'function' &&\n                    (message.hasRepostEvidence",1)
    else:
        s=s.replace('                    incrementalOnly,\n                    previous: ledgerBefore,','                    incrementalOnly,\n                    resumeCompletedSince,\n                    previous: ledgerBefore,',1)
    p.write_text(s,encoding='utf-8',newline='')
