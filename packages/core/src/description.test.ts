import { describe, expect, it } from 'vitest';
import { renderDescription, renderInline, safeHref } from './description';

describe('safeHref', () => {
  it('allows http, https and mailto', () => {
    expect(safeHref('https://example.com/a?b=c&d=e')).toBe('https://example.com/a?b=c&amp;d=e');
    expect(safeHref('http://example.com')).toBe('http://example.com');
    expect(safeHref('mailto:team@example.com')).toBe('mailto:team@example.com');
    expect(safeHref('HTTPS://EXAMPLE.COM/Path')).toBe('HTTPS://EXAMPLE.COM/Path');
  });

  it('rejects dangerous, relative and empty targets', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('JAVASCRIPT:alert(1)')).toBeNull();
    expect(safeHref('java\nscript:alert(1)')).toBeNull();
    expect(safeHref('java\tscript:alert(1)')).toBeNull();
    expect(safeHref('  javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHref('vbscript:msgbox(1)')).toBeNull();
    expect(safeHref('file:///etc/passwd')).toBeNull();
    expect(safeHref('example.com/page')).toBeNull();
    expect(safeHref('/relative/path')).toBeNull();
    expect(safeHref('#anchor')).toBeNull();
    expect(safeHref('')).toBeNull();
    expect(safeHref('https://')).toBe('https://');
    expect(safeHref(`https://${'a'.repeat(2049)}`)).toBeNull();
  });
});

