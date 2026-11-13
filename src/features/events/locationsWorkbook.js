import { deflateRawSync, inflateRawSync } from 'node:zlib';

function decodeXml(value) {
    return String(value ?? '').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>')
        .replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&amp;/gu, '&');
}

function zipEntries(buffer) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    let eocd = -1;
    for (let offset = Math.max(0, bytes.length - 65_557); offset <= bytes.length - 22; offset += 1) {
        if (bytes.readUInt32LE(offset) === 0x06054b50) eocd = offset;
    }
    if (eocd < 0) throw new Error('Файл не является корректной XLSX-книгой (не найден ZIP directory).');
    const count = bytes.readUInt16LE(eocd + 10);
    let cursor = bytes.readUInt32LE(eocd + 16);
    const entries = new Map();
    for (let index = 0; index < count; index += 1) {
        if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Повреждён каталог XLSX.');
        const method = bytes.readUInt16LE(cursor + 10);
        const compressedSize = bytes.readUInt32LE(cursor + 20);
        const nameLength = bytes.readUInt16LE(cursor + 28);
        const extraLength = bytes.readUInt16LE(cursor + 30);
        const commentLength = bytes.readUInt16LE(cursor + 32);
        const localOffset = bytes.readUInt32LE(cursor + 42);
        const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
        const localNameLength = bytes.readUInt16LE(localOffset + 26);
        const localExtraLength = bytes.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
        if (method !== 0 && method !== 8) throw new Error(`Неподдерживаемый тип сжатия XLSX: ${method}.`);
        entries.set(name, method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed));
        cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

function xmlAttribute(tag, name) {
    return tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'u'))?.[1] ?? '';
}

function columnIndex(reference) {
    const letters = String(reference ?? '').match(/^[A-Z]+/iu)?.[0]?.toUpperCase() || '';
    let index = 0;
    for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
    return index - 1;
}

function readSharedStrings(xml) {
    if (!xml) return [];
    return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/giu)].map(([, item]) =>
        [...item.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/giu)].map(([, value]) => decodeXml(value)).join(''));
}

function workbookSheetPath(entries) {
    const workbook = entries.get('xl/workbook.xml')?.toString('utf8') || '';
    const firstSheet = workbook.match(/<sheet\b[^>]*\br:id="([^"]+)"[^>]*\/?\s*>/iu);
    const relationId = firstSheet?.[1];
    if (!relationId) return 'xl/worksheets/sheet1.xml';
    const relations = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
    const relation = [...relations.matchAll(/<Relationship\b[^>]*\/?\s*>/giu)]
        .map(([tag]) => ({ id: xmlAttribute(tag, 'Id'), target: xmlAttribute(tag, 'Target') }))
        .find(item => item.id === relationId);
    if (!relation?.target) return 'xl/worksheets/sheet1.xml';
    const target = relation.target.replace(/^\//u, '');
    return target.startsWith('xl/') ? target : `xl/${target}`;
}

function sheetRows(xml, sharedStrings) {
    const rows = [];
    for (const [, rowXml] of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/giu)) {
        const row = [];
        for (const [, attrs, cellBody = ''] of rowXml.matchAll(/<c\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/c>)/giu)) {
            const col = columnIndex(xmlAttribute(attrs, 'r'));
            if (col < 0 || col > 255) continue;
            const type = xmlAttribute(attrs, 't');
            let value = '';
            if (type === 'inlineStr') {
                value = [...cellBody.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/giu)].map(([, part]) => decodeXml(part)).join('');
            } else {
                const raw = cellBody.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/iu)?.[1] ?? '';
                value = type === 's' ? (sharedStrings[Number(raw)] ?? '') : decodeXml(raw);
            }
            row[col] = value;
        }
        rows.push(row);
    }
    return rows;
}

function headerKey(value) {
    return String(value ?? '').trim().toLowerCase().replace(/ё/gu, 'е').replace(/[\s_-]+/gu, '');
}

function cell(row, headers, ...names) {
    for (const name of names) {
        const index = headers.indexOf(headerKey(name));
        if (index >= 0) {
            const value = String(row[index] ?? '').trim();
            if (value) return value;
        }
    }
    return '';
}

function normalizeUrl(value, expectedHosts) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
        if (expectedHosts && !expectedHosts.includes(url.hostname.toLowerCase().replace(/^www\./u, ''))) return '';
        return url.href;
    } catch { return ''; }
}

