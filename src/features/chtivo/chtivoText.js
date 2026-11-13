export function normalizeChtivoText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

const SENTENCE_END = /[.!?…][»”')\]]*\s+/gu;

function lastSentenceBoundary(text, maxEnd) {
  const pattern = new RegExp(SENTENCE_END.source, 'gu');
  let boundary = -1;
  for (const match of text.matchAll(pattern)) {
    const end = match.index + match[0].length;
    if (end > maxEnd) break;
    boundary = end;
  }
  return boundary;
}

function splitOversizedParagraph(paragraph, max) {
  const parts = [];
  let rest = paragraph;
  while (rest.length > max) {
    let sentenceEnd = lastSentenceBoundary(rest, max);
    // A short standalone heading such as "Утро." is not a meaningful
    // sentence boundary. Keep it with the first prose sentence.
    if (sentenceEnd > 0 && rest.slice(0, sentenceEnd).trim().split(/\s+/u).length <= 7) sentenceEnd = -1;
    if (sentenceEnd > 0) {
      parts.push(rest.slice(0, sentenceEnd));
      rest = rest.slice(sentenceEnd);
      continue;
    }
    // A single sentence can exceed VK hard limit. Split at a word boundary;
    // never cut a word or surrogate pair.
    let end = rest.lastIndexOf(' ', max);
    if (end <= 0) end = max;
    else end += 1;
    if (end > 0 && end < rest.length && /[\uD800-\uDBFF]/u.test(rest[end - 1]) && /[\uDC00-\uDFFF]/u.test(rest[end])) end -= 1;
    parts.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest) parts.push(rest);
  return parts;
}

// Fill each VK message with whole paragraphs whenever possible. The 4096
// transport ceiling remains absolute, even when semantic chunks are longer.
export function splitChtivoBody(text, target = 3932, hardMax = target) {
  const source = normalizeChtivoText(text);
  if (!source) return [];
  const paragraphs = [];
  const boundary = /\n[ \t]*\n+/gu;
  let start = 0;
  for (const match of source.matchAll(boundary)) {
    const end = match.index + match[0].length;
    paragraphs.push({ text: source.slice(start, match.index), separator: match[0] });
    start = end;
  }
  if (start < source.length) paragraphs.push({ text: source.slice(start), separator: '' });
  if (!paragraphs.length) paragraphs.push({ text: source, separator: '' });

  const isHeading = paragraph => {
    const value = paragraph.trim();
    return value.length > 0 && value.length <= 100 && !value.includes('\n')
      && (/^[А-ЯЁ0-9 .—–-]+$/u.test(value) || value.split(/\s+/u).length <= 7);
  };
  const blocks = [];
  for (let index = 0; index < paragraphs.length;) {
    let block = paragraphs[index].text + paragraphs[index].separator;
    let next = index + 1;
    // Keep a heading with the next substantive paragraph. Do not repeatedly
    // inspect the first heading: that would absorb the entire remainder when
    // several short paragraphs happen to look like headings.
    if (isHeading(paragraphs[index].text)) {
      while (next < paragraphs.length && isHeading(paragraphs[next].text)) {
        block += paragraphs[next].text + paragraphs[next].separator;
        next += 1;
      }
      if (next < paragraphs.length) {
        block += paragraphs[next].text + paragraphs[next].separator;
        next += 1;
      }
    }
    blocks.push(block);
    index = next;
  }

  const chunks = [];
  let current = '';
  const flush = () => {
    if (current) chunks.push(current);
    current = '';
  };
  const appendSentenceChunks = block => {
    const sentences = [];
    let offset = 0;
    const pattern = new RegExp(SENTENCE_END.source, 'gu');
    for (const match of block.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (end > offset) sentences.push(block.slice(offset, end));
      offset = end;
    }
    if (offset < block.length) sentences.push(block.slice(offset));
    if (!sentences.length) sentences.push(block);
    for (const sentence of sentences) {
      if (sentence.length > hardMax) {
        flush();
        const pieces = splitOversizedParagraph(sentence, hardMax);
        chunks.push(...pieces.slice(0, -1));
        current = pieces.at(-1) || '';
        continue;
      }
      const candidate = current + sentence;
      if (candidate.length <= target || (current.length === 0 && candidate.length <= hardMax)) current = candidate;
      else { flush(); current = sentence; }
    }
  };

  for (const block of blocks) {
    if (block.length <= hardMax) {
      const candidate = current + block;
      if (candidate.length <= target || (current.length === 0 && block.length <= hardMax)) current = candidate;
      else if (current && candidate.length <= hardMax) { current = candidate; flush(); }
      else { flush(); current = block; }
      continue;
    }
    appendSentenceChunks(block);
  }
  flush();
  return chunks;
}

export function splitChtivoChapters(text) {
  const source = normalizeChtivoText(text);
  if (!source) return [];
  const sections = [];
  let title = 'Вводная часть';
  let body = [];
  const flush = () => {
    const value = normalizeChtivoText(body.join('\n'));
    if (value || title !== 'Вводная часть') sections.push({ title, body: value });
    body = [];
  };
  for (const line of source.split('\n')) {
    const marker = line.match(/^\[\[ГЛАВА:\s*(.+?)\]\]$/iu);
    if (marker) { flush(); title = marker[1].trim(); }
    else body.push(line);
  }
  flush();
  if (!sections.length) return [{ title: 'Текст книги', body: source }];

  const contentOf = section => section.body;
  const subsectionOf = section => `${section.title}\n\n${section.body}`.trim();
  const chapters = [];
  let index = 0;
  while (index < sections.length) {
    const current = sections[index];
    if (current.title === 'Вводная часть' && sections[index + 1]) {
      sections[index + 1].body = `${current.body}\n\n${contentOf(sections[index + 1])}`.trim();
      index += 1;
      continue;
    }
    let chapterTitle = current.title;
    let chapterBody = contentOf(current);
    let next = index + 1;
    // «Марафон» is a parent section; its «День ...» headings are
    // subsections and must remain in the same chapter.
    if (/^марафон$/iu.test(current.title)) {
      while (next < sections.length && /^марафон\s*\./iu.test(sections[next].title)) {
        chapterBody = `${chapterBody}\n\n${subsectionOf(sections[next])}`.trim();
        next += 1;
      }
    }
    // Standalone «Заморочка N» markers are headings for the following
    // substantive section, not publishable chapters.
    if (/^заморочка\s*[0-9]+$/iu.test(current.title) && next < sections.length) {
      chapterTitle = `${current.title} — ${sections[next].title}`;
      chapterBody = `${chapterBody}\n\n${subsectionOf(sections[next])}`.trim();
      next += 1;
    }
    // Any remaining tiny marker is folded into the next section. This is a
    // guard for books whose converter emitted a heading-only marker.
    while (next < sections.length && current.body.length < 200 && !/^марафон$/iu.test(current.title)) {
      chapterBody = `${chapterBody}\n\n${subsectionOf(sections[next])}`.trim();
      next += 1;
      break;
    }
    chapters.push({ title: chapterTitle, body: chapterBody });
    index = next;
  }
  return chapters.filter(chapter => chapter.body);
}

// Catalog numbers are assigned only to the rows currently shown to a user.
// Database ids and historical catalog_no values must never create gaps.
export function renumberChtivoBooks(books) {
  return (Array.isArray(books) ? books : []).map((book, index) => ({
    ...book,
    catalog_no: index + 1,
  }));
}

export function filterChtivoTextBooks(books, currentTextPaths) {
  const normalizePath = value => String(value || '').replace(/\\/g, '/').toLowerCase();
  const available = new Set(Array.from(currentTextPaths || [], normalizePath));
  return (Array.isArray(books) ? books : []).filter(book =>
    /\.txt$/iu.test(String(book?.path || '')) && available.has(normalizePath(book.path)));
}

function normalizeBookQuery(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/^[\s\d.)-]+/u, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function editDistance(left, right, limit = 2) {
  const a = String(left || '');
  const b = String(right || '');
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const value = a[i - 1] === b[j - 1]
        ? previous[j - 1]
        : Math.min(previous[j - 1], previous[j], current[j - 1]) + 1;
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

export function matchChtivoBookQuery(books, value) {
  const query = normalizeBookQuery(value);
  if (!query) return null;
  const hits = (Array.isArray(books) ? books : []).filter(book => {
    const title = normalizeBookQuery(book?.title);
    const author = normalizeBookQuery(book?.author);
    const display = normalizeBookQuery(`${book?.title || ''} ${book?.author || ''}`);
    return title.includes(query) || display.includes(query) || author.includes(query);
  });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return { ambiguous: hits };

  // Contract v4: tolerate one or two editing errors in the book title while
  // keeping the match scoped to title/author tokens, never arbitrary chat text.
  const fuzzyHits = (Array.isArray(books) ? books : []).filter(book => {
    const title = normalizeBookQuery(book?.title);
    const author = normalizeBookQuery(book?.author);
    const candidates = [title, title + ' ' + author].map(normalizeBookQuery);
    return candidates.some(candidate => editDistance(query, candidate, 2) <= 2)
      || query.split(/\s+/u).every(token => candidates.some(candidate => candidateTokens(candidate).some(candidateToken => editDistance(token, candidateToken, 2) <= 2)));
  });
  if (fuzzyHits.length === 1) return fuzzyHits[0];
  return fuzzyHits.length > 1 ? { ambiguous: fuzzyHits } : null;
}

function candidateTokens(value) {
  return normalizeBookQuery(value).split(/\s+/u).filter(Boolean);
}
