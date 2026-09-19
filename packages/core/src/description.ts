/**
 * Safe Markdown-subset renderer for task descriptions (PRD §6.3 "rich
 * description").
 *
 * Security model: the source is plain text. HTML markup in the source is
 * never parsed — it is always escaped and rendered literally. The only HTML
 * this module can emit is a fixed whitelist of tags with a fixed attribute
 * set (`a[href,rel,target]` and disabled checklist checkboxes). Link targets
 * are restricted to `http:`, `https:` and `mailto:`; every other scheme
 * (`javascript:`, `data:`, relative paths, …) is rejected and the whole link
 * construct is rendered as literal text. The renderer is a pure function
 * with no DOM access, so every rendering surface (browser preview, conflict
 * banner, and any future server-side rendering such as export or email)
 * goes through the same safe output.
 *
 * Supported subset:
 *  - headings `#` … `######` (a space is required after the hashes)
 *  - paragraphs; a single line break inside a paragraph renders as `<br>`
 *  - bold `**…**` / `__…__`, italic `*…*` / `_…_` (word-boundary for `_`),
 *    strikethrough `~~…~~`, inline code `` `…` ``
 *  - fenced code blocks ``` ``` ``` (content is never further parsed)
 *  - unordered lists `-` / `*` / `+` and ordered lists `1.` with nesting by
 *    two-space indent (up to four levels)
 *  - task list items `- [ ]` / `- [x]` (rendered as disabled checkboxes)
 *  - blockquotes `>` (nesting allowed)
 *  - horizontal rules `---` / `***` / `___`
 *  - links `[text](https://…)` / `[text](mailto:…)` (opened in a new tab
 *    with `rel="noopener noreferrer"`)
 *
 * Deliberately not supported (rendered literally): images, tables, setext
 * headings, autolinks, reference links, multiline inline code.
 */

const ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPE[ch]!);
}

const MAX_LINK_LENGTH = 2048;

/**
 * Returns an attribute-safe href for `raw`, or null when the URL is not
 * allowed. All ASCII control/whitespace characters are stripped first so
 * scheme tricks such as `java\tscript:` cannot slip past the check.
 */
export function safeHref(raw: string): string | null {
  // Strip ASCII control/whitespace characters (including NUL) before the
  // scheme check so tricks like "java\\tscript:" cannot slip past it.
  let compact = '';
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code > 0x20 && code < 0x7f) compact += ch;
  }
  if (compact.length === 0 || compact.length > MAX_LINK_LENGTH) return null;
  if (/^https?:\/\//i.test(compact) || /^mailto:/i.test(compact)) {
    return escapeHtml(compact);
  }
  return null;
}

/** Renders inline Markdown (no block structure) to safe HTML. */
export function renderInline(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i]!;

    // Inline code: `…` — the first closing backtick ends it, content literal.
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        out += `<code>${escapeHtml(text.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }

    // Link: [text](url) with a single-level label (no nested brackets).
    if (ch === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const label = text.slice(i + 1, closeBracket);
          const href = safeHref(text.slice(closeBracket + 2, closeParen));
          if (href !== null && label !== '') {
            out += `<a href="${href}" rel="noopener noreferrer" target="_blank">${renderInline(label)}</a>`;
            i = closeParen + 1;
            continue;
          }
          // Unusable target or empty label: render the whole construct as
          // literal text rather than guessing.
          out += escapeHtml(text.slice(i, closeParen + 1));
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Bold: **…** or __…__
    const bold = ch === '*' || ch === '_' ? text.slice(i, i + 2) : '';
    if (bold === '**' || bold === '__') {
      const end = text.indexOf(bold, i + 2);
      if (end > i + 2) {
        out += `<strong>${renderInline(text.slice(i + 2, end))}</strong>`;
        i = end + 2;
        continue;
      }
    }

    // Strikethrough: ~~…~~
    if (ch === '~' && text[i + 1] === '~') {
      const end = text.indexOf('~~', i + 2);
      if (end > i + 2) {
        out += `<del>${renderInline(text.slice(i + 2, end))}</del>`;
        i = end + 2;
        continue;
      }
    }

    // Italic: *…* or _…_ (underscore needs a non-word boundary so
    // snake_case identifiers stay literal).
    if (ch === '*' || ch === '_') {
      const prev = i === 0 ? '' : text[i - 1]!;
      const nextChar = text[i + 1] ?? '';
      const end = nextChar !== '' ? text.indexOf(ch, i + 1) : -1;
      const startOk = ch !== '_' || prev === '' || /[^A-Za-z0-9_]/.test(prev);
      const endOk = end === -1 ? false : end === n - 1 || /[^A-Za-z0-9_]/.test(text[end + 1]!) || text[end + 1] === '\n';
      if (end > i + 1 && startOk && endOk) {
        out += `<em>${renderInline(text.slice(i + 1, end))}</em>`;
        i = end + 1;
        continue;
      }
    }

    if (ch === '\n') {
      out += '<br>';
      i += 1;
      continue;
    }

    out += escapeHtml(ch);
    i += 1;
  }
  return out;
}

const HEADING = /^ *(#{1,6}) +(.*)$/;
const HEADING_EMPTY = /^ *#{1,6} *$/;
const HR = /^ *(?:-{3,}|\*{3,}|_{3,}) *$/;
const UL_ITEM = /^(\s*)([-*+]) +(.*)$/;
const OL_ITEM = /^(\s*)(\d{1,9})\. +(.*)$/;
const TASK = /^\[([ xX])\] +(.*)$/;
const QUOTE = /^> ?(.*)$/;
const FENCE = /^ *```/;

