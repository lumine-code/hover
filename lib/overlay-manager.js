const { CompositeDisposable, Disposable, Point, Range } = require("atom");
const ProviderRegistry = require("./provider-registry");
const { renderHoverContent, renderSignatureContent } = require("./render");

// `SignatureHelpTriggerKind` from the LSP specification.
const TRIGGER_KIND_INVOKED = 1;
const TRIGGER_KIND_TRIGGER_CHARACTER = 2;

// Where along the tooltip the word it explains sits, and with it the pointer.
const ANCHOR_FRACTION = 0.25;

const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift"]);

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

  // Schedules only when nothing is pending. A deadline that every event pushed
  // back would never arrive while the mouse keeps moving, which is exactly
  // when the tooltip has to go.
  scheduleUnlessPending(...args) {
    if (this.timeout === null) this.schedule(...args);
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

// Tracks the focused editor for caret-driven features, and every workspace
// editor for pointer-driven hover. Both kinds of result are overlay
// decorations anchored in the editor they belong to.
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

    this.pointerEditor = null;
    this.pointerEditorView = null;
    this.pointerRevision = 0;
    this.pointerTargetKind = null;

    this.overlayEditor = null;
    this.overlayEditorView = null;

    this.currentMarkerRange = null;
    this.currentOverlayType = null;
    this.currentAnchorRect = null;
    this.overlayElement = null;
    this.pointerContent = null;
    this.pointerScroll = { top: 0, left: 0 };
    this.pointerOverOverlay = false;

    this.showOnCursorMove = false;
    this.showOnMouseMove = true;
    this.showSignatureWhileTyping = true;
    this.showDelay = atom.config.get("hover.showDelay") ?? 250;
    this.hideDelay = atom.config.get("hover.hideDelay") ?? 250;

    this.createTimers();

    this.subscriptions.add(
      atom.config.observe("hover.showDelay", (value) => {
        this.showDelay = value;
        this.createTimers();
      }),
      atom.config.observe("hover.hideDelay", (value) => {
        this.hideDelay = value;
        this.createTimers();
      }),
      atom.config.observe("hover.showOnCursorMove", (value) => {
        this.showOnCursorMove = value;
      }),
      atom.config.observe("hover.showOnMouseMove", (value) => {
        this.showOnMouseMove = value;
        if (!value) this.mouseMoveTimer.unschedule();
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
        // The overlay hangs inside the editor but is not part of its text, so
        // the editor's own copy has nothing to say about a selection made in
        // it. Registered after the editor's, which at equal specificity is
        // what puts this first.
        "core:copy": (event) => {
          const text = this.overlaySelection();
          if (!text) return;
          atom.clipboard.write(text);
          event.stopImmediatePropagation();
        },
      }),
    );
  }

  dispose() {
    this.unmountOverlay();
    this.mouseMoveTimer.dispose();
    this.cursorMoveTimer.dispose();
    this.hideTimer.dispose();
    this.editorSubscriptions?.dispose();
    this.editorSubscriptions = null;
    this.subscriptions.dispose();
  }

  createTimers() {
    this.mouseMoveTimer?.dispose();
    this.mouseMoveTimer = new Timer((...args) => this.onMouseRemain(...args), this.showDelay);
    this.cursorMoveTimer?.dispose();
    this.cursorMoveTimer = new Timer((event) => this.onCursorRemain(event), this.showDelay);
    this.hideTimer?.dispose();
    // Text selected in the tooltip is the reader working with it; the pointer
    // having wandered off says nothing then.
    this.hideTimer = new Timer(() => {
      if (!this.overlaySelection()) this.unmountOverlay();
    }, this.hideDelay);
  }

  watchEditor(editor) {
    if (this.watchedEditors.has(editor)) return null;

    const editorView = atom.views.getView(editor);
    if (editorView.hasFocus()) this.updateCurrentEditor(editor);

    const focusListener = () => this.updateCurrentEditor(editor);
    const mouseMoveListener = (event) => this.handleMouseMove(editor, event);
    const mouseLeaveListener = () => this.handleMouseLeave(editor);
    const scrollListener = () => this.handleScroll(editor);
    editorView.addEventListener("focus", focusListener);
    editorView.addEventListener("mousemove", mouseMoveListener);
    editorView.addEventListener("mouseleave", mouseLeaveListener);

    const disposable = new CompositeDisposable(
      editorView.onDidChangeScrollTop(scrollListener),
      editorView.onDidChangeScrollLeft(scrollListener),
      new Disposable(() => {
        editorView.removeEventListener("focus", focusListener);
        editorView.removeEventListener("mousemove", mouseMoveListener);
        editorView.removeEventListener("mouseleave", mouseLeaveListener);
        if (this.pointerEditor === editor) this.clearPointerEditor();
        if (this.editor === editor) this.updateCurrentEditor(null);
      }),
    );
    this.watchedEditors.add(editor);
    this.subscriptions.add(disposable);

    return new Disposable(() => {
      disposable.dispose();
      this.subscriptions.remove(disposable);
      this.watchedEditors.delete(editor);
    });
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

  // What the reader has selected inside the mounted overlay, if anything.
  overlaySelection() {
    if (!this.overlayElement) return "";
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return "";
    if (
      !this.overlayElement.contains(selection.anchorNode) &&
      !this.overlayElement.contains(selection.focusNode)
    ) {
      return "";
    }
    return selection.toString();
  }

  // Only rendered source lines and gutters own editor hover. Decorations are
  // siblings of `.line` within `.lines`; accepting their bubbled events makes
  // their coordinates look like source above or below them.
  hoverTargetKind(editorView, event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !editorView.contains(target)) return null;
    if (target.closest("atom-text-editor") !== editorView) return null;
    if (target.closest(".gutter-container")) return "gutter";
    const line = target.closest(".line:not(.dummy)");
    const lines = line?.parentElement?.parentElement;
    return lines?.classList.contains("lines") && editorView.contains(lines) ? "text" : null;
  }

  handleMouseMove(editor, event) {
    if (!this.showOnMouseMove) return;
    if (this.overlayElement?.contains(event.target)) return;

    const editorView = atom.views.getView(editor);
    const targetKind = this.hoverTargetKind(editorView, event);
    this.pointerEditor = editor;
    this.pointerEditorView = editorView;
    this.pointerTargetKind = targetKind;
    const revision = ++this.pointerRevision;
    this.recordPointer(editor, event);
    this.trackPointer(editor, this.pointerContent, targetKind !== null);

    if (!targetKind) {
      this.mouseMoveTimer.unschedule();
      return;
    }
    this.mouseMoveTimer.schedule(editor, event, targetKind, revision);
  }

  // The pointer leaving an editor takes its tooltip with it: no further move
  // arrives on that editor to notice it left.
  handleMouseLeave(editor) {
    if (this.pointerEditor !== editor) return;
    this.clearPointerEditor();
    if (this.currentOverlayType === "hover") this.hideTimer.scheduleUnlessPending();
  }

  clearPointerEditor() {
    this.pointerEditor = null;
    this.pointerEditorView = null;
    this.pointerContent = null;
    this.pointerTargetKind = null;
    this.pointerRevision++;
    this.mouseMoveTimer.unschedule();
  }

  // Scrolling moves the text out from under a pointer that never moved. The
  // content-coordinate delta tells whether it has left the current range.
  handleScroll(editor) {
    if (
      this.pointerOverOverlay ||
      this.pointerEditor !== editor ||
      !this.pointerContent ||
      !this.pointerTargetKind
    ) {
      return;
    }
    const component = this.pointerEditorView?.getComponent();
    if (!component) return;
    this.trackPointer(editor, {
      left: this.pointerContent.left + (component.getScrollLeft() - this.pointerScroll.left),
      top: this.pointerContent.top + (component.getScrollTop() - this.pointerScroll.top),
    });
  }

  // Where a pointer event falls in the text, and the scroll position that
  // answer was true at.
  recordPointer(editor, event) {
    const component = atom.views.getView(editor).getComponent();
    this.pointerContent = component.pixelPositionForMouseEvent(event);
    this.pointerScroll = { top: component.getScrollTop(), left: component.getScrollLeft() };
  }

  // Asked on every pointer move, ahead of the delay that requests a tooltip,
  // and again whenever the text scrolls. A tooltip belongs to the range it was
  // asked about, and the pointer leaving that range retires it after
  // `hideDelay` whether or not the pointer ever comes to rest — waiting for it
  // to stop is what left the tooltip standing over text it no longer
  // describes.
  trackPointer(editor, { left, top }, eligible = true) {
    if (this.currentOverlayType !== "hover") return;
    const rect = this.currentAnchorRect;
    const within =
      eligible &&
      this.overlayEditor === editor &&
      rect &&
      left >= rect.left &&
      left <= rect.right &&
      top >= rect.top &&
      top <= rect.bottom;
    if (within) this.hideTimer.unschedule();
    else this.hideTimer.scheduleUnlessPending();
  }

  // The box the hovered range occupies, in the editor's own content
  // coordinates — the space `pixelPositionForMouseEvent` answers in, and one
  // that survives scrolling, which client coordinates would not. A range the
  // provider left empty stands for the character under the pointer.
  anchorRectFor(editor, range) {
    const component = atom.views.getView(editor).getComponent();
    const start = component.pixelPositionForScreenPosition(
      editor.screenPositionForBufferPosition(range.start),
    );
    const end = component.pixelPositionForScreenPosition(
      editor.screenPositionForBufferPosition(range.end),
    );
    const oneRow = start.top === end.top;
    return {
      top: start.top,
      bottom: end.top + component.getLineHeight(),
      left: oneRow ? start.left : 0,
      right: oneRow ? Math.max(end.left, start.left + editor.getDefaultCharWidth()) : Infinity,
    };
  }

  // Runs once the mouse pointer has rested in one place for `showDelay`.
  async onMouseRemain(editor, event, targetKind, revision) {
    if (this.pointerEditor !== editor || this.pointerRevision !== revision) return;
    // The pointer reached the tooltip while this was pending.
    if (this.pointerOverOverlay) return;
    const editorView = atom.views.getView(editor);
    if (this.hoverTargetKind(editorView, event) !== targetKind) return;
    const component = editorView.getComponent();
    const screenPosition = component.screenPositionForMouseEvent(event);
    const point = editor.bufferPositionForScreenPosition(screenPosition);
    const isCurrent = () => this.pointerEditor === editor && this.pointerRevision === revision;

    // The gutter marks a whole row — a diagnostic's dot, a fold, a git status —
    // and resting on one asks about that row rather than about a position in
    // the text. The mouse event's own coordinates are clamped into the text
    // area, so the row is all that survives of it, and the row is the question.
    if (targetKind === "gutter") {
      if (!this.overlayContains(editor, point)) {
        await this.showHoverOverlay(editor, point, { gutter: true, isCurrent });
      }
      return;
    }

    const mouse = component.pixelPositionForMouseEvent(event);
    const screen = component.pixelPositionForScreenPosition(screenPosition);

    // Ignore pointer positions far away from any text on the row. Retiring
    // whatever is open is not this timer's business — it belongs to the hide
    // delay, which the pointer leaving the range has already started.
    if (Math.abs(mouse.left - screen.left) >= editor.getDefaultCharWidth()) return;

    if (!this.overlayContains(editor, point)) {
      await this.showHoverOverlay(editor, point, { isCurrent });
    }
  }

  overlayContains(editor, position) {
    return this.overlayEditor === editor && this.currentMarkerRange?.containsPoint(position);
  }

  // Runs once the cursor has rested in one place for `showDelay`.
  async onCursorRemain(event) {
    if (event.textChanged) return;
    if (this.currentOverlayType === "signature-help") return;
    const position = event.cursor.getBufferPosition();
    if (this.overlayContains(event.cursor.editor, position)) return;
    if (this.showOnCursorMove) {
      await this.showHoverOverlay(event.cursor.editor, position);
    } else if (this.currentOverlayType === "hover") {
      // The cursor left the hovered symbol; retire the tooltip on the hide
      // delay, the one deadline every way of losing a tooltip goes through.
      this.hideTimer.scheduleUnlessPending();
    }
  }

  async toggleHover(event) {
    const editor = event.currentTarget.getModel();
    if (!atom.workspace.isTextEditor(editor)) return;
    const position = editor.getCursorBufferPosition();
    if (this.overlayContains(editor, position)) return this.unmountOverlay();
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

  // Asks every hover provider about the position and mounts all of their
  // answers, in the order they were asked. Over the gutter the question is
  // about the whole row rather than a position on it, and only providers with
  // something to say about a row answer it at all.
  async showHoverOverlay(editor, position, { gutter = false, isCurrent = null } = {}) {
    try {
      // A word can be both wrong and worth explaining, and the reader wants
      // the diagnostic and the documentation together rather than whichever
      // package outranked the other. Priority orders the answers; it does not
      // silence anyone.
      const answers = [];
      for (const provider of this.hoverRegistry.getAllProvidersForEditor(editor)) {
        const answer = gutter
          ? await provider.hoverGutter?.(editor, position.row)
          : await provider.hover(editor, position);
        if (isCurrent && !isCurrent()) return;
        if (!answer?.contents?.value && !answer?.contents?.element) continue;
        const reported = answer.range ? Range.fromObject(answer.range) : null;
        // A stale answer for a position we already left is not shown.
        if (reported && !reported.containsPoint(position)) continue;
        answers.push({ contents: answer.contents, range: reported });
      }

      if (answers.length === 0) {
        // Nothing to say about this position, which says nothing about the
        // tooltip already open: that one goes on the hide delay, once the
        // pointer has been away from its range for long enough.
        if (this.currentOverlayType === "hover") this.hideTimer.scheduleUnlessPending();
        return;
      }

      // The narrowest span the answers agree on is where this exact set of
      // them holds, and so is what the tooltip watches to know the pointer has
      // left. A gutter answer stands for the whole row unless it says
      // otherwise, so the pointer may travel along the line it describes.
      const ranges = answers.map((answer) => answer.range).filter(Boolean);
      let range = null;
      if (ranges.length > 0) {
        range = ranges.reduce(
          (a, b) => new Range(Point.max(a.start, b.start), Point.min(a.end, b.end)),
        );
      } else if (gutter) {
        range = Range.fromObject(editor.getBuffer().rangeForRow(position.row));
      }
      // An overlay already covering the reported range needs no update.
      if (
        this.overlayEditor === editor &&
        this.currentMarkerRange &&
        range?.intersectsWith(this.currentMarkerRange)
      ) {
        return;
      }

      const element = await renderHoverContent(answers.map((answer) => answer.contents));
      if (isCurrent && !isCurrent()) return;
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

    // Only a hover tooltip answers for a range, and so only it is retired by
    // the pointer leaving one. Signature help follows the caret.
    this.currentAnchorRect =
      type === "hover" ? this.anchorRectFor(editor, range ?? new Range(position, position)) : null;
    this.overlayElement = element;
    this.overlayEditor = editor;
    this.overlayEditorView = view;

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

    // The overlay takes the focus while the reader drags a selection through
    // it (see `wrapInPanel`), and has to keep it: the editor's hidden input
    // collapses a native selection the moment it is focused, so handing the
    // focus back would take the selection with it. A click that selected
    // nothing has nothing to protect, so that one goes straight back.
    element.addEventListener("mouseup", () => {
      if (element.contains(document.activeElement) && !this.overlaySelection()) view.focus();
    });

    // A keystroke says the reader is done reading. The focus goes back before
    // the character is delivered, so it lands in the editor rather than in a
    // tooltip that cannot take it — except for the keys that act on the
    // tooltip itself, which is what escape and the copy chord are.
    element.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" || event.ctrlKey || event.metaKey) return;
        view.focus();
      },
      true,
    );

    // The tooltip hangs a quarter of its width to the left of the word it
    // explains, rather than starting at it: it points at its target the way a
    // tooltip does, while still reading left to right from about where the
    // eye already is. The editor reads the margin when it places the overlay
    // and reports back where the word ended up, so the pointer follows it
    // through any shift the window edges impose. Re-measured whenever the
    // content settles, since a code block only reports its width once it is
    // attached.
    if (type === "hover") {
      // Placing it needs its width, and its width needs it rendered, so it is
      // mounted invisible and shown once placed — otherwise it appears at the
      // word and jumps a frame later, which reads as a flicker.
      element.style.visibility = "hidden";
      const reveal = () => {
        element.style.visibility = "";
      };
      const alignToAnchor = () => {
        const width = element.offsetWidth;
        if (!width) return;
        const shift = `${Math.round(editor.getDefaultCharWidth() / 2 - width * ANCHOR_FRACTION)}px`;
        if (element.style.marginLeft === shift) return reveal();
        element.style.marginLeft = shift;
        // The margin alone puts it in place wherever it fits; against a window
        // edge the editor has to move the whole overlay to keep it on screen,
        // and that lands on its own frame. Waiting for it is the difference
        // between appearing where it belongs and appearing, then jumping.
        view.getComponent().scheduleUpdate();
        requestAnimationFrame(() => requestAnimationFrame(reveal));
      };
      const alignObserver = new ResizeObserver(alignToAnchor);
      alignObserver.observe(element);
      // Nothing to observe if it never gets a size; show it rather than lose
      // it. Two frames, because the first is the one it is inserted in.
      requestAnimationFrame(() => requestAnimationFrame(reveal));
      disposables.add(new Disposable(() => alignObserver.disconnect()));
    }

    // A click that lands anywhere else is done with the tooltip, and says so
    // plainly enough not to wait out the hide delay. In capture, so that
    // whoever handles the click cannot stop this from hearing about it.
    if (type === "hover") {
      const dismissOnOutsideClick = (event) => {
        if (!element.contains(event.target)) this.unmountOverlay();
      };
      window.addEventListener("mousedown", dismissOnOutsideClick, true);
      disposables.add(
        new Disposable(() => window.removeEventListener("mousedown", dismissOnOutsideClick, true)),
      );

      // So is a keystroke. Typing, moving the caret, running a command —
      // whatever it was, the reader has gone back to work and the tooltip is
      // in the way. Held modifiers are not keystrokes yet, and a chord is
      // reaching for something the tooltip may be the subject of: copying
      // what is selected in it, for one.
      const dismissOnKeydown = (event) => {
        if (MODIFIER_KEYS.has(event.key) || event.ctrlKey || event.metaKey) return;
        this.unmountOverlay();
      };
      window.addEventListener("keydown", dismissOnKeydown, true);
      disposables.add(
        new Disposable(() => window.removeEventListener("keydown", dismissOnKeydown, true)),
      );
    }

    // The keymap dismisses the overlay with escape through this class.
    view.classList.add("hover-active");
    disposables.add(new Disposable(() => view.classList.remove("hover-active")));

    // Mouse movement within the overlay must not drive the editor hover logic,
    // and reading the tooltip is a reason to keep it rather than to retire it.
    if (this.showOnMouseMove) {
      element.addEventListener("mouseenter", () => {
        this.pointerOverOverlay = true;
        this.hideTimer.unschedule();
        // The pointer is on the tooltip now, not on the text. A request still
        // pending for the position it came from would answer for a place the
        // pointer has left, and retire the tooltip being read to do it.
        this.mouseMoveTimer.unschedule();
      });
      element.addEventListener("mouseleave", () => {
        this.pointerOverOverlay = false;
        if (this.currentOverlayType === "hover") this.hideTimer.scheduleUnlessPending();
      });
    }

    // Let the wheel scroll the overlay's own content while it overflows;
    // scrolls past its edges keep moving the editor. The overlay root is not
    // the box that scrolls — the popover draws its arrow outside itself and
    // overflow there would clip it, so the scroll box is a descendant: the
    // padded view, or something a provider built. Whichever scrollable
    // ancestor of the wheel's target can still move in its direction answers
    // for it; stopping propagation keeps the editor's own wheel handler from
    // consuming the event, and the browser's native scroll does the rest.
    element.addEventListener(
      "wheel",
      (event) => {
        let node = event.target instanceof Element ? event.target : null;
        for (; node && element.contains(node); node = node.parentElement) {
          if (node.scrollHeight <= node.clientHeight) continue;
          const { overflowY } = getComputedStyle(node);
          if (overflowY !== "auto" && overflowY !== "scroll") continue;
          const atTop = node.scrollTop === 0;
          const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
          if (event.deltaY > 0 && atBottom) continue;
          if (event.deltaY < 0 && atTop) continue;
          event.stopPropagation();
          return;
        }
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
    // Never leave the focus on an element about to be removed.
    if (this.overlayElement?.contains(document.activeElement)) this.overlayEditorView?.focus();
    this.hideTimer?.unschedule();
    this.currentMarkerRange = null;
    this.currentOverlayType = null;
    this.currentAnchorRect = null;
    this.overlayElement = null;
    this.overlayEditor = null;
    this.overlayEditorView = null;
    // An element removed from under the pointer sends no mouseleave.
    this.pointerOverOverlay = false;
    this.overlayDisposables?.dispose();
    this.overlayDisposables = null;
  }
};
