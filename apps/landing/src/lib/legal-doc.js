import { markdownToHtml } from './markdown.js';

/** Turns one of the legal documents in docs/legal into the page body. */
export function legalDocument(markdown) {
  let md = String(markdown).replace(/\r\n?/g, '\n');

  const titleMatch = /^#\s+(.+)$/m.exec(md);
  const title = titleMatch ? titleMatch[1].trim() : 'Legal';
  if (titleMatch) md = md.replace(titleMatch[0], '').trimStart();

  let draft = false;
  const note = /^((?:>.*\n?)+)/.exec(md);
  if (note) {
    draft = true;
    md = md.slice(note[0].length).trimStart();
  }

  const start = md.search(/^##\s+SIGN-UP ACCEPTANCE\s*$/m);
  if (start >= 0) {
    const after = md.slice(start).search(/^##\s+FEATURE-SPECIFIC TERMS\s*$/m);
    md = md.slice(0, start) + (after >= 0 ? md.slice(start + after) : '');
  }
  // the rule that separated the internal section from the contact block
  md = md.replace(/\n---\s*\n+(?=##\s+FEATURE-SPECIFIC TERMS)/, '\n');

  return { title, draft, html: markdownToHtml(md.trim()) };
}
