import { isProjectArchiveAuditIntent } from '../audit/projectArchiveIntent.js';

const REQUEST_VERB = /(?:сделай|создай|подготовь|сгенерируй|оформи|верни|дай|собери|напиши|составь|make|create|generate|prepare)/iu;
const PRESENTATION = /(?:презентац(?:ию|ия|ии|ией)?|power\s*point|powerpoint|pptx?)/iu;
const WORD = /(?:\bword\b|ворд|\bdocx?\b|документ(?:ом|а|е|у)?\s+(?:word|ворд)|в\s+ворде)/iu;
const PDF = /(?:\bpdf\b|пдф|в\s+пдф)/iu;

function clean(value) {
    return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

export function parseDocumentArtifactRequest(value, { forceFormat = '' } = {}) {
    const text = clean(value);
    const forced = String(forceFormat ?? '').trim().toLowerCase();
    if (!text && !forced) return { matched: false, format: '', prompt: '' };

    // An explicit Astra ZIP audit always owns its response format. In particular,
    // "верни итоговый ZIP с отчётом и файлами" must NEVER fall into DOCX.
    if (isProjectArchiveAuditIntent(text)) {
        return { matched: false, format: '', prompt: text };
    }

    let format = '';
    if (['pptx', 'presentation'].includes(forced)) format = 'pptx';
    else if (['docx', 'word', 'doc'].includes(forced)) format = 'docx';
    else if (forced === 'pdf') format = 'pdf';
    else if (PRESENTATION.test(text)) format = 'pptx';
    else if (PDF.test(text)) format = 'pdf';
    else if (WORD.test(text)) format = 'docx';

    // No generic "отчёт"+"файл" ⇒ Word default. An artifact must be requested
    // explicitly by format or by deliberate selection from the document menu.
    if (!format || (!forced && !REQUEST_VERB.test(text))) {
        return { matched: false, format: '', prompt: text };
    }
    return { matched: true, format, prompt: text };
}

export function formatDocumentArtifactLabel(format) {
    if (format === 'pptx') return 'презентация PowerPoint';
    if (format === 'pdf') return 'PDF-документ';
    return 'Word-документ';
}
