import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legalDocument } from './src/lib/legal-doc.js';
import { escapeHtml } from './src/lib/markdown.js';

const here = dirname(fileURLToPath(import.meta.url));
const LEGAL_DIR = resolve(here, '../../docs/legal');

/** The page for each legal document, and the file it is made from (the final one when it exists, else the draft). */
export const LEGAL_PAGES = {
  'terms.html': ['terms-of-use.md', 'terms-of-use-DRAFT.md'],
  'privacy.html': ['privacy-policy.md', 'privacy-policy-DRAFT.md'],
};

export function sourceFor(page, dir = LEGAL_DIR) {
  const found = (LEGAL_PAGES[page] ?? []).map((f) => resolve(dir, f)).find((f) => existsSync(f));
  if (!found) throw new Error(`No legal document found for ${page} in ${dir}`);
  return found;
}

/** Fills terms.html and privacy.html from docs/legal, in dev and in the build. */
export function legalPages({ dir = LEGAL_DIR } = {}) {
  return {
    name: 'stryx-legal-pages',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const page = ctx.filename ? ctx.filename.split(/[\\/]/).pop() : undefined;
        if (!page || !(page in LEGAL_PAGES)) return html;
        const doc = legalDocument(readFileSync(sourceFor(page, dir), 'utf8'));
        const banner = doc.draft ? '<p class="legal__draft" role="note"><strong>Draft.</strong> This document is not final and is not yet in force.</p>' : '';
        // Functions, not strings: in a replacement string "$&" and "$'" are patterns, and a document's
        // text can contain them.
        return html
          .replaceAll('<!--LEGAL_TITLE-->', () => escapeHtml(doc.title))
          .replace('<!--LEGAL_ROBOTS-->', () => (doc.draft ? '<meta name="robots" content="noindex, nofollow" />' : ''))
          .replace('<!--LEGAL_BODY-->', () => `${banner}\n${doc.html}`);
      },
    },
  };
}
