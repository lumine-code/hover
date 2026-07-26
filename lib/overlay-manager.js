const { CompositeDisposable, Disposable, Range } = require("atom");
const ProviderRegistry = require("./provider-registry");
const { renderHoverContent, renderSignatureContent } = require("./render");

// `SignatureHelpTriggerKind` from the LSP specification.
const TRIGGER_KIND_INVOKED = 1;
const TRIGGER_KIND_TRIGGER_CHARACTER = 2;

// A cancellable deferred call; each `schedule` supersedes the previous one.
class Timer {
  constructor(handler, duration) {
    this.handler = handler;
    this.duration = duration;
    this.timeout = null;
  }

  schedule(...args) {
    this.unschedule();
    this.timeout = setTimeout(() => {
      this.timeout = null;
      this.handler(...args);
    }, this.duration);
  }

  unschedule() {
    if (this.timeout === null) return;
    clearTimeout(this.timeout);
    this.timeout = null;
  }

  dispose() {
    this.unschedule();
  }
}

// Whether a cursor position change looks like the cursor skipping over the
// closing half of a typing pair (bracket-matcher moves the cursor instead of
// inserting the character, but signature help should still see a keystroke).
function isTypingPairSkip(event) {
  const { newBufferPosition: newPos, oldBufferPosition: oldPos } = event;
  if (newPos.row !== oldPos.row) return false;
  if (oldPos.column + 1 !== newPos.column) return false;
  const text = event.cursor.editor.getTextInBufferRange(new Range(oldPos, newPos));
  return /[\])}>'"]/.test(text);
}

