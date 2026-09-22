import assert from 'node:assert/strict';
import test from 'node:test';

import {
    selectEventPagePostCandidates,
} from '../../src/features/events/eventPageCandidateSelection.js';

function post(index, text) {
    return { index, id: `p${index}`, text, imageUrls: [] };
}

test('V130 automatic page candidate selection is hard capped at 20 posts', () => {
    const posts = Array.from({ length: 80 }, (_, index) => post(
        index,
        `${index + 1} сентября 2026 концерт группа ${index} билеты вход`,
    ));
    const selected = selectEventPagePostCandidates(posts, { maximum: 200, minimumScore: 1 });
    assert.equal(selected.length, 20);
});

test('V130 hint boosts the most similar event post', () => {
    const posts = [
        post(0, '5 сентября 2026 концерт Sand N Roll Караван Сарай Кьюоск DIESEL HALL'),
        post(1, '6 сентября 2026 концерт другая группа в другом клубе'),
        post(2, '7 сентября 2026 концерт третья группа'),
    ];
    const selected = selectEventPagePostCandidates(posts, {
        hint: 'Sand N Roll Караван Сарай',
        maximum: 20,
        minimumScore: 1,
    });
    assert.equal(selected[0].id, 'p0');
});
