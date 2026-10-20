import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

// A small layout kit over pdfkit for Yulo's money documents (statements, order statements,
// payout receipts). Every string written goes through `text()` and is also kept in `doc.lines`,
// so a document's content can be checked without parsing the PDF (the embedded font writes
// glyph ids, not readable text).
//
// Noto Sans (SIL OFL 1.1 — assets/fonts/OFL.txt) is embedded because the PDF standard fonts
// have no ₹ sign.

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../assets/fonts');
const FONTS = { regular: path.join(FONT_DIR, 'NotoSans-Regular.ttf'), bold: path.join(FONT_DIR, 'NotoSans-Bold.ttf') };

const INK = '#1a1d1b';
const MUTED = '#596059';
const RULE = '#e3dfd4';
const ACCENT = '#14594a';
const MARGIN = 48;

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Paise → "₹1,146.92" / "−₹12.42"; null → "—". */
export const money = (paise) => {
  if (paise == null || Number.isNaN(Number(paise))) return '—';
  const n = Number(paise) / 100;
  return `${n < 0 ? '−' : ''}₹${inr.format(Math.abs(n))}`;
};

/** A date in the settlement time zone: "20 Oct 2026" (or with the time). */
export const day = (d, timezone = 'Asia/Kolkata', withTime = false) => {
  if (!d) return '—';
  const opts = { timeZone: timezone, day: '2-digit', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: true } : {}) };
  return new Intl.DateTimeFormat('en-GB', opts).format(new Date(d)).replace(',', '');
};

export const periodText = (p, timezone) => (p ? `${day(p.start, timezone)} – ${day(p.end, timezone)}` : '—');

/** "spice-route" for a filename. */
export const slug = (s) =>
  String(s ?? 'restaurant')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'restaurant';

/**
 * Start a document. Returns { doc, done } — `done()` resolves to { buffer, text } once the
 * document is finished (page numbers and the generated-at line are added then).
 */
export const createDocument = ({ title, subtitle, timezone = 'Asia/Kolkata', now = new Date() }) => {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true, info: { Title: title, Author: 'Yulo Stores', Producer: 'Yulo Stores' } });
  doc.registerFont('regular', FONTS.regular);
  doc.registerFont('bold', FONTS.bold);
  doc.lines = [];
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const finished = new Promise((resolve) => doc.on('end', resolve));

  // Header.
  doc.font('bold').fontSize(10).fillColor(ACCENT);
  write(doc, 'Yulo Stores', MARGIN, MARGIN);
  doc.font('bold').fontSize(18).fillColor(INK);
  write(doc, title, MARGIN, MARGIN + 18);
  if (subtitle) {
    doc.font('regular').fontSize(10).fillColor(MUTED);
    write(doc, subtitle, MARGIN, doc.y + 2);
  }
  doc.moveDown(0.8);
  rule(doc);

  const done = async () => {
    const generated = `Generated ${day(now, timezone, true)} IST`;
    doc.lines.push(generated);
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const y = doc.page.height - MARGIN + 14;
      doc.font('regular').fontSize(8).fillColor(MUTED);
      doc.text(generated, MARGIN, y, { lineBreak: false });
      const pageLabel = `Page ${i - range.start + 1} of ${range.count}`;
      doc.text(pageLabel, doc.page.width - MARGIN - doc.widthOfString(pageLabel), y, { lineBreak: false });
    }
    doc.end();
    await finished;
    return { buffer: Buffer.concat(chunks), text: doc.lines.join('\n') };
  };
  return { doc, done };
};

// Every string goes through here (also recorded in doc.lines).
const write = (doc, str, x, y, opts = {}) => {
  const s = String(str ?? '');
  doc.lines.push(s);
  doc.text(s, x, y, opts);
};

const rule = (doc) => {
  doc.moveTo(MARGIN, doc.y).lineTo(doc.page.width - MARGIN, doc.y).lineWidth(0.7).strokeColor(RULE).stroke();
  doc.moveDown(0.6);
};

const ensureSpace = (doc, h) => {
  if (doc.y + h > doc.page.height - MARGIN - 24) doc.addPage();
};

