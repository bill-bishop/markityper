#!/usr/bin/env node
/**
 * markityper unified stream (v0.1.2)
 * Emits a stream of:
 *   - { type: "syntax", kind: "line" | "open" | "close", value }
 *   - { type: "display", value }   // graphemes or clumped whitespace
 *
 * NOTE: No synthetic closers are ever emitted. Output is a verbatim
 * decomposition of the input, so concatenating all `value`s === original text.
 */

const HAS_SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';

function* graphemes(str) {
    if (HAS_SEGMENTER) {
        const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
        for (const { segment } of seg.segment(str)) yield segment;
    } else {
        for (const ch of str) yield ch; // fallback
    }
}

const isWS = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
function readWS(src, i) {
    let j = i;
    while (j < src.length && isWS(src[j])) j++;
    return j - i; // length of whitespace run
}

/**
 * Convert an HTML opening tag into its corresponding closing tag.
 * Drops attributes, handles stray whitespace, and ignores already-closed tags.
 *
 * Examples:
 *   toClosingTag('<div class="plan">')  -> '</div>'
 *   toClosingTag('<ul>')                -> '</ul>'
 *   toClosingTag('<br/>')               -> ''   (self-closing tag)
 *   toClosingTag('</div>')              -> '</div>' (unchanged)
 */
export function toClosingTag(opening) {
    if (typeof opening !== 'string') return '';

    const s = opening.trim();

    // ignore empty or self-closing tags
    if (!s.startsWith('<') || !s.endsWith('>')) return '';
    if (s.startsWith('</') || s.endsWith('/>')) return '';

    // extract the tag name right after '<'
    const m = /^<\s*([a-zA-Z0-9:-]+)/.exec(s);
    if (!m) return '';

    const tag = m[1];
    return `</${tag}>`;
}


/** Line-level recognizer at start-of-line */
function matchLineSyntax(src, i) {
    // ATX headings with required trailing space
    if (src.startsWith('######', i) && src[i + 6] === ' ') return { value: '###### ', len: 7 };
    if (src.startsWith('#####',  i) && src[i + 5] === ' ') return { value: '##### ',  len: 6 };
    if (src.startsWith('####',   i) && src[i + 4] === ' ') return { value: '#### ',   len: 5 };
    if (src.startsWith('###',    i) && src[i + 3] === ' ') return { value: '### ',    len: 4 };
    if (src.startsWith('##',     i) && src[i + 2] === ' ') return { value: '## ',     len: 3 };
    if (src.startsWith('#',      i) && src[i + 1] === ' ') return { value: '# ',      len: 2 };

    // Block quote: one or more '>' then a space
    if (src[i] === '>') {
        let j = i;
        while (src[j] === '>') j++;
        if (src[j] === ' ') return { value: src.slice(i, j + 1), len: j - i + 1 };
    }

    // Unordered list markers
    if ((src[i] === '-' || src[i] === '+' || src[i] === '*') && src[i + 1] === ' ')
        return { value: src.slice(i, i + 2), len: 2 };

    // Ordered list: digits then '.' or ')' then space
    if (/\d/.test(src[i])) {
        let j = i;
        while (/\d/.test(src[j])) j++;
        if ((src[j] === '.' || src[j] === ')') && src[j + 1] === ' ')
            return { value: src.slice(i, j + 2), len: j - i + 2 };
    }

    // Fenced code (open/close): a line starting with ```
    if (src.startsWith('```', i)) {
        // capture the whole fence line (including optional info string and newline)
        let j = i + 3;
        while (src[j] && src[j] !== '\n') j++;
        const value = src.slice(i, j) + (src[j] === '\n' ? '\n' : '');
        return { value, len: value.length, isFence: true };
    }

    return null;
}

const Mark = { STRONG: 'strong', EM: 'em', UNDER: 'underline', CODE: 'code' };
function closeFor(kind) {
    return kind === Mark.STRONG ? '**'
        : kind === Mark.EM     ? '*'
            : kind === Mark.UNDER  ? '_'
                : kind === Mark.CODE   ? '`'
                    : '';
}

/**
 * Unified token stream.
 * Options:
 *   includeTrailingSpaceInLineSyntax: boolean (default true)
 */
