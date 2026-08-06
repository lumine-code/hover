# hover.provider

Supplies the documentation shown when the pointer rests on a symbol.

|             |                                                   |
| ----------- | ------------------------------------------------- |
| Version     | `1.0.0`                                           |
| Provided by | `provideHover()` returning one provider           |
| Consumed by | `consumeHover(provider)` returning a `Disposable` |
| Owner       | [`hover`](https://github.com/lumine-code/hover)   |

If your source of documentation is a language server, register an adapter with `ide-client` instead — it already provides this service on every adapter's behalf. Implement this directly only for a source that is not LSP.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "hover.provider": {
      "versions": { "1.0.0": "provideHover" }
    }
  }
}
```

## Contract

```ts
type HoverProvider = {
  hover(editor: TextEditor, position: Point): Promise<Hover | null> | Hover | null;
  hoverGutter?(editor: TextEditor, bufferRow: number): Promise<Hover | null> | Hover | null;
  grammarScopes?: string[] | Set<string>;
  priority?: number;
};

type Hover = {
  contents: { value: string; kind?: "markdown" | "plaintext" } | { element: HTMLElement };
  range?: Range;
};
```

| Member                     | Description                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `hover(editor, position)`  | Required. Return the documentation, or `null` to decline.                                   |
| `hoverGutter(editor, row)` | Optional. Answer for a whole row when the pointer rests on the gutter. See Gutter hovers.   |
| `grammarScopes`            | Scope names you serve. **Omitting it means every grammar.** May be a getter — see Behavior. |
| `priority`                 | Higher is asked first. Defaults to `0`; `ide-client` uses `2`, `linter` uses `100`.         |

The result must carry either `contents.value` or `contents.element` — neither means declining. `range` is what the overlay highlights and what it uses to decide whether the pointer has moved out of the answer.

Return `contents.element` when the answer is not prose. A linter message carries a severity, a rule name and a fix; flattened into markdown all three become text. The tooltip supplies the surface and every rule about when it appears and goes; what stands on it is yours, and its padding is yours too — the popover drops its own for a provided element. The element is dropped with the overlay, so build a fresh one per call and hang nothing off it that needs disposing.

## Gutter hovers

`hover(editor, position)` is asked about a position in the text. Resting the pointer on the **gutter** instead asks `hoverGutter(editor, bufferRow)`, for the sources whose answers belong to a whole line — a diagnostic, a blame line, a fold. A provider without the method is skipped rather than asked with a made-up position.

An answer that omits `range` stands for the whole row, which is usually what you want: the tooltip then survives the pointer travelling from the gutter along the line it describes, and the line is highlighted for as long as it is up.

## Minimal example

```js
module.exports = {
  provideHover() {
    return {
      grammarScopes: ["source.mylang"],
      priority: 1,
      async hover(editor, position) {
        const word = editor.getWordUnderCursor({ position });
        const doc = await lookUp(word);
        if (!doc) return null;
        return {
          contents: { kind: "markdown", value: doc.markdown },
          range: doc.range,
        };
      },
    };
  },
};
```

## Behavior

Providers are sorted by descending `priority` and asked in turn; **the first non-empty answer wins** and the rest are not consulted. Declining is normal — return `null` rather than an empty string.

`grammarScopes` is **read through on every call, never snapshotted**. That is deliberate: a hub provider exposes it as a getter whose value changes as language server sessions come and go. A plain array is fine for a fixed set of grammars, but do not assume the registry cached it.

Two guards protect against stale answers, and both use `range`. An answer whose `range` does not contain the position that was asked about is discarded — the pointer has moved on. And if an overlay is already showing for an intersecting range, nothing is re-rendered. Returning an accurate `range` is therefore what makes hovering feel stable; omitting it makes the overlay flicker.

A provider that throws unmounts the overlay and logs to the console; it does not break the others, but it does end that hover.

## Teardown

`consumeHover` returns a `Disposable` that removes the provider from the registry. Return it from your own consumer method or add it to your collection; nothing else is held on your behalf.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