export function inspectLocationsWorkbook(buffer) {
    const entries = zipEntries(buffer);
    const sheetPath = workbookSheetPath(entries);
    const xml = entries.get(sheetPath)?.toString('utf8');
    if (!xml) throw new Error('В locations.xlsx не найдена первая таблица.');
    const sharedStrings = readSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8'));
    const rows = sheetRows(xml, sharedStrings);
    if (!rows.length) return [];
    const headers = rows[0].map(headerKey);
    const records = [];
    const invalidRows = [];
    for (const [index, row] of rows.slice(1).entries()) {
        const rowNumber = index + 2;
        const name = cell(row, headers, 'name', 'название', 'площадка', 'нормализованное название');
        if (!row.some(value => String(value ?? '').trim())) continue;
        const vkUrl = normalizeUrl(cell(row, headers, 'vk_url', 'вк', 'vk', 'вконтакте'), ['vk.ru', 'vk.com']);
        const telegramUrl = normalizeUrl(cell(row, headers, 'telegram_url', 'tg', 'telegram', 'телеграм'), ['t.me', 'telegram.me']);
        const websiteUrl = normalizeUrl(cell(row, headers, 'website_url', 'сайт', 'website', 'сайт площадки'));
        const address = cell(row, headers, 'address', 'адрес');
        const errors = [];
        if (!name) errors.push('нет названия площадки');
        if (!address) errors.push('нет адреса');
        if (!vkUrl && !telegramUrl && !websiteUrl) errors.push('нет корректной ссылки ВК, Telegram или сайта');
        if (errors.length) { invalidRows.push({ rowNumber, name, errors }); continue; }
        const sourceValue = cell(row, headers, 'источник', 'source', 'пул', 'тип источника');
        const primary = /^(?:1|основн(?:ой|ые|ая|ый)?|primary)$/iu.test(sourceValue.trim());
        const explicitSecondary = /^(?:2|второстепенн(?:ый|ые|ая|ое)?|secondary)$/iu.test(sourceValue.trim());
        const pool = primary ? 'primary' : 'secondary';
        const preferredSourceUrl = primary ? (vkUrl || telegramUrl) : (telegramUrl || vkUrl);
        records.push({
            id: cell(row, headers, 'venue_id', 'id') || `locations-row-${rowNumber}`,
            name: name.replace(/\s+/gu, ' ').trim(),
            city: cell(row, headers, 'city', 'город') || 'Воронеж',
            address,
            vkUrl, telegramUrl, websiteUrl,
            sourcePool: pool,
            sourcePoolExplicit: primary || explicitSecondary,
            sourceUrl: preferredSourceUrl,
            sourceKind: preferredSourceUrl && /(?:^|\.)t\.me\//iu.test(preferredSourceUrl) ? 'telegram'
                : preferredSourceUrl && /(?:^|\.)(?:vk\.ru|vk\.com)\//iu.test(preferredSourceUrl) ? 'vk-public' : '',
        });
    }
    return { records, invalidRows };
}

export function parseLocationsWorkbook(buffer) {
    return inspectLocationsWorkbook(buffer).records;
}

const EXPORT_HEADERS = ['venue_id', 'name', 'city', 'address', 'vk_url', 'telegram_url', 'website_url', 'source_url', 'источник'];

function xmlEscape(value) {
    return String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

function excelColumn(index) {
    let value = index + 1;
    let result = '';
    while (value) { value -= 1; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
    return result;
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries) {
    const local = []; const central = []; let offset = 0;
    for (const [name, content] of entries) {
        const filename = Buffer.from(name, 'utf8'); const raw = Buffer.from(content, 'utf8'); const compressed = deflateRawSync(raw); const crc = crc32(raw);
        const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(filename.length, 26);
        local.push(header, filename, compressed);
        const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(raw.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
        central.push(directory, filename); offset += header.length + filename.length + compressed.length;
    }
    const centralSize = central.reduce((total, part) => total + part.length, 0);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, ...central, end]);
}

export function buildLocationsWorkbook(records = []) {
    const rows = [EXPORT_HEADERS, ...records.map(record => [record.id, record.name, record.city || 'Воронеж', record.address, record.vkUrl, record.telegramUrl, record.websiteUrl, record.sourceUrl, record.sourcePool === 'primary' ? '1' : '2'])];
    const sheetRowsXml = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => { const cellValue = String(value ?? ''); const ref = `${excelColumn(columnIndex)}${rowIndex + 1}`; return cellValue ? `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cellValue)}</t></is></c>` : ''; }).join('')}</row>`).join('');
    return zipStore([
        ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
        ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
        ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="venues" sheetId="1" r:id="rId1"/></sheets></workbook>'],
        ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
        ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRowsXml}</sheetData></worksheet>`],
    ]);
}
