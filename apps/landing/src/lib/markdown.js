/** A small Markdown-to-HTML converter for the legal documents (docs/legal). */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const SAFE_HREF = /^(https?:\/\/|mailto:|\/|#)/i;

/** Inline formatting on text that has not been escaped yet. */
export function inline(text) {
  // Pull code spans and links out first (so their contents are not formatted twice), escape the rest.
  const holes = [];
  const hold = (html) => `\u0000${holes.push(html) - 1}\u0000`;
  let s = String(text)
    .replace(/`([^`]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`))
    .replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (m, label, href) => (SAFE_HREF.test(href) ? hold(`<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`) : escapeHtml(label)));
  s = escapeHtml(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => holes[Number(i)]);
}

export const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isTableRule = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line);
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function markdownToHtml(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  // Lines of one paragraph join with a space, as in any Markdown; a line ending in a backslash breaks instead.
  const flushParagraph = (buf) => {
    if (buf.length) {
      const html = buf.map((line, k) => {
        const hard = line.endsWith('\\') && k < buf.length - 1;
        return inline(hard ? line.slice(0, -1).trimEnd() : line) + (k === buf.length - 1 ? '' : hard ? '<br>' : ' ');
      });
      out.push(`<p>${html.join('')}</p>`);
    }
    buf.length = 0;
  };

  const para = [];
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      flushParagraph(para);
      i++;
      continue;
    }

    const heading = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flushParagraph(para);
      const level = heading[1].length;
      out.push(`<h${level} id="${slug(heading[2])}">${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      flushParagraph(para);
      out.push('<hr>');
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushParagraph(para);
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${markdownToHtml(quote.join('\n'))}</blockquote>`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph(para);
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*[-*]\s+/, '');
        // a wrapped line belongs to the item above it
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      flushParagraph(para);
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      // Each cell carries its column's name, so a narrow screen can stack a row into labelled lines.
      const label = (c) => escapeHtml(c.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|`/g, '').trim());
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, k) => `<td data-label="${label(head[k] ?? '')}">${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushParagraph(para);
  return out.join('\n');
}