describe('renderInline', () => {
  it('escapes HTML and entities', () => {
    expect(renderInline('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(renderInline('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(renderInline('a & b')).toBe('a &amp; b');
    expect(renderInline('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it('renders bold, italic and strikethrough', () => {
    expect(renderInline('**bold**')).toBe('<strong>bold</strong>');
    expect(renderInline('__bold__')).toBe('<strong>bold</strong>');
    expect(renderInline('*em*')).toBe('<em>em</em>');
    expect(renderInline('_em_')).toBe('<em>em</em>');
    expect(renderInline('~~gone~~')).toBe('<del>gone</del>');
    expect(renderInline('**a *b* c**')).toBe('<strong>a <em>b</em> c</strong>');
    expect(renderInline('text ** unclosed')).toBe('text ** unclosed');
  });

  it('keeps snake_case literal but allows _emphasis_ between words', () => {
    expect(renderInline('snake_case_name')).toBe('snake_case_name');
    expect(renderInline('a _word_ b')).toBe('a <em>word</em> b');
    expect(renderInline('100%_test')).toBe('100%_test');
  });

  it('renders inline code literally', () => {
    expect(renderInline('`<b>x</b>`')).toBe('<code>&lt;b&gt;x&lt;/b&gt;</code>');
    expect(renderInline('`a **b** c`')).toBe('<code>a **b** c</code>');
    expect(renderInline('unclosed ` code')).toBe('unclosed ` code');
  });

  it('renders links with the safe target and noopener', () => {
    expect(renderInline('[docs](https://example.com)'))
      .toBe('<a href="https://example.com" rel="noopener noreferrer" target="_blank">docs</a>');
    expect(renderInline('[mail](mailto:a@b.c)'))
      .toBe('<a href="mailto:a@b.c" rel="noopener noreferrer" target="_blank">mail</a>');
  });

  it('renders unsafe links as literal text', () => {
    expect(renderInline('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))');
    expect(renderInline('[x](JAVASCRIPT:alert(1))')).toBe('[x](JAVASCRIPT:alert(1))');
    expect(renderInline('[x](java\tscript:alert(1))')).toBe('[x](java\tscript:alert(1))');
    expect(renderInline('[x](data:text/html,1)')).toBe('[x](data:text/html,1)');
    expect(renderInline('[](https://example.com)')).toBe('[](https://example.com)');
    expect(renderInline('[unclosed](https://example.com')).toBe('[unclosed](https://example.com');
  });

  it('turns line breaks into <br>', () => {
    expect(renderInline('one\ntwo')).toBe('one<br>two');
  });
});

describe('renderDescription blocks', () => {
  it('returns empty string for blank input', () => {
    expect(renderDescription('')).toBe('');
    expect(renderDescription('   \n  \n')).toBe('');
  });

  it('renders paragraphs with soft line breaks', () => {
    expect(renderDescription('line one\nline two')).toBe('<p>line one<br>line two</p>');
    expect(renderDescription('a\n\nb')).toBe('<p>a</p><p>b</p>');
    expect(renderDescription('crlf\ntext\r\nmore')).toBe('<p>crlf<br>text<br>more</p>');
  });

  it('renders headings 1-6 and rejects malformed hashes', () => {
    expect(renderDescription('# H1')).toBe('<h1>H1</h1>');
    expect(renderDescription('###### H6')).toBe('<h6>H6</h6>');
    expect(renderDescription('#nospace')).toBe('<p>#nospace</p>');
    expect(renderDescription('####### H7')).toBe('<p>####### H7</p>');
    expect(renderDescription('##')).toBe('');
  });

  it('renders fenced code blocks without parsing the content', () => {
    const html = renderDescription('```\n**not bold** <script>\n- not a list\n```');
    expect(html).toBe('<pre><code>**not bold** &lt;script&gt;\n- not a list</code></pre>');
    const unclosed = renderDescription('```\nstill code');
    expect(unclosed).toBe('<pre><code>still code</code></pre>');
  });

  it('renders unordered, ordered and nested lists', () => {
    expect(renderDescription('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderDescription('* x\n+ y')).toBe('<ul><li>x</li><li>y</li></ul>');
    expect(renderDescription('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
    expect(renderDescription('- a\n  - b\n- c'))
      .toBe('<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
    expect(renderDescription('- a\n  1. b\n  2. c')).toBe('<ul><li>a<ol><li>b</li><li>c</li></ol></li></ul>');
  });

  it('splits a group when the list type changes', () => {
    expect(renderDescription('- a\n1. b')).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>');
  });

  it('renders task list items as disabled checkboxes', () => {
    expect(renderDescription('- [ ] open\n- [x] done')).toBe(
      '<ul><li><input type="checkbox" disabled> open</li><li><input type="checkbox" disabled checked> done</li></ul>',
    );
    expect(renderDescription('- [X] upper')).toContain('disabled checked');
    expect(renderDescription('- plain')).toBe('<ul><li>plain</li></ul>');
  });

  it('renders blockquotes including nesting and multi-line bodies', () => {
    expect(renderDescription('> quoted')).toBe('<blockquote><p>quoted</p></blockquote>');
    expect(renderDescription('> line one\n> line two')).toBe('<blockquote><p>line one<br>line two</p></blockquote>');
    expect(renderDescription('> outer\n> > inner')).toBe('<blockquote><p>outer</p><blockquote><p>inner</p></blockquote></blockquote>');
  });

  it('renders horizontal rules and rejects lookalikes', () => {
    expect(renderDescription('---')).toBe('<hr>');
    expect(renderDescription('***')).toBe('<hr>');
    expect(renderDescription('___')).toBe('<hr>');
    expect(renderDescription('--')).toBe('<p>--</p>');
    expect(renderDescription('a - b')).toBe('<p>a - b</p>');
  });

  it('renders a mixed document', () => {
    const src = [
      '# Plan',
      '',
      'Intro **bold** and [link](https://x.dev).',
      '',
      '1. first',
      '2. second',
      '',
      '- [ ] todo',
      '  - sub',
      '',
      '> note',
      '',
      '---',
      '',
      'end',
    ].join('\n');
    expect(renderDescription(src)).toBe(
      '<h1>Plan</h1>'
      + '<p>Intro <strong>bold</strong> and <a href="https://x.dev" rel="noopener noreferrer" target="_blank">link</a>.</p>'
      + '<ol><li>first</li><li>second</li></ol>'
      + '<ul><li><input type="checkbox" disabled> todo<ul><li>sub</li></ul></li></ul>'
      + '<blockquote><p>note</p></blockquote>'
      + '<hr>'
      + '<p>end</p>',
    );
  });
});

describe('renderDescription sanitization invariants', () => {
  const hostile = [
    '<script>alert(1)</script>',
    '<SCRIPT SRC="https://evil.example/x.js"></SCRIPT>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="https://evil.example"></object>',
    '<form action="https://evil.example"><input name=q></form>',
    '<a href="javascript:alert(1)">click</a>',
    '<a href="JAVAscript:alert(1)">click</a>',
    '<a href="java\tscript:alert(1)">click</a>',
    '<style>body{display:none}</style>',
    '<div style="background:url(https://evil.example/i.png)">x</div>',
    '<body onload=alert(1)>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '![alt](https://evil.example/i.png)',
    '[a](https://evil.example)',
    '<a href="https://evil.example" onmouseover=alert(1)>x</a>',
    '```<script>alert(1)</script>```',
    '> <script>alert(1)</script>',
    '- <img src=x onerror=alert(1)>',
    '<details open><summary>hi</summary><img src=x onerror=alert(1)></details>',
    '<keygen>',
    '<base href="https://evil.example">',
    '``` \n<script>alert(1)</script>\n```',
  ];

  for (const input of hostile) {
    it(`neutralizes ${JSON.stringify(input.slice(0, 40))}`, () => {
      const html = renderDescription(input);
      const lower = html.toLowerCase();
      expect(lower).not.toContain('<script');
      expect(lower).not.toContain('<iframe');
      expect(lower).not.toContain('<object');
      expect(lower).not.toContain('<form');
      expect(lower).not.toContain('<svg');
      expect(lower).not.toContain('<img');
      expect(lower).not.toContain('<style');
      expect(lower).not.toContain('<meta');
      expect(lower).not.toContain('<base');
      expect(lower).not.toMatch(/href=["']?\s*(javascript|data|vbscript|file):/);
      // Every emitted tag must be whitelisted and carry only whitelisted
      // attributes (escaped source text is inert and may mention anything).
      for (const match of html.matchAll(/<([a-z0-9]+)([^>]*)>/gi)) {
        const tag = match[1]!.toLowerCase();
        const attrs = match[2]!.trim();
        if (tag === 'a') {
          expect(attrs).toMatch(/^href="(https?:\/\/|mailto:)[^"]*" rel="noopener noreferrer" target="_blank"$/);
        } else if (tag === 'input') {
          expect(attrs).toMatch(/^type="checkbox" disabled( checked)?$/);
        } else {
          expect(attrs).toBe('');
        }
      }
    });
  }

  it('emits only whitelisted tags', () => {
    const html = renderDescription('# t\n**b** *i* ~~s~~ `c`\n- [ ] x\n> q\n---\n```\ncode\n```\n[a](https://e.co)\n1. o');
    const tags = [...html.matchAll(/<\/?([a-z0-9]+)[^>]*>/g)].map((m) => m[1]!.toLowerCase());
    const allowed = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote', 'hr', 'input']);
    for (const tag of tags) expect(allowed.has(tag)).toBe(true);
  });

  it('handles a 20k description without escaping characters', () => {
    const src = Array.from({ length: 20000 / 10 }, (_, i) => `line ${i} **bold** <tag>`).join('\n');
    const html = renderDescription(src);
    expect(html).not.toContain('<tag>');
    expect(html).toContain('&lt;tag&gt;');
    expect(html).toContain('<strong>bold</strong>');
  });
});