// Tracks the focused editor and drives the hover tooltip and signature help
// overlays: both are overlay decorations anchored at the trigger position.
module.exports = class OverlayManager {
  constructor() {
    this.subscriptions = new CompositeDisposable();
    this.hoverRegistry = new ProviderRegistry();
    this.signatureRegistry = new ProviderRegistry();
    this.watchedEditors = new WeakSet();

    this.editor = null;
    this.editorView = null;
    this.editorSubscriptions = null;
    this.overlayDisposables = null;

    this.currentMarkerRange = null;
    this.currentOverlayType = null;

    this.showOnCursorMove = false;
    this.showOnMouseMove = true;
    this.showSignatureWhileTyping = true;
    this.hoverTime = atom.config.get("hover.hoverTime") ?? 250;

    this.onMouseMove = (event) => this.mouseMoveTimer.schedule(event);
    this.createTimers();

    this.subscriptions.add(
      atom.config.observe("hover.hoverTime", (value) => {
        this.hoverTime = value;
        this.createTimers();
      }),
      atom.config.observe("hover.showOnCursorMove", (value) => {
        this.showOnCursorMove = value;
      }),
      atom.config.observe("hover.showOnMouseMove", (value) => {
        this.showOnMouseMove = value;
        this.rewatchCurrentEditor();
      }),
      atom.config.observe("hover.showSignatureWhileTyping", (value) => {
        this.showSignatureWhileTyping = value;
      }),
      atom.workspace.observeTextEditors((editor) => {
        const disposable = this.watchEditor(editor);
        if (disposable) editor.onDidDestroy(() => disposable.dispose());
      }),
      atom.commands.add("atom-text-editor", {
        "hover:toggle": (event) => this.toggleHover(event),
        "hover:toggle-signature-help": (event) => this.toggleSignatureHelp(event),
        "hover:dismiss": () => this.unmountOverlay(),
      }),
    );
  }

  dispose() {
    this.unmountOverlay();
    this.mouseMoveTimer.dispose();
    this.cursorMoveTimer.dispose();
    this.editorSubscriptions?.dispose();
    this.editorSubscriptions = null;
    this.subscriptions.dispose();
  }

  createTimers() {
    this.mouseMoveTimer?.dispose();
    this.mouseMoveTimer = new Timer((event) => this.onMouseRemain(event), this.hoverTime);
    this.cursorMoveTimer?.dispose();
    this.cursorMoveTimer = new Timer((event) => this.onCursorRemain(event), this.hoverTime);
  }

  watchEditor(editor) {
    if (this.watchedEditors.has(editor)) return null;

    const editorView = atom.views.getView(editor);
    if (editorView.hasFocus()) this.updateCurrentEditor(editor);

    const focusListener = () => this.updateCurrentEditor(editor);
    editorView.addEventListener("focus", focusListener);

    const disposable = new Disposable(() => {
      editorView.removeEventListener("focus", focusListener);
      if (this.editor === editor) this.updateCurrentEditor(null);
    });
    this.watchedEditors.add(editor);
    this.subscriptions.add(disposable);

    return new Disposable(() => {
      disposable.dispose();
      this.subscriptions.remove(disposable);
      this.watchedEditors.delete(editor);
    });
  }

  // Re-subscribes to the current editor, e.g. after a setting flipped.
  rewatchCurrentEditor() {
    const editor = this.editor;
    this.editor = null;
    this.updateCurrentEditor(editor);
  }

  updateCurrentEditor(editor) {
    if (editor === this.editor) return;
    this.editorSubscriptions?.dispose();
    this.editorSubscriptions = null;
    this.unmountOverlay();
    this.editor = null;
    this.editorView = null;

    if (!editor || !atom.workspace.isTextEditor(editor)) return;
    this.editor = editor;
    this.editorView = atom.views.getView(editor);
    this.editorSubscriptions = new CompositeDisposable();

    if (this.showOnMouseMove) {
      const view = this.editorView;
      view.addEventListener("mousemove", this.onMouseMove);
      this.editorSubscriptions.add(
        new Disposable(() => view.removeEventListener("mousemove", this.onMouseMove)),
      );
    }
    this.editorSubscriptions.add(
      editor.onDidChangeCursorPosition((event) => this.handleCursorMove(event)),
      editor.getBuffer().onDidChangeText((event) => this.handleTextChange(event, editor)),
    );
  }

  handleTextChange(event, editor) {
    if (event.changes.length === 0) return;
    if (this.currentOverlayType === "hover") this.unmountOverlay();
    if (this.showSignatureWhileTyping) this.checkSignatureTrigger(event, editor);
  }

  handleCursorMove(event) {
    if (this.showSignatureWhileTyping) this.checkSignatureCursorMove(event);
    this.cursorMoveTimer.schedule(event);
  }

  // Signature-help bookkeeping on cursor movement: leaving the row dismisses
  // the overlay, and a typing-pair skip counts as a typed character.
  checkSignatureCursorMove(event) {
    if (event.textChanged) return;
    if (!isTypingPairSkip(event)) {
      if (
        this.currentOverlayType === "signature-help" &&
        event.newScreenPosition.row !== event.oldScreenPosition.row
      ) {
        this.unmountOverlay();
      }
      return;
    }
    const newRange = new Range(event.oldBufferPosition, event.newBufferPosition);
    this.checkSignatureTrigger(
      {
        changes: [
          {
            newRange,
            oldRange: new Range(event.oldBufferPosition, event.oldBufferPosition),
            oldText: "",
            newText: event.cursor.editor.getTextInBufferRange(newRange),
          },
        ],
      },
      event.cursor.editor,
    );
  }

  // Requests signature help when the last keystroke was one of the provider's
  // trigger characters, or a retrigger character while the overlay is open.
  // The trigger sets are read through provider getters on every keystroke:
  // they reflect live language server sessions, which come and go.
  async checkSignatureTrigger(event, editor) {
    const changes = event.changes.filter((change) => change.oldText !== change.newText);
    if (changes.length !== 1) return;
    const [change] = changes;

    // Autocomplete may leave a selection; its start is the effective cursor.
    const cursorPosition = editor.getSelectedBufferRange().start;
    if (
      change.newText.length === 0 ||
      change.newRange.start.row !== change.newRange.end.row ||
      !change.newRange.containsPoint(cursorPosition)
    ) {
      if (this.currentOverlayType === "signature-help") this.unmountOverlay();
      return;
    }

    const provider = this.signatureRegistry.getProviderForEditor(editor);
    if (!provider) return;

    const index = Math.max(0, cursorPosition.column - change.newRange.start.column - 1);
    const character = change.newText[index];
    const alreadyOpen = this.currentOverlayType === "signature-help";
    const isTrigger = provider.triggerCharacters?.has(character) === true;
    const isRetrigger = alreadyOpen && provider.retriggerCharacters?.has(character) === true;
    if (!isTrigger && !isRetrigger) return;

    await this.showSignatureHelp(provider, editor, cursorPosition, {
      triggerKind: TRIGGER_KIND_TRIGGER_CHARACTER,
      triggerCharacter: character,
      isRetrigger: alreadyOpen,
    });
  }

  // Runs once the mouse pointer has rested in one place for `hoverTime`.
  async onMouseRemain(event) {
    if (!this.editor || !this.editorView) return;
    const component = this.editorView.getComponent();
    const screenPosition = component.screenPositionForMouseEvent(event);
    const mouse = component.pixelPositionForMouseEvent(event);
    const screen = component.pixelPositionForScreenPosition(screenPosition);

    // Ignore pointer positions far away from any text on the row.
    if (Math.abs(mouse.left - screen.left) >= this.editor.getDefaultCharWidth()) {
      if (this.currentOverlayType === "hover") this.unmountOverlay();
      return;
    }

    const point = this.editor.bufferPositionForScreenPosition(screenPosition);
    if (!this.currentMarkerRange?.containsPoint(point)) {
      await this.showHoverOverlay(this.editor, point);
    }
  }

  // Runs once the cursor has rested in one place for `hoverTime`.
  async onCursorRemain(event) {
    if (event.textChanged) return;
    if (this.currentOverlayType === "signature-help") return;
    const position = event.cursor.getBufferPosition();
    if (this.currentMarkerRange?.containsPoint(position)) return;
    if (this.showOnCursorMove) {
      await this.showHoverOverlay(event.cursor.editor, position);
    } else if (this.currentOverlayType === "hover") {
      // The cursor left the hovered symbol; retire the tooltip.
      this.unmountOverlay();
    }
  }

  async toggleHover(event) {
    const editor = event.currentTarget.getModel();
    if (!atom.workspace.isTextEditor(editor)) return;
    const position = editor.getCursorBufferPosition();
    if (this.currentMarkerRange?.containsPoint(position)) return this.unmountOverlay();
    await this.showHoverOverlay(editor, position);
  }

  async toggleSignatureHelp(event) {
    const editor = event.currentTarget.getModel();
    if (!atom.workspace.isTextEditor(editor)) return;
    // The overlay position is not tied to a provider range, so the command
    // simply closes an open overlay and requests a fresh one otherwise.
    if (this.currentOverlayType === "signature-help") return this.unmountOverlay();
    const provider = this.signatureRegistry.getProviderForEditor(editor);
    if (!provider) return;
    await this.showSignatureHelp(provider, editor, editor.getCursorBufferPosition(), {
      triggerKind: TRIGGER_KIND_INVOKED,
      isRetrigger: false,
    });
  }

  // Asks the hover providers for information at the position and mounts the
  // first non-empty answer.
  async showHoverOverlay(editor, position) {
    try {
      let result = null;
      for (const provider of this.hoverRegistry.getAllProvidersForEditor(editor)) {
        result = await provider.hover(editor, position);
        if (result) break;
      }
      if (!result?.contents?.value) {
        if (this.currentOverlayType === "hover") this.unmountOverlay();
        return;
      }

      const range = result.range ? Range.fromObject(result.range) : null;
      // An overlay already covering the reported range needs no update.
      if (this.currentMarkerRange && range?.intersectsWith(this.currentMarkerRange)) return;
      // A stale answer for a position we already left is not shown.
      if (range && !range.containsPoint(position)) return;

      const element = await renderHoverContent(result.contents);
      if (!element) return;

      this.unmountOverlay();
      this.currentMarkerRange = range ?? new Range(position, position);
      this.mountOverlay(editor, this.currentMarkerRange, position, element, {
        type: "hover",
        highlight: true,
      });
    } catch (error) {
      this.unmountOverlay();
      console.error(error);
    }
  }

  // Asks the signature provider for help and mounts the rendered signature.
  async showSignatureHelp(provider, editor, position, context) {
    try {
      const signatureHelp = await provider.getSignature(editor, position, context);
      if (!signatureHelp?.signatures?.length) {
        if (this.currentOverlayType === "signature-help") this.unmountOverlay();
        return;
      }
      const element = await renderSignatureContent(signatureHelp, {
        includeSignatureDocumentation: atom.config.get("hover.includeSignatureDocumentation"),
      });
      if (!element) return;

      this.unmountOverlay();
      this.currentMarkerRange = new Range(position, position);
      this.mountOverlay(editor, null, position, element, {
        type: "signature-help",
        highlight: false,
        markerInvalidate: "overlap",
      });
    } catch (error) {
      console.error(error);
    }
  }

  mountOverlay(editor, range, position, element, { type, highlight, markerInvalidate = "never" }) {
    const disposables = new CompositeDisposable();
    const view = atom.views.getView(editor);
    element.style.setProperty("--text-editor-width", `${view.getWidth()}px`);

    if (highlight) {
      const highlightMarker = editor.markBufferRange(range ?? new Range(position, position), {
        invalidate: "never",
      });
      const highlightDecoration = editor.decorateMarker(highlightMarker, {
        type: "highlight",
        class: "hover-highlight-region",
      });
      disposables.add(
        new Disposable(() => {
          highlightMarker.destroy();
          highlightDecoration.destroy();
        }),
      );
    }

    const overlayMarker = editor.markBufferRange(new Range(position, position), {
      invalidate: markerInvalidate,
    });
    const overlayDecoration = editor.decorateMarker(overlayMarker, {
      type: "overlay",
      class: "hover-overlay",
      position: "tail",
      item: element,
    });
    disposables.add(
      new Disposable(() => {
        overlayMarker.destroy();
        overlayDecoration.destroy();
      }),
    );

    // The keymap dismisses the overlay with escape through this class.
    view.classList.add("hover-active");
    disposables.add(new Disposable(() => view.classList.remove("hover-active")));

    // Mouse movement within the overlay must not drive the editor hover logic.
    if (this.showOnMouseMove) {
      element.addEventListener("mouseenter", () => {
        this.editorView?.removeEventListener("mousemove", this.onMouseMove);
      });
      element.addEventListener("mouseleave", () => {
        this.editorView?.addEventListener("mousemove", this.onMouseMove);
      });
      disposables.add(
        new Disposable(() => {
          if (this.showOnMouseMove) {
            this.editorView?.addEventListener("mousemove", this.onMouseMove);
          }
        }),
      );
    }

    // Let the wheel scroll the overlay itself while its content overflows;
    // scrolls past its edges keep moving the editor.
    element.addEventListener(
      "wheel",
      (event) => {
        if (element.scrollHeight <= element.offsetHeight) return;
        const scrolledToTop = element.scrollTop === 0;
        const scrolledToBottom = element.scrollTop + element.offsetHeight >= element.scrollHeight;
        if (event.deltaY > 0 && scrolledToBottom) return;
        if (event.deltaY < 0 && scrolledToTop) return;
        event.stopPropagation();
      },
      { passive: true },
    );

    // Embedded code-block editors live until the overlay closes.
    disposables.add(
      new Disposable(() => {
        for (const editorElement of element.querySelectorAll("atom-text-editor")) {
          editorElement.getModel()?.destroy();
        }
      }),
    );

    this.currentOverlayType = type;
    this.overlayDisposables = disposables;
  }

  unmountOverlay() {
    this.currentMarkerRange = null;
    this.currentOverlayType = null;
    this.overlayDisposables?.dispose();
    this.overlayDisposables = null;
  }
};
