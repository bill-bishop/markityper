# markityper

> **Grapheme-safe, whitespace-aware Markdown “typewriter.”**
> Feed it Markdown text; get a stream of tokens you can render progressively (and safely) while **never inventing closing markers**. Also includes `toClosingTag()` to synthesize temporary HTML closing tags during typing.

* ✅ **Grapheme aware** — uses `Intl.Segmenter` when available (emoji, ZWJ clusters).
* ✅ **Whitespace clumping** — long runs of spaces/tabs/newlines are emitted as a single token.
* ✅ **HTML-aware** — emits `<tag …>` as `open` and `</tag>` as `close` tokens; pair with `toClosingTag`.
* ✅ **Line & inline Markdown** — headings, quotes, lists, fences, `* _ ** `` toggles.
* ✅ **Works great with Angular/React/Vue** — stream into your renderer for buttery “typing” UX.

---

## Install

```bash
npm i markityper
# or
pnpm add markityper
# or
yarn add markityper
```

Works in modern Node and the browser (ESM). If you need CJS, use a bundler or dynamic import.

---

## Quick look

````ts
import { createUnifiedStream } from 'markityper';

const md = '# Hello *world* <b>bold</b>\n\n```js\nconsole.log(1)\n```';

for await (const tok of createUnifiedStream(md)) {
  // tok = { type, kind, value }
  process.stdout.write(tok.value); // prints original text over time
}
````

---

## Why tokens?

When you “type” Markdown (or HTML) character by character, most renderers choke on **temporarily unclosed** structures. `markityper` emits a **unified token stream** so you can:

* Track **`open` / `close`** events for Markdown and HTML.
* **Optionally insert temporary closing markers** (with `toClosingTag` or by mirroring the opening token) while the user is still typing.
* Avoid flicker and invalid markup while still giving that delightful, incremental reveal.

---

## API

### `async function* createUnifiedStream(source: string, options?: Options): AsyncGenerator<Token>`

Emits a unified sequence of **syntax** and **display** tokens.

#### Token

```ts
type Token =
  | { type: 'syntax'; kind: 'line' | 'open' | 'close'; value: string }
  | { type: 'display'; kind: 'default' | 'whitespace'; value: string };