interface ListItem { content: string; task: boolean | null; ordered: boolean; children: ListItem[] }

function itemToHtml(item: ListItem): string {
  const checkbox = item.task === null ? '' : `<input type="checkbox" disabled${item.task ? ' checked' : ''}> `;
  let html = `<li>${checkbox}${renderInline(item.content)}`;
  if (item.children.length > 0) {
    const tag = item.children[0]!.ordered ? 'ol' : 'ul';
    html += `<${tag}>${item.children.map((c) => itemToHtml(c)).join('')}</${tag}>`;
  }
  return `${html}</li>`;
}

/** Builds a nested list tree from a consecutive group of list lines. */
function parseListGroup(rows: { indent: number; ordered: boolean; content: string }[]): { ordered: boolean; items: ListItem[] } {
  interface Frame { indent: number; items: ListItem[] }
  const root: ListItem = { content: '', task: null, ordered: rows[0]!.ordered, children: [] };
  const frames: Frame[] = [{ indent: rows[0]!.indent, items: root.children }];

  for (const row of rows) {
    while (frames.length > 1 && row.indent < frames[frames.length - 1]!.indent) {
      frames.pop();
    }
    const frame = frames[frames.length - 1]!;
    const item: ListItem = { content: '', task: null, ordered: row.ordered, children: [] };
    const task = row.content.match(TASK);
    item.content = task ? task[2]! : row.content;
    item.task = task ? task[1]!.toLowerCase() === 'x' : null;
    if (row.indent > frame.indent) {
      const parent = frame.items[frame.items.length - 1];
      if (parent && frames.length < 5) {
        parent.children.push(item);
        // A new frame collects the siblings of the item (its parent's
        // children) at the item's indent.
        frames.push({ indent: row.indent, items: parent.children });
        continue;
      }
    }
    frame.items.push(item);
  }
  return { ordered: rows[0]!.ordered, items: root.children };
}

const isStructural = (line: string): boolean =>
  FENCE.test(line) || HEADING.test(line) || HEADING_EMPTY.test(line) || HR.test(line)
  || QUOTE.test(line) || UL_ITEM.test(line) || OL_ITEM.test(line);

/**
 * Renders a Markdown-subset string to safe HTML (see the module
 * documentation for the supported subset). Empty or whitespace-only input
 * renders to an empty string.
 */
export function renderDescription(source: string): string {
  const text = source.replace(/\r\n?/g, '\n');
  if (text.trim() === '') return '';

  const out: string[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') { i += 1; continue; }

    // Fenced code block; an unclosed fence runs to the end of the input.
    if (FENCE.test(line)) {
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i]!)) { buffer.push(lines[i]!); i += 1; }
      i += 1;
      out.push(`<pre><code>${escapeHtml(buffer.join('\n'))}</code></pre>`);
      continue;
    }

    // Headings.
    if (HEADING_EMPTY.test(line)) { i += 1; continue; }
    const heading = line.match(HEADING);
    if (heading && heading[2]!.trim() !== '') {
      const level = heading[1]!.length;
      out.push(`<h${level}>${renderInline(heading[2]!.trim())}</h${level}>`);
      i += 1;
      continue;
    }
    if (heading) { i += 1; continue; }

    // Horizontal rule.
    if (HR.test(line)) { out.push('<hr>'); i += 1; continue; }

    // Blockquote: group consecutive `>` lines, strip one level, recurse.
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(QUOTE);
        if (!m) break;
        inner.push(m[1]!);
        i += 1;
      }
      out.push(`<blockquote>${renderDescription(inner.join('\n'))}</blockquote>`);
      continue;
    }

    // List group: consecutive item lines of a single list type; a type
    // change (ul -> ol) starts a new list.
    if (UL_ITEM.test(line) || OL_ITEM.test(line)) {
      const rows: { indent: number; ordered: boolean; content: string }[] = [];
      while (i < lines.length) {
        const row = lines[i]!;
        const mU = row.match(UL_ITEM);
        const mO = row.match(OL_ITEM);
        if (!mU && !mO) break;
        const indent = (mU ? mU[1]! : mO![1]!).length;
        const ordered = !!mO;
        // A type change at the same or a shallower indent starts a new
        // list; a deeper indent is a nested list of the other type.
        const prev = rows[rows.length - 1];
        if (prev && ordered !== prev.ordered && indent <= prev.indent) break;
        rows.push({ indent, ordered, content: (mU ? mU[3] : mO![3])! });
        i += 1;
      }
      const list = parseListGroup(rows);
      out.push(`<${list.ordered ? 'ol' : 'ul'}>${list.items.map((it) => itemToHtml(it)).join('')}</${list.ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    // Paragraph: consecutive non-blank, non-structural lines.
    const buffer: string[] = [];
    while (i < lines.length) {
      const row = lines[i]!;
      if (row.trim() === '' || isStructural(row)) break;
      buffer.push(row);
      i += 1;
    }
    if (buffer.length > 0) {
      out.push(`<p>${buffer.map((l) => renderInline(l)).join('<br>')}</p>`);
    }
  }

  return out.join('');
}
