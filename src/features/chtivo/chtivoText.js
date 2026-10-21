export function normalizeChtivoText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

export function splitChtivoChapters(text) {
  const source = normalizeChtivoText(text);
  const chapters = [];
  let title = 'Вводная часть';
  let body = [];
  const flush = () => {
    const value = normalizeChtivoText(body.join('\n'));
    if (value) chapters.push({ title, body: value });
    body = [];
  };
  for (const line of source.split('\n')) {
    const marker = line.match(/^\[\[ГЛАВА:\s*(.+?)\]\]$/iu);
    if (marker) { flush(); title = marker[1].trim(); }
    else body.push(line);
  }
  flush();
  // A short title page or publisher preface before the first explicit
  // chapter marker belongs to chapter one, not to a standalone reading day.
  if (chapters.length > 1 && chapters[0].title === 'Вводная часть') {
    chapters[1].body = `${chapters[0].body}\n\n${chapters[1].body}`.trim();
    chapters.shift();
  }
  return chapters.length ? chapters : [{ title: 'Текст книги', body: source }];
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
  return hits.length > 1 ? { ambiguous: hits } : null;
}
