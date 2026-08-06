# hover

Show documentation tooltips and signature help at the cursor.

Hover information and signature help come from provider packages — typically language-server backends — and are shown as overlay decorations right in the text editor.

## Features

- **Hover tooltips**: shows documentation for the symbol under the mouse pointer or the cursor.
- **Every source at once**: stacks what each provider has to say about the position, most important first — a linter message above the documentation, not instead of it.
- **Signature help**: displays the active function signature with the current parameter highlighted while typing arguments.
- **Markdown rendering**: renders provider documentation as sanitized markdown with syntax-highlighted code blocks.
- **Gutter hovers**: answers for a whole line when the pointer rests on the gutter, for sources such as linter messages.
- **Provider-built content**: mounts an element a provider composed itself when its answer is not prose.
- **Trigger characters**: requests signature help when a provider trigger character is typed and keeps it updated on retrigger characters.
- **Configurable triggers**: hover on mouse rest, on cursor rest, or on command only, with adjustable show and hide delays.
- **Dismissal**: overlays close on escape, on edits, and once the pointer or the cursor has left the symbol, whether or not it comes to rest.

## Installation

To install `hover` search for _hover_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/hover`.

## Commands

Commands available in `atom-text-editor`:

- `hover:toggle`: show or hide the hover tooltip at the cursor position,
- `hover:toggle-signature-help`: show or hide the signature help overlay at the cursor position,
- `hover:dismiss`: close any open overlay.

## Customization

The overlay appearance can be tweaked from your `styles.css`:

```css
.hover-overlay-view-container {
  max-height: 500px;
  .hover-active-parameter {
    color: var(--text-color-highlight);
  }
}
```

## Services

- **[hover.provider](docs/hover.provider.md)** (`^1.0.0`): consumed to request documentation for a buffer position from providers such as IDE backend packages.
- **[hover.signature-provider](docs/hover.signature-provider.md)** (`^1.0.0`): consumed to request signature help while typing function arguments.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
