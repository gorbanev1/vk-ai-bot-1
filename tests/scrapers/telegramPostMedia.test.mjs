import test from 'node:test';
import assert from 'node:assert/strict';
import {
    inspectTelegramPublicPostMedia,
    parseTelegramVideoDuration,
    enrichTelegramPostsWithPublicEmbed,
} from '../../src/platforms/telegram/telegramPostMedia.js';

test('video /515: duration and preview only, not photo or downloaded video', () => {
    const block = '<div class="tgme_widget_message_video_player"><a class="tgme_widget_message_video_thumb" style="background-image:url(https://cdn.example/cover.jpg)"></a><span class="tgme_widget_message_video_duration">0:20</span></div>';
    assert.deepEqual(inspectTelegramPublicPostMedia(block), {
        mediaType: 'video', hasVideo: true, hasPhoto: false,
        videoPreviewAvailable: true, videoDurationSeconds: 20,
        videoAccess: 'preview-only', videoUrls: [], mediaUnavailableReason: '',
    });
});

test('photo, text, mixed media and video without preview remain distinct', () => {
    assert.equal(inspectTelegramPublicPostMedia('<a class="tgme_widget_message_photo_wrap"></a>').mediaType, 'photo');
    assert.equal(inspectTelegramPublicPostMedia('<div>video 0:20</div>').hasVideo, false);
    assert.equal(inspectTelegramPublicPostMedia('<img src="https://example.org/avatar.jpg">').mediaType, 'unknown');
    const mixed = inspectTelegramPublicPostMedia('<a class="tgme_widget_message_photo_wrap"></a><div class="tgme_widget_message_video_thumb"></div>');
    assert.equal(mixed.mediaType, 'mixed');
    assert.equal(inspectTelegramPublicPostMedia('<div class="tgme_widget_message_video_player"></div>').videoAccess, 'video-detected-unavailable');
    assert.equal(inspectTelegramPublicPostMedia('<video src="https://example.org/clip.mp4"></video>').videoAccess, 'direct-url-visible');
});

test('duration parsing is strict', () => {
    assert.equal(parseTelegramVideoDuration('0:20'), 20);
    assert.equal(parseTelegramVideoDuration('01:02:03'), 3723);
    assert.equal(parseTelegramVideoDuration('12:34'), 754);
    assert.equal(parseTelegramVideoDuration('unknown'), null);
});

test('single-post embed recovery preserves text and cannot affect another post', async () => {
    const posts = [{ channel: 'nnrravew', messageId: 515, text: 'NO NAME RAVE', publishedAt: 123, imageUrls: [], hasVideo: true, videoAccess: 'video-detected-unavailable' }];
    let calls = 0;
    await enrichTelegramPostsWithPublicEmbed(posts, {
        isEventCandidate: () => true,
        fetchEmbedHtml: async () => { calls += 1; return 'embed'; },
        parsePosts: () => [{ channel: 'nnrravew', messageId: 515, text: 'wrong text', imageUrls: ['https://example.org/thumb.jpg'], hasVideo: true, hasPhoto: false, mediaType: 'video', videoAccess: 'preview-only', videoPreviewAvailable: true, videoDurationSeconds: 20 }],
    });
    assert.equal(calls, 1);
    assert.equal(posts[0].text, 'NO NAME RAVE');
    assert.equal(posts[0].publishedAt, 123);
    assert.equal(posts[0].videoDurationSeconds, 20);
    assert.equal(posts[0].imageUrls.length, 1);
    assert.equal(posts[0].mediaReviewStatus, 'public-embed-checked');
});

test('no matching post cannot introduce foreign attachments; bounded and failure tolerant', async () => {
    const posts = Array.from({ length: 6 }, (_, i) => ({ channel: 'nnrravew', messageId: 515 + i, imageUrls: [], text: 'show', hasVideo: true }));
    let count = 0;
    await enrichTelegramPostsWithPublicEmbed(posts, {
        isEventCandidate: () => true,
        fetchEmbedHtml: async () => { count += 1; throw new Error('offline'); },
        parsePosts: () => [],
    });
    assert.equal(count, 2);
    assert.equal(posts[0].mediaReviewStatus, 'public-embed-failed');
    assert.equal(posts[2].mediaReviewStatus, undefined);
});

test('real Telegram Embed structure: video tag, actual duration class and cover', () => {
    // Structure verified against the public /nnrravew/515 embed on 2026-11-01.
    // CDN URLs are intentionally synthetic; no expiring Telegram tokens saved.
    const block = [
        '<div class="tgme_widget_message js-widget_message" data-post="nnrravew/515">',
        '<a class="tgme_widget_message_video_player" href="https://t.me/nnrravew/515">',
        '<i class="tgme_widget_message_video_thumb" style="background-image:url(',
        "'https://example.org/frame.jpg'",
        ')"></i>',
        '<div class="tgme_widget_message_video_wrap"><video src="https://example.org/clip.mp4" class="tgme_widget_message_video"></video></div>',
        '<time class="message_video_duration js-message_video_duration">0:20</time>',
        '<div class="tgme_widget_message_text">NO NAME RAVE</div></a></div>',
    ].join('');
    const media = inspectTelegramPublicPostMedia(block);
    assert.equal(media.hasVideo, true);
    assert.equal(media.mediaType, 'video');
    assert.equal(media.videoDurationSeconds, 20);
    assert.equal(media.videoPreviewAvailable, true);
    assert.equal(media.videoAccess, 'direct-url-visible');
});

test('embed upgrades preview-only video without losing existing media evidence', async () => {
    const post = { channel: 'nnrravew', messageId: 515, text: 'NO NAME RAVE',
        imageUrls: ['https://example.org/cover.jpg'], hasVideo: true,
        hasPhoto: false, mediaType: 'video', videoAccess: 'preview-only',
        videoPreviewAvailable: true, videoDurationSeconds: null };
    let attempts = 0;
    await enrichTelegramPostsWithPublicEmbed([post], {
        isEventCandidate: () => true,
        fetchEmbedHtml: async () => { attempts += 1; return 'embed'; },
        parsePosts: () => [{ channel: 'nnrravew', messageId: 515, imageUrls: [],
            hasVideo: true, hasPhoto: false, mediaType: 'video',
            videoAccess: 'direct-url-visible', videoPreviewAvailable: false,
            videoDurationSeconds: 20 }],
    });
    assert.equal(attempts, 1);
    assert.equal(post.videoAccess, 'direct-url-visible');
    assert.equal(post.videoDurationSeconds, 20);
    assert.equal(post.videoPreviewAvailable, true);
    assert.deepEqual(post.imageUrls, ['https://example.org/cover.jpg']);
    assert.equal(post.text, 'NO NAME RAVE');
});
