import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { legalDocument } from '../src/lib/legal-doc.js';
import { legalLinksOn, mountLegalLinks } from '../src/lib/legal-links.js';
import { LEGAL_PAGES, legalPages, sourceFor } from '../vite-legal-plugin.js';

const DRAFT = `# STRYX TERMS OF USE

> **DRAFT, not yet published.** note for the team.

**Version:** 1.0

## 1. Agreement

Text.

---

## SIGN-UP ACCEPTANCE

☐ I agree...

- account identifier;

## FEATURE-SPECIFIC TERMS

More text.
`;

describe('legalDocument', () => {
  it('takes the title, flags the draft note and removes it', () => {
    const doc = legalDocument(DRAFT);
    expect(doc.title).toBe('STRYX TERMS OF USE');
    expect(doc.draft).toBe(true);
    expect(doc.html).not.toContain('not yet published');
    expect(doc.html).toContain('<h2 id="1-agreement">1. Agreement</h2>');
  });

  it('leaves out the internal acceptance section but keeps what follows it', () => {
    const doc = legalDocument(DRAFT);
    expect(doc.html).not.toContain('SIGN-UP ACCEPTANCE');
    expect(doc.html).not.toContain('account identifier');
    expect(doc.html).toContain('FEATURE-SPECIFIC TERMS');
    expect(doc.html).toContain('More text.');
  });

  it('a final document (no note) is not a draft', () => {
    expect(legalDocument('# Privacy\n\n## 1. Hello\n\nText').draft).toBe(false);
  });
});

describe('the real documents', () => {
  const docs = resolve(import.meta.dirname, '../../../docs/legal');
  for (const [page, files] of Object.entries(LEGAL_PAGES)) {
    it(`${page} is made from ${files.join(' or ')} and has real content`, () => {
      const file = sourceFor(page, docs);
      const doc = legalDocument(readFileSync(file, 'utf8'));
      expect(doc.html.length).toBeGreaterThan(3000);
      expect(doc.html).toMatch(/<h2 id=/);
      expect(doc.html).not.toContain('<script');
      expect(doc.html).not.toContain('SIGN-UP ACCEPTANCE');
      expect(doc.html).not.toContain('stryxisvibey'); // the removed contact address
    });
  }

  it('the Terms page does not carry the team-only note, and the Privacy page does not either', () => {
    for (const page of Object.keys(LEGAL_PAGES)) {
      const doc = legalDocument(readFileSync(sourceFor(page, docs), 'utf8'));
      expect(doc.html).not.toContain('Delete this note when the text is final');
    }
  });
});

describe('legalPages plugin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legal-'));
  writeFileSync(join(dir, 'terms-of-use-DRAFT.md'), DRAFT);
  writeFileSync(join(dir, 'privacy-policy.md'), '# STRYX PRIVACY POLICY\n\n## 1. Short\n\nFinal text <b>x</b>.\n');
  const run = (page, html = '<title><!--LEGAL_TITLE--></title><!--LEGAL_ROBOTS--><main><!--LEGAL_BODY--></main>') => {
    const plugin = legalPages({ dir });
    return plugin.transformIndexHtml.handler(html, { filename: `/x/${page}` });
  };

  it('fills a draft page, shows the draft banner and asks search engines to skip it', () => {
    const html = run('terms.html');
    expect(html).toContain('<title>STRYX TERMS OF USE</title>');
    expect(html).toContain('legal__draft');
    expect(html).toContain('noindex');
    expect(html).toContain('Text.');
  });

  it('prefers the final document over the draft, and a final page has no banner and no noindex', () => {
    const html = run('privacy.html');
    expect(html).toContain('Final text &lt;b&gt;x&lt;/b&gt;.');
    expect(html).not.toContain('legal__draft');
    expect(html).not.toContain('noindex');
  });

  it('a "$&" or "$\'" in the text is printed as written, not read as a replacement pattern', () => {
    const odd = mkdtempSync(join(tmpdir(), 'legal-'));
    writeFileSync(join(odd, 'privacy-policy.md'), "# P\n\n## 1. Fees\n\nA fee of US$'5 & $& more.\n");
    const html = legalPages({ dir: odd }).transformIndexHtml.handler('<main><!--LEGAL_BODY--></main>', { filename: '/x/privacy.html' });
    expect(html).not.toContain('<!--LEGAL_BODY-->');
    expect(html).toContain('US$&#39;5 &amp; $&amp; more.');
  });

  it('leaves every other page alone', () => {
    const html = '<p><!--LEGAL_BODY--></p>';
    expect(run('index.html', html)).toBe(html);
  });
});

describe('legalLinksOn / mountLegalLinks', () => {
  it('are on in development, and in production only when switched on', () => {
    expect(legalLinksOn({ DEV: true })).toBe(true);
    expect(legalLinksOn({ DEV: false })).toBe(false);
    expect(legalLinksOn({ DEV: false, VITE_LEGAL_LINKS: 'true' })).toBe(true);
    expect(legalLinksOn({ DEV: true, VITE_LEGAL_LINKS: 'false' })).toBe(false);
    expect(legalLinksOn({})).toBe(false);
  });

  it('reveals the links only when on', () => {
    const els = [{ hidden: true }, { hidden: true }];
    const root = { querySelectorAll: () => els };
    mountLegalLinks(false, root);
    expect(els.every((e) => e.hidden)).toBe(true);
    mountLegalLinks(true, root);
    expect(els.every((e) => !e.hidden)).toBe(true);
  });
});
