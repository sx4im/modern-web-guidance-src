export interface ScriptBlock {
  readonly virtualPath: string;
  readonly blankedContent: string;
}

const NON_JS_SCRIPT_TYPES: ReadonlySet<string> = new Set([
  'text/template',
  'text/html',
  'text/x-template',
  'text/x-handlebars-template',
  'application/json',
  'application/ld+json',
  'importmap',
  'speculationrules',
]);

const SCRIPT_TAG_REGEX = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const STYLE_TAG_REGEX = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
const ASTRO_FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;
const TAG_ATTR_REGEX = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/**
 * Replaces characters in specified index ranges with spaces, preserving all newlines.
 */
export function blankRanges(
  content: string,
  ranges: readonly { start: number; end: number }[],
): string {
  if (ranges.length === 0) {
    return content;
  }

  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let result = '';
  let lastIndex = 0;

  for (const { start, end } of sorted) {
    if (start > lastIndex) {
      result += content.slice(lastIndex, start);
    }
    const clampedStart = Math.max(lastIndex, start);
    if (end > clampedStart) {
      result += content.slice(clampedStart, end).replace(/[^\r\n]/g, ' ');
    }
    lastIndex = Math.max(lastIndex, end);
  }

  if (lastIndex < content.length) {
    result += content.slice(lastIndex);
  }

  return result;
}

/**
 * Preserves characters within [startOffset, endOffset) and replaces all characters
 * outside this range with spaces (preserving all \r and \n).
 */
export function blankOutsideRange(
  content: string,
  startOffset: number,
  endOffset: number,
): string {
  const ranges: { start: number; end: number }[] = [];
  if (startOffset > 0) {
    ranges.push({ start: 0, end: startOffset });
  }
  if (endOffset < content.length) {
    ranges.push({ start: endOffset, end: content.length });
  }
  return blankRanges(content, ranges);
}

/**
 * Extracts a map of lowercase attribute names to attribute values from a tag attribute string.
 */
function parseTagAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of attrString.matchAll(TAG_ATTR_REGEX)) {
    const name = match[1]?.toLowerCase();
    if (name) {
      attrs[name] = match[2] ?? match[3] ?? match[4] ?? '';
    }
  }
  return attrs;
}

/**
 * Determines virtual TypeScript/JavaScript path based on script tag attributes.
 */
function determineScriptVirtualPath(
  relPath: string,
  attrs: Record<string, string>,
  blockIndex = 0,
): string {
  const lang = attrs.lang?.toLowerCase();
  let ext = '.js';
  if (lang === 'ts' || lang === 'typescript') {
    ext = '.ts';
  } else if (lang === 'tsx') {
    ext = '.tsx';
  } else if (lang === 'jsx') {
    ext = '.jsx';
  } else if (relPath.endsWith('.ts') || relPath.endsWith('.mts')) {
    return blockIndex > 0 ? `${relPath}.block${blockIndex}.ts` : relPath;
  }
  return blockIndex > 0 ? `${relPath}.block${blockIndex}${ext}` : `${relPath}${ext}`;
}

/**
 * Determines whether a script tag should be skipped (e.g. template or empty external script).
 */
function shouldSkipScript(attrs: Record<string, string>, body: string): boolean {
  const type = attrs.type?.toLowerCase();
  return Boolean(
    (type && NON_JS_SCRIPT_TYPES.has(type)) || (attrs.src && body.trim().length === 0),
  );
}

/**
 * Extracts script blocks from HTML, Vue, Svelte, and Astro files as blanked virtual files.
 */
export function extractScriptBlocks(
  relPath: string,
  content: string,
): readonly ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  const lowerPath = relPath.toLowerCase();

  // Astro frontmatter fence (--- ... ---)
  if (lowerPath.endsWith('.astro')) {
    const fmMatch = ASTRO_FRONTMATTER_REGEX.exec(content);
    if (fmMatch && fmMatch[1]) {
      const firstNewline = content.indexOf('\n');
      const startOffset = firstNewline !== -1 ? firstNewline + 1 : 4;
      const endOffset = startOffset + fmMatch[1].length;
      if (endOffset > startOffset) {
        blocks.push({
          virtualPath: `${relPath}.ts`,
          blankedContent: blankOutsideRange(content, startOffset, endOffset),
        });
      }
    }
  }

  for (const match of content.matchAll(SCRIPT_TAG_REGEX)) {
    const attrStr = match[1] ?? '';
    const body = match[2] ?? '';
    const attrs = parseTagAttributes(attrStr);

    if (!shouldSkipScript(attrs, body) && body.trim().length > 0 && match.index !== undefined) {
      const openTagLen = match[0].indexOf('>') + 1;
      const startOffset = match.index + openTagLen;
      const endOffset = startOffset + body.length;
      const virtualPath = determineScriptVirtualPath(relPath, attrs, blocks.length);

      blocks.push({
        virtualPath,
        blankedContent: blankOutsideRange(content, startOffset, endOffset),
      });
    }
  }

  return blocks;
}

/**
 * Sanitizes template expressions (${...}) in Lit css template literals
 * by replacing non-newline characters with '_' to ensure CSS parseability.
 */
function sanitizeLitExpressions(rawSlice: string): string {
  let result = '';
  let i = 0;
  const len = rawSlice.length;

  while (i < len) {
    if (rawSlice[i] === '$' && rawSlice[i + 1] === '{') {
      result += '__';
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        const ch = rawSlice[i];
        if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
        }
        result += ch === '\n' || ch === '\r' ? ch : '_';
        i++;
      }
      continue;
    }
    result += rawSlice[i];
    i++;
  }

  return result;
}

/**
 * Extracts Lit css`...` tagged template literal blocks from JS/TS content.
 */
