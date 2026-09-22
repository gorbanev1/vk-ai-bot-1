import test from 'node:test';
import assert from 'node:assert/strict';
import { createVkPublicCaptureHash, vkPublicCapturePayload } from '../../src/features/events/vkPublicContentHash.js';
const post = { text:'Фестиваль 21 сентября', sourceUrl:'https://vk.ru/wall-10_20',publishedAt:1,
    imageUrls:['https://cdn.test/signed.jpg?token=old'],
    imageMedia:[{url:'https://cdn.test/signed.jpg?token=old',attachmentKey:'photo-10_12'}],
    links:[],repostUrls:[],eventLinks:[] };
test('post identity, source and verified poster identity affect the fingerprint', () => {
    const base=createVkPublicCaptureHash(post);
    assert.notEqual(createVkPublicCaptureHash({...post,text:'Фестиваль 22 сентября'}),base);
    assert.notEqual(createVkPublicCaptureHash({...post,sourceUrl:'https://vk.ru/wall-10_21'}),base);
    assert.notEqual(createVkPublicCaptureHash({...post,imageMedia:[{...post.imageMedia[0],attachmentKey:'photo-10_13'}]}),base);
    assert.equal(vkPublicCapturePayload(post).sourceUrl,post.sourceUrl);
});
test('renewed URL for the same identified VK photo is not a different poster', () => {
    const newer={...post,imageMedia:[{...post.imageMedia[0],url:'https://cdn.test/new-signature.jpg'}],
      imageUrls:['https://cdn.test/new-signature.jpg']};
    assert.equal(createVkPublicCaptureHash(newer),createVkPublicCaptureHash(post));
});
