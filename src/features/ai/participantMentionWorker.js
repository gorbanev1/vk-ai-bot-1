import { parentPort, workerData } from 'node:worker_threads';
import { createParticipantMentionMatcher } from './participantQuestionRouting.js';

// No database/application imports: workers must not run migrations or start bots.
const matchMessage = createParticipantMentionMatcher(
    workerData.participant, workerData.matchedPhrase, workerData.options,
);
parentPort.on('message', ({messages}) => {
    const matches = [];
    for (const message of messages) {
        const match = matchMessage(message);
        if (match) {
            const {message: source, ...details} = match;
            matches.push({index: source.index, ...details});
        }
    }
    parentPort.postMessage({type: 'batch', scanned: messages.length, matches});
});
parentPort.postMessage({type: 'ready'});