function extractLitCssBlocks(content: string): readonly string[] {
  const blocks: string[] = [];

  for (const match of content.matchAll(/\bcss\s*`/g)) {
    if (match.index === undefined) {
      continue;
    }
    const openQuote = match.index + match[0].indexOf('`');
    let i = openQuote + 1;
    let depth = 0;
    let closeQuote = -1;

    while (i < content.length) {
      const ch = content[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '$' && content[i + 1] === '{') {
        depth++;
        i += 2;
        continue;
      }
      if (ch === '}' && depth > 0) {
        depth--;
        i++;
        continue;
      }
      if (ch === '`' && depth === 0) {
        closeQuote = i;
        break;
      }
      i++;
    }

    if (closeQuote !== -1) {
      const rawSlice = content.slice(openQuote + 1, closeQuote);
      if (rawSlice.trim().length > 0) {
        const sanitizedSlice = sanitizeLitExpressions(rawSlice);
        const reconstructed =
          content.slice(0, openQuote + 1) +
          sanitizedSlice +
          content.slice(closeQuote);
        blocks.push(blankOutsideRange(reconstructed, openQuote + 1, closeQuote));
      }
    }
  }

  return blocks;
}

export function isMarkupPath(relPath: string): boolean {
  const lowerPath = relPath.toLowerCase();
  return (
    lowerPath.endsWith('.html') ||
    lowerPath.endsWith('.htm') ||
    lowerPath.endsWith('.php') ||
    lowerPath.endsWith('.vue') ||
    lowerPath.endsWith('.svelte') ||
    lowerPath.endsWith('.astro')
  );
}

/**
 * Blanks `//` single-line comments (SCSS-style) by replacing their characters
 * with spaces, preserving newlines so line/column offsets are unchanged.
 * Skips `//` inside strings, inside block comments, and after `:` (e.g. the
 * `//` in `https://` URLs).
 */
export function blankLineComments(content: string): string {
  const chars = content.split('');
  const len = chars.length;
  let i = 0;

  while (i < len) {
    const ch = chars[i];

    // Quoted strings: leave their contents untouched.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < len) {
        const c = chars[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        // An unterminated string ends at the newline in CSS/SCSS.
        if (c === '\n') break;
        i++;
      }
      continue;
    }

    // Block comments: leave them untouched (a `//` inside one must not
    // blank away the closing `*/` on the same line).
    if (ch === '/' && chars[i + 1] === '*') {
      i += 2;
      while (i < len && !(chars[i] === '*' && chars[i + 1] === '/')) {
        i++;
      }
      i += 2;
      continue;
    }

    // A `//` line comment, unless it is the `//` of a `://` URL.
    if (ch === '/' && chars[i + 1] === '/' && chars[i - 1] !== ':') {
      while (i < len && chars[i] !== '\n' && chars[i] !== '\r') {
        chars[i] = ' ';
        i++;
      }
      continue;
    }

    i++;
  }

  return chars.join('');
}

/**
 * Extracts style blocks from HTML, Vue, Svelte, and Astro files,
 * or Lit css`...` tagged template literals from JS/TS files.
 */
export function extractStyleBlocks(relPath: string, content: string): readonly string[] {
  if (!isMarkupPath(relPath)) {
    return content.includes('css`') ? extractLitCssBlocks(content) : [];
  }

  const blocks: string[] = [];
  for (const match of content.matchAll(STYLE_TAG_REGEX)) {
    const attrStr = match[1] ?? '';
    const body = match[2] ?? '';
    if (body.trim().length > 0 && match.index !== undefined) {
      const openTagLen = match[0].indexOf('>') + 1;
      const startOffset = match.index + openTagLen;
      const endOffset = startOffset + body.length;
      const blanked = blankOutsideRange(content, startOffset, endOffset);
      // cssomnom parses standard CSS, so a `//` line comment inside a
      // `<style lang="scss">` block would attach to the next rule's selector
      // and silently drop that rule. Blank the comments (offsets preserved)
      // so the rules underneath stay scannable.
      const attrs = parseTagAttributes(attrStr);
      blocks.push(
        attrs.lang?.toLowerCase() === 'scss' ? blankLineComments(blanked) : blanked,
      );
    }
  }

  return blocks;
}

function findTagRanges(content: string, regex: RegExp): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const match of content.matchAll(regex)) {
    if (match.index !== undefined) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges;
}

const VUE_TEMPLATE_TAG_REGEX = /<\/?template\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;

/**
 * Prepares HTML content for DOM scanning by blanking out non-DOM blocks (scripts, styles)
 * and blanking all <template> tags in Vue SFCs so inner DOM elements remain attached in linkedom.
 */
export function prepareHtmlForDomScan(relPath: string, content: string): string {
  const lowerPath = relPath.toLowerCase();
  if (
    !lowerPath.endsWith('.vue') &&
    !lowerPath.endsWith('.svelte') &&
    !lowerPath.endsWith('.astro')
  ) {
    return content;
  }

  const rangesToBlank: { start: number; end: number }[] = [
    ...findTagRanges(content, SCRIPT_TAG_REGEX),
    ...findTagRanges(content, STYLE_TAG_REGEX),
  ];

  if (lowerPath.endsWith('.vue')) {
    rangesToBlank.push(...findTagRanges(content, VUE_TEMPLATE_TAG_REGEX));
  } else if (lowerPath.endsWith('.astro')) {
    const fmMatch = ASTRO_FRONTMATTER_REGEX.exec(content);
    if (fmMatch) {
      rangesToBlank.push({ start: 0, end: fmMatch[0].length });
    }
  }

  return blankRanges(content, rangesToBlank);
}