```

* `syntax:line` — line-level markers at **start of line** (ATX headings `# …`, block quotes `> `, list markers, fenced code fences ` `).
* `syntax:open` / `syntax:close` — inline marks (`*`, `_`, `**`, `` ` ``) and HTML tags (`<div …>`, `</div>`).
* `display:default` — a single **grapheme cluster** (emoji-safe).
* `display:whitespace` — a **clumped** run of spaces/tabs/newlines.

> **Guarantee:** If you concatenate every token’s `value` in order, you get **exactly** the original input (no synthetic characters are inserted by the stream).

#### Options

```ts
type Options = {
  /** Include the single trailing space in line syntax tokens (default: true). */
  includeTrailingSpaceInLineSyntax?: boolean;

  /** Reserved for future flags (e.g., GFM tweaks). Currently ignored. */
  // gfm?: boolean;
};
```

### `function toClosingTag(opening: string): string`

Converts an **HTML opening tag** to its bare closing counterpart. Attributes are dropped. Self-closing and already-closed inputs return `''` (no-op) or are passed through appropriately.

```ts
toClosingTag('<div class="plan">')  // -> "</div>"
toClosingTag('<ul>')                // -> "</ul>"
toClosingTag('<br/>')               // -> ""
toClosingTag('</div>')              // -> "</div>"
```

---

## Usage patterns

### 1) Minimal “typewriter” (Node or browser)

```ts
import { createUnifiedStream } from 'markityper';

async function* typewriter(md: string, lps = 30) {
  for await (const t of createUnifiedStream(md)) {
    yield t;
    await new Promise(r => setTimeout(r, (t.value.length / lps) * 1000));
  }
}

for await (const t of typewriter('**Hello** _you_')) {
  // Render t.value or handle by token kind…
}
```

### 2) With RxJS (convert the async generator to an Observable)

```ts
import { from, concatMap, delay, of } from 'rxjs';
import { createUnifiedStream } from 'markityper';

const lps = 20;
const source = async function* () { yield* createUnifiedStream('# Hi'); }();

from(source).pipe(
  concatMap(t =>
    of(t).pipe(delay((t.value.length / lps) * 1000))
  )
).subscribe(t => {
  // Push t.value into your UI
});
```

### 3) Angular example (with `ngx-markdown`)

Here’s a complete Angular component that progressively renders Markdown while keeping structures valid by mirroring opens with temporary closers. It uses `toClosingTag` for HTML tags and mirrors Markdown markers for inline syntax.

```ts
import {
  Component, Input, OnInit, OnDestroy,
  ChangeDetectionStrategy, signal, Output, EventEmitter,
} from '@angular/core';
import { MarkdownComponent } from 'ngx-markdown';
import { createUnifiedStream, toClosingTag } from 'markityper';

@Component({
  selector: 'markityper',
  standalone: true,
  imports: [MarkdownComponent],
  template: `<markdown [data]="typed() + untypedClosingTags.join('')"></markdown>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MarkityperComponent implements OnInit, OnDestroy {
  @Input() text = '';
  @Input() lps = 20;
  @Output() onComplete = new EventEmitter<boolean>();

  untypedClosingTags: string[] = [];
  readonly typed = signal('');

  private cancelled = false;

  async ngOnInit() {
    let buffer = '';

    try {
      for await (const tok of createUnifiedStream(this.text)) {
        if (this.cancelled) return;

        const { type, kind, value } = tok;

        if (type === 'syntax' && kind === 'open') {
          if (/^<.+>$/.test(value)) {
            this.untypedClosingTags.push(toClosingTag(value));
          } else {
            // Mirror markdown marks: *, **, _, `
            this.untypedClosingTags.push(value);
          }
        } else if (type === 'syntax' && kind === 'close') {
          this.untypedClosingTags.pop();
        }

        buffer += value;
        this.typed.set(buffer);

        // pacing (optional)
        await new Promise(r => setTimeout(r, (value.length / this.lps) * 1000));
      }
      this.onComplete.emit(true);
    } catch {
      this.typed.set(this.text); // fallback
      this.onComplete.emit(false);
    }
  }

  ngOnDestroy() { this.cancelled = true; }
}
```

> Note: The example concatenates `typed()` plus the **current stack of temporary closers** (`untypedClosingTags`). Each real `close` pops from the stack, keeping the intermediate markup valid as it types.

---

## What gets recognized?

* **Line syntax (at SOL):**

    * ATX headings `# …` through `###### …` (space required after the hashes)
    * Block quote prefix: `>` (one or more) followed by a space
    * Unordered lists: `- ` / `+ ` / `* `
    * Ordered lists: `1. ` or `1) `
    * Fenced code lines: start with ` ``` ` (opening & closing; everything in between is treated as plain `display`)

* **Inline toggles (outside code):**

    * Emphasis `*`, Strong `**`, Underline `_`, Code `` ` ``

* **HTML tags:**

    * `<tag …>` → `syntax:open`, `</tag>` → `syntax:close`
      Use `toClosingTag(open)` when you want a transient `</tag>` until the real closer arrives.

---

## Design constraints & guarantees

* **No invented characters.** The stream doesn’t fabricate closers. If you need them for intermediate rendering, **you add them** (and remove them later).
* **Round-trip fidelity.** Concatenate every `value` in order and you recover the **exact** original input.
* **Fenced code is sacred.** Once inside a ``` fence, everything is `display` until the closing fence line.
* **Grapheme safety.** Uses `Intl.Segmenter` when present; otherwise falls back to per-code-unit iteration.

---

## FAQ

**Does this parse full GitHub-Flavored Markdown?**
No — this is a **tokenizer for progressive rendering**, not a full parser. It recognizes a practical subset needed to maintain validity while typing.

**Can I feed the stream directly to my Markdown renderer?**
Yes. Many apps just build a string buffer from token `value`s and hand it to their renderer. The **token kinds** give you hooks to maintain temporary closers.

**How do I make it Observable?**
Wrap the async generator with RxJS `from()` and add pacing with `delay`/`concatMap` (see example above).

---

## Performance notes

* Runs in O(n) over the input.
* Grapheme segmentation cost depends on `Intl.Segmenter` availability.
* Whitespace clumping reduces DOM churn during typing.

---

## License

MIT © Bill Bishop

---

## Changelog highlights

* **v0.1.2**

    * Whitespace clumping for both normal flow and fenced code.
    * `toClosingTag()` utility added.
    * HTML `<tag>` emitted as `syntax:open` and `</tag>` as `syntax:close`.
    * Fidelity guarantee clarified: concatenation of `value`s equals original text.