/** A section heading. */
export const heading = (doc, str) => {
  ensureSpace(doc, 40);
  doc.moveDown(0.4);
  doc.font('bold').fontSize(12).fillColor(INK);
  write(doc, str, MARGIN, doc.y);
  doc.moveDown(0.3);
};

/** Label / value pairs, two columns. */
export const facts = (doc, pairs) => {
  const width = doc.page.width - MARGIN * 2;
  for (const [label, value] of pairs.filter(Boolean)) {
    ensureSpace(doc, 18);
    const y = doc.y;
    doc.font('regular').fontSize(10).fillColor(MUTED);
    write(doc, label, MARGIN, y, { width: width * 0.4 - 8 });
    const labelBottom = doc.y;
    doc.font('bold').fontSize(10).fillColor(INK);
    write(doc, value ?? '—', MARGIN + width * 0.4, y, { width: width * 0.6 });
    // Either column may wrap: the next fact starts below the taller one.
    doc.y = Math.max(doc.y, labelBottom, y + 14);
  }
};

/** Money lines: label left, amount right; `total` draws the last line bold above a rule. */
export const amountLines = (doc, lines, { total } = {}) => {
  const width = doc.page.width - MARGIN * 2;
  for (const l of lines) {
    ensureSpace(doc, 18);
    const y = doc.y;
    doc.font('regular').fontSize(10).fillColor(INK);
    write(doc, l.label, MARGIN, y, { width: width * 0.7 });
    if (l.sub) {
      doc.font('regular').fontSize(8).fillColor(MUTED);
      write(doc, l.sub, MARGIN, doc.y, { width: width * 0.7 });
    }
    const labelBottom = doc.y;
    doc.font('regular').fontSize(10).fillColor(INK);
    write(doc, money(l.amountPaise), MARGIN, y, { width, align: 'right' });
    // The amount sits on the label's first line; the next line starts below the sub-text.
    doc.y = Math.max(labelBottom, y + 14) + 2;
  }
  if (total) {
    rule(doc);
    const y = doc.y;
    doc.font('bold').fontSize(11).fillColor(INK);
    write(doc, total.label, MARGIN, y);
    write(doc, money(total.amountPaise), MARGIN, y, { width, align: 'right' });
    doc.y = y + 18;
  }
};

/**
 * A table. columns: [{ header, width (fraction), align }]; rows: arrays of strings.
 */
export const table = (doc, columns, rows) => {
  const width = doc.page.width - MARGIN * 2;
  const drawHeader = () => {
    const y = doc.y;
    doc.rect(MARGIN, y - 3, width, 18).fill('#efece4');
    doc.font('bold').fontSize(8.5).fillColor(MUTED);
    let x = MARGIN + 4;
    for (const c of columns) {
      write(doc, c.header, x, y, { width: c.width * width - 8, align: c.align ?? 'left', lineBreak: false });
      x += c.width * width;
    }
    doc.y = y + 20;
  };
  drawHeader();
  for (const row of rows) {
    if (doc.y + 18 > doc.page.height - MARGIN - 24) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    doc.font('regular').fontSize(9).fillColor(INK);
    let x = MARGIN + 4;
    row.forEach((cell, i) => {
      write(doc, cell ?? '—', x, y, { width: columns[i].width * width - 8, align: columns[i].align ?? 'left', lineBreak: false, ellipsis: true });
      x += columns[i].width * width;
    });
    doc.y = y + 16;
    doc.moveTo(MARGIN, doc.y - 3).lineTo(MARGIN + width, doc.y - 3).lineWidth(0.4).strokeColor(RULE).stroke();
  }
  if (!rows.length) {
    doc.font('regular').fontSize(9).fillColor(MUTED);
    write(doc, 'No records.', MARGIN + 4, doc.y);
  }
  doc.moveDown(0.4);
};

/** A paragraph of muted text. */
export const note = (doc, str) => {
  ensureSpace(doc, 30);
  doc.font('regular').fontSize(9).fillColor(MUTED);
  write(doc, str, MARGIN, doc.y, { width: doc.page.width - MARGIN * 2 });
  doc.moveDown(0.4);
};
