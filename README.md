# hover

Show documentation tooltips and signature help at the cursor.

Fork of [savetheclocktower/pulsar-hover](https://github.com/savetheclocktower/pulsar-hover).

Hover information comes from the shared context-help registry provided by `documentation-view`; signature help comes from provider packages. Both are shown as overlay decorations in pane editors and registered embedded editors such as notebook cells. The tooltip's Open in Documentation View button keeps the current result in a dock for continued reading.

## Features

- **Hover tooltips**: shows documentation for the symbol under the mouse pointer or the cursor.
- **Every source at once**: stacks what each provider has to say about the position, most important first — a linter message above the documentation, not instead of it.
- **Signature help**: displays the active function signature with the current parameter highlighted while typing arguments.
- **Markdown rendering**: renders provider documentation as sanitized markdown with syntax-highlighted code blocks.
- **Gutter hovers**: answers for a whole line when the pointer rests on the gutter, for sources such as linter messages.
- **Documentation panel**: opens the current tooltip in Documentation View without asking its providers again.
- **Trigger characters**: requests signature help when a provider trigger character is typed and keeps it updated on retrigger characters.
- **Configurable triggers**: trace the mouse pointer, hover on cursor rest, or request help on command, with adjustable show and hide delays.
- **Dismissal**: overlays close on escape, on edits, and once the pointer or the cursor has left the symbol, whether or not it comes to rest.

## Installation

To install `hover` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/hover`.

## Commands

Commands available in `lumine-workspace`:

- `hover:toggle-trace`: turn mouse tracing on or off in this window.

Commands available in `lumine-text-editor`:

- `hover:toggle`: show or hide the hover tooltip at the cursor position,
- `hover:toggle-signature-help`: show or hide the signature help overlay at the cursor position,
- `hover:dismiss`: close any open overlay.

## Usage

Trace follows the mouse pointer and requests documentation when it rests over a symbol. The `hover.trace` setting enables it by default and supplies the initial mode for each window. Use `hover:toggle-trace` to switch the mode in the current window until it reloads; this does not change the saved setting. A later change to `hover.trace` replaces the window's current mode. Switching trace off immediately closes the current hover and cancels pending hover work; switching it on immediately checks the current pointer position without waiting for mouse movement. This applies to the command, icon, and setting changes. Switching trace off leaves signature help open. Cursor-triggered hover and explicit commands remain available independently.

Enable `hover.statusBar` to show an eye icon on the right side of the status bar; it is hidden by default. The icon indicates the current trace mode and switches it when clicked.

Both overlays prefer the space above the source line when opening and fall back when window edges or other overlays leave too little room. The chosen side stays fixed while the overlay is open; reopening evaluates the available space again. A wheel gesture closes the panel unless the pointer is over a panel with scrollable content. Scrollable content keeps wheel events inside its panel, including at the beginning and end. A panel without scrollable content lets the wheel reach the editor as it closes. Wheel gestures reaching the source editor also cancel pending hover requests, even when the editor cannot scroll further.

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

- `context-help.registry`: consumed to request and render documentation and other help for a buffer position.
- `context-help.panel`: consumed to open the current tooltip result in Documentation View.
- [`hover.signature-provider`](docs/hover.signature-provider.md): consumed to request signature help while typing function arguments.
- `status-bar`: consumed to show the optional trace mode indicator and switch.
- `background-tips.provider`: provided to teach hover documentation and signature help.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
