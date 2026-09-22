import assert from 'node:assert/strict';

import {
    extractVkMessageContent,
    resolveVkMessageContent,
} from '../../src/platforms/vk/vkMessageContent.js';

const embeddedComment = extractVkMessageContent({
    text: '',
    attachments: [{
        type: 'wall_reply',
        wall_reply: {
            id: 1444,
            owner_id: -777,
            post_id: 88,
            from_id: 42,
            text: 'Ирина, работа есть. Только тебя она не устраивает.',
            attachments: [{
                type: 'link',
                link: {
                    title: 'Вакансия',
                    description: 'Описание вакансии',
                    url: 'https://example.com/job',
                },
            }],
        },
    }],
});

assert.equal(embeddedComment.directText, '');
assert.match(embeddedComment.text, /Комментарий к посту VK/u);
assert.match(
    embeddedComment.text,
    /Ирина, работа есть\. Только тебя она не устраивает\./u,
);
assert.match(embeddedComment.text, /Индекс автора комментария: 42/u);
assert.match(embeddedComment.text, /https:\/\/vk\.com\/wall-777_88\?reply=1444/u);
assert.match(embeddedComment.text, /Описание вакансии/u);
assert.match(embeddedComment.attachmentSummary, /type=wall_reply/u);
assert.equal(embeddedComment.unresolvedWallReplies.length, 0);

const repost = extractVkMessageContent({
    attachments: [{
        type: 'wall',
        wall: {
            owner_id: -1,
            id: 5,
            text: 'Новый текст поста',
            copy_history: [{
                owner_id: -2,
                id: 9,
                text: 'Исходный текст репоста',
            }],
        },
    }],
});

assert.match(repost.text, /Новый текст поста/u);
assert.match(repost.text, /Исходный текст репоста/u);

let deepWall = {
    owner_id: -9000,
    id: 9000,
    text: 'Самый глубокий исходный пост',
};
for (let level = 12; level >= 1; level -= 1) {
    deepWall = {
        owner_id: -(8000 + level),
        id: 8000 + level,
        text: `Репостный уровень ${level}`,
        copy_history: [deepWall],
    };
}
const deepRepost = extractVkMessageContent({
    attachments: [{ type: 'wall', wall: deepWall }],
});
assert.match(deepRepost.text, /\[Репост VK, уровень 12\]/u);
assert.match(deepRepost.text, /Самый глубокий исходный пост/u);

const forwarded = extractVkMessageContent({
    text: '',
    fwd_messages: [{
        text: '',
        attachments: [{
            type: 'wall_reply',
            wall_reply: {
                id: 91,
                owner_id: -10,
                post_id: 20,
                from_id: 55,
                text: 'Комментарий внутри пересланного сообщения',
            },
        }],
    }],
});

assert.match(
    forwarded.text,
    /Комментарий внутри пересланного сообщения/u,
);

let getCommentCalls = 0;
const hydrated = await resolveVkMessageContent({
    text: '',
    attachments: [{
        type: 'wall_reply',
        wall_reply: {
            id: 777,
            owner_id: -900,
            post_id: 12,
            text: '',
        },
    }],
}, {
    vkApi: {
        wall: {
            async getComment(params) {
                getCommentCalls += 1;
                assert.equal(params.owner_id, -900);
                assert.equal(params.comment_id, 777);
                assert.equal(params.extended, 1);

                return {
                    items: [{
                        id: 777,
                        from_id: 321,
                        text: 'Текст догруженного комментария',
                    }],
                    profiles: [{
                        id: 321,
                        first_name: 'Иван',
                        last_name: 'Петров',
                    }],
                };
            },
        },
    },
});

assert.equal(getCommentCalls, 1);
assert.match(hydrated.text, /Текст догруженного комментария/u);
assert.match(hydrated.text, /Автор комментария: Иван Петров/u);
assert.match(hydrated.text, /Индекс автора комментария: 321/u);

let reportedError = null;
const unavailable = await resolveVkMessageContent({
    attachments: [{
        type: 'wall_reply',
        wall_reply: {
            id: 778,
            owner_id: -900,
            post_id: 12,
        },
    }],
}, {
    vkApi: {
        wall: {
            async getComment() {
                throw new Error('access denied');
            },
        },
    },
    onError(error, descriptor) {
        reportedError = { error, descriptor };
    },
});

assert.equal(unavailable.text, '');
assert.equal(reportedError.error.message, 'access denied');
assert.equal(reportedError.descriptor.commentId, 778);

const classLikeAttachment = extractVkMessageContent({
    attachments: [{
        toJSON() {
            return {
                type: 'wall_reply',
                wall_reply: {
                    id: 101,
                    owner_id: -4,
                    post_id: 8,
                    text: 'Текст из toJSON attachment-класса',
                },
            };
        },
    }],
});

assert.match(classLikeAttachment.text, /Текст из toJSON attachment-класса/u);

console.log('vkMessageContent tests: OK');

const deepest = (await import('../../src/platforms/vk/vkMessageContent.js')).extractDeepestVkAttachmentContent({
    text: 'внешняя подпись',
    attachments: [{
        type: 'wall',
        wall: {
            owner_id: -1,
            id: 1,
            text: 'внешний репост с пояснением',
            copy_history: [{
                owner_id: -2,
                id: 2,
                text: 'средний уровень репоста с содержательным текстом',
                copy_history: [{
                    owner_id: -3,
                    id: 3,
                    text: 'САМЫЙ НИЖНИЙ ИСХОДНЫЙ ПОСТ: именно его надо резюмировать, а не чат вокруг него.',
                }],
            }],
        },
    }],
});
assert.equal(deepest.depth, 3);
assert.match(deepest.text, /САМЫЙ НИЖНИЙ ИСХОДНЫЙ ПОСТ/u);
assert.doesNotMatch(deepest.text, /внешняя подпись/u);
assert.doesNotMatch(deepest.text, /средний уровень/u);

const { resolveDeepestVkAttachmentContent } = await import('../../src/platforms/vk/vkMessageContent.js');
let deepHydrateCalls = 0;
const hydratedDeepest = await resolveDeepestVkAttachmentContent({
    attachments: [{ type: 'wall', wall: { owner_id: -10, id: 20, text: 'короткий внешний контейнер' } }],
}, {
    vkApi: {
        wall: {
            async getById({ posts }) {
                deepHydrateCalls += 1;
                assert.equal(posts, '-10_20');
                return { items: [{
                    owner_id: -10,
                    id: 20,
                    text: 'внешний пост после гидратации',
                    copy_history: [{ owner_id: -11, id: 21, text: 'ГЛУБОКИЙ ГИДРАТИРОВАННЫЙ ПОСТ, который должен получить summarizer вместо истории чата.' }],
                }] };
            },
        },
    },
});
assert.equal(deepHydrateCalls, 1);
assert.match(hydratedDeepest.text, /ГЛУБОКИЙ ГИДРАТИРОВАННЫЙ ПОСТ/u);
