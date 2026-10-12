import { describe, expect, it } from 'vitest';
import { escapeHtml, inline, markdownToHtml, slug } from '../src/lib/markdown.js';

describe('inline', () => {
  it('formats bold, code and links', () => {
    expect(inline('a **b** `c` [d](https://x.io/p?q=1)')).toBe('a <strong>b</strong> <code>c</code> <a href="https://x.io/p?q=1">d</a>');
  });

  it('escapes everything else, including markup inside bold and code', () => {
    expect(inline('<script>alert(1)</script> & "q"')).toBe('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;');
    expect(inline('**<b>**')).toBe('<strong>&lt;b&gt;</strong>');
    expect(inline('`<i>`')).toBe('<code>&lt;i&gt;</code>');
  });

  it('only links to http(s), mailto, a path or an anchor; any other link is plain text', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd']) {
      const html = inline(`[click](${bad})`);
      expect(html).toBe('click');
      expect(html).not.toContain('href');
    }
    for (const ok of ['https://a.io', 'http://a.io', 'mailto:a@b.io', '/privacy.html', '#top']) expect(inline(`[t](${ok})`)).toContain(`href="${ok}"`);
  });

  it('cannot be tricked into closing the attribute', () => {
    const html = inline('[x](https://a.io/"onmouseover="alert(1))');
    expect(html).not.toContain('"onmouseover=');
  });
});

describe('markdownToHtml', () => {
  it('makes headings with ids, paragraphs, rules and lists', () => {
    const html = markdownToHtml('## 1. Agreement to These Terms\n\nFirst line\\\nsecond line\n\n- one\n- two with **bold**\n\n---\n');
    expect(html).toContain('<h2 id="1-agreement-to-these-terms">1. Agreement to These Terms</h2>');
    expect(html).toContain('<p>First line<br>second line</p>');
    expect(html).toContain('<ul><li>one</li><li>two with <strong>bold</strong></li></ul>');
    expect(html).toContain('<hr>');
  });

  it('joins the lines of a wrapped paragraph with a space, and breaks only where a line ends in a backslash', () => {
    expect(markdownToHtml('one line\nwrapped on\nmore')).toBe('<p>one line wrapped on more</p>');
    expect(markdownToHtml('Stryx\\\nAddress: x\\\nEmail: y')).toBe('<p>Stryx<br>Address: x<br>Email: y</p>');
    expect(markdownToHtml('ends with a slash\\')).toBe('<p>ends with a slash\\</p>'); // a last line keeps its backslash
  });

  it('joins a wrapped list item', () => {
    expect(markdownToHtml('- one\n  continued\n- two')).toBe('<ul><li>one continued</li><li>two</li></ul>');
  });

  it('makes tables, with the cells formatted and escaped', () => {
    const html = markdownToHtml('| A | B |\n| --- | --- |\n| `x` | <b> |\n| 2 | **3** |');
    expect(html).toContain('<th>A</th><th>B</th>');
    expect(html).toContain('<td data-label="A"><code>x</code></td><td data-label="B">&lt;b&gt;</td>');
    expect(html).toContain('<td data-label="B"><strong>3</strong></td>');
    expect(html).not.toContain('<b>');
  });

  it("labels each cell with its column's plain-text name, escaped, for stacking on a phone", () => {
    const html = markdownToHtml('| **Why** | [Basis](https://x.test) | a "q" & <b> |\n| --- | --- | --- |\n| 1 | 2 | 3 |');
    expect(html).toContain('<td data-label="Why">1</td><td data-label="Basis">2</td><td data-label="a &quot;q&quot; &amp; &lt;b&gt;">3</td>');
  });

  it('makes block quotes, containing paragraphs', () => {
    expect(markdownToHtml('> **Note.** careful\\\n> more')).toBe('<blockquote><p><strong>Note.</strong> careful<br>more</p></blockquote>');
  });

  it('turns raw HTML in a document into text', () => {
    const html = markdownToHtml('<img src=x onerror=alert(1)>\n\n<script>x</script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
  });

  it('copes with empty input and with Windows line endings', () => {
    expect(markdownToHtml('')).toBe('');
    expect(markdownToHtml('a\r\n\r\nb')).toBe('<p>a</p>\n<p>b</p>');
  });
});

describe('slug / escapeHtml', () => {
  it('slugs a heading and escapes the five characters', () => {
    expect(slug('7.1 Connected wallets')).toBe('7-1-connected-wallets');
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