async function* createUnifiedStreamSync(src, opts = {}) {
    const includeSpace = opts.includeTrailingSpaceInLineSyntax ?? true;
    const stack = []; // inline mark stack (does not include fenced-code state)
    let i = 0;
    let inFence = false; // track fenced code blocks separately

    const atLineStart = (pos) => pos === 0 || src[pos - 1] === '\n';

    while (i < src.length) {
        const ch = src[i];
        const next = src[i + 1];
        const atSOL = atLineStart(i);
        const inInlineCode = stack[stack.length - 1] === Mark.CODE;

        // 1) Fenced code open/close (line syntax)
        if (atSOL) {
            const m = matchLineSyntax(src, i);
            if (m && m.isFence) {
                // toggle fenced state purely via line tokens
                inFence = !inFence;
                yield { type: 'syntax', kind: 'line', value: m.value };
                i += m.len;
                continue;
            }
            if (!inFence && m) {
                // normal line markers; optionally include trailing space
                const value = includeSpace ? m.value : m.value.replace(/ $/, '');
                yield { type: 'syntax', kind: 'line', value };
                i += value.length;
                // if we trimmed the space, let the next loop emit it as display
                continue;
            }
        }

        // 2) Inside fenced code: everything is plain display until the closing fence
        if (inFence) {
            // --- NEW: clump whitespace ---
            if (isWS(ch)) {
                const len = readWS(src, i);
                const run = src.slice(i, i + len);
                yield { type: 'display', kind: 'whitespace', value: run };
                i += len;
                continue;
            }
            // otherwise emit next grapheme
            const g = [...graphemes(src.slice(i))][0];
            yield { type: 'display', kind: 'default', value: g };
            i += g.length;
            continue;
        }

        // 2.5) HTML tags (outside code contexts): emit as syntax open/close
        if (!inInlineCode && ch === '<') {
            const closeIdx = src.indexOf('>', i + 1);
            if (closeIdx !== -1) {
                const tagText = src.slice(i, closeIdx + 1);
                // very light check: if it starts with "</" it's a close; if it ends with "/>" treat as 'open'
                const isClose = tagText.startsWith('</');
                yield { type: 'syntax', kind: isClose ? 'close' : 'open', value: tagText };
                i = closeIdx + 1;
                continue;
            }
            // if no '>', fall through and treat '<' as display
        }

        // 3) Inline marks outside inline code (and not in fence)
        if (!inInlineCode) {
            // Strong ** open/close (check before single *)
            if (ch === '*' && next === '*') {
                if (stack[stack.length - 1] === Mark.STRONG) {
                    stack.pop();
                    yield { type: 'syntax', kind: 'close', value: '**' };
                } else {
                    stack.push(Mark.STRONG);
                    yield { type: 'syntax', kind: 'open', value: '**' };
                }
                i += 2;
                continue;
            }
            // Em *
            if (ch === '*' && next !== '*') {
                if (stack[stack.length - 1] === Mark.EM) {
                    stack.pop();
                    yield { type: 'syntax', kind: 'close', value: '*' };
                } else {
                    stack.push(Mark.EM);
                    yield { type: 'syntax', kind: 'open', value: '*' };
                }
                i += 1;
                continue;
            }
            // Underline _
            if (ch === '_') {
                if (stack[stack.length - 1] === Mark.UNDER) {
                    stack.pop();
                    yield { type: 'syntax', kind: 'close', value: '_' };
                } else {
                    stack.push(Mark.UNDER);
                    yield { type: 'syntax', kind: 'open', value: '_' };
                }
                i += 1;
                continue;
            }
            // Inline code `
            if (ch === '`') {
                if (stack[stack.length - 1] === Mark.CODE) {
                    stack.pop();
                    yield { type: 'syntax', kind: 'close', value: '`' };
                } else {
                    stack.push(Mark.CODE);
                    yield { type: 'syntax', kind: 'open', value: '`' };
                }
                i += 1;
                continue;
            }
        } else {
            // Currently inside inline code: only backtick toggles; others display
            if (ch === '`') {
                stack.pop(); // close inline code
                yield { type: 'syntax', kind: 'close', value: '`' };
                i += 1;
                continue;
            }
        }

        // 4) Default display:
        // --- NEW: clump whitespace first ---
        if (isWS(ch)) {
            const len = readWS(src, i);
            const run = src.slice(i, i + len);
            yield { type: 'display', kind: 'whitespace', value: run };
            i += len;
            continue;
        }

        // otherwise emit one grapheme
        const g = [...graphemes(src.slice(i))][0];
        yield { type: 'display', kind: 'default', value: g };
        i += g.length;
    }
}

// index.cjs or index.mjs (whichever you export)
export async function* createUnifiedStream(src, options = {}) {
    // turn sync → async without changing consumers
    for await (const tok of createUnifiedStreamSync(src, options)) {
        yield tok; // async generator can yield sync values fine
    }
}
