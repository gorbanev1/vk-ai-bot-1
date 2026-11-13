import { createHash } from 'node:crypto';

// Reusing a VK random_id for the same logical part prevents duplicate delivery
// when an API acknowledgement is lost or a publication is retried.
export function chtivoPartRandomId(peerId, bookId, chapterOrder, partNumber) {
    const key = ['chtivo-part-v1', peerId, bookId, chapterOrder, partNumber].join(':');
    const unsigned = createHash('sha256').update(key).digest().readUInt32BE(0);
    return (unsigned & 0x7fffffff) || 1;
}
