const { CompositeDisposable, Disposable, Range } = require("lumine");
const ProviderRegistry = require("./provider-registry");
const { renderSignatureContent, wrapInPanel } = require("./render");

// `SignatureHelpTriggerKind` from the LSP specification.
const TRIGGER_KIND_INVOKED = 1;
const TRIGGER_KIND_TRIGGER_CHARACTER = 2;

// Where along the tooltip the word it explains sits, and with it the pointer.
const ANCHOR_FRACTION = 0.25;

const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift"]);
const INTERACTIVE_KEYS = new Set(["Enter", " ", "Spacebar", "Tab"]);

function interactiveControl(element, target) {
  const control = target?.closest?.("button:not(:disabled), a[href]");
  return control && element.contains(control) ? control : null;
}

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

// Tracks the focused editor for caret-driven features, and every visible
// registered editor for pointer-driven hover. Both kinds of result are overlay
// decorations anchored in the editor they belong to.
module.exports = class OverlayManager {
  constructor() {
    this.subscriptions = new CompositeDisposable();
    this.contextHelp = null;
    this.contextHelpPanel = null;
    this.signatureRegistry = new ProviderRegistry();
    this.editorWatches = new Map();
    this.requestController = null;
    this.requestEditor = null;
    this.disposed = false;
    this.currentResult = null;

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
    this.trace = true;
    this.statusBar = null;
    this.statusBarTile = null;
    this.traceStatusElement = null;
    this.traceTooltip = null;
    this.showStatusBar = false;
    this.showSignatureWhileTyping = true;
    this.showDelay = lumine.config.get("hover.showDelay") ?? 250;
    this.hideDelay = lumine.config.get("hover.hideDelay") ?? 250;

    this.createTimers();

    this.subscriptions.add(
      lumine.config.observe("hover.showDelay", (value) => {
        this.showDelay = value;
        this.createTimers();
      }),
      lumine.config.observe("hover.hideDelay", (value) => {
        this.hideDelay = value;
        this.createTimers();
      }),
      lumine.config.observe("hover.showOnCursorMove", (value) => {
        this.showOnCursorMove = value;
      }),
      lumine.config.observe("hover.trace", (value) => this.setTrace(value)),
      lumine.config.observe("hover.statusBar", (value) => {
        this.showStatusBar = value;
        this.updateStatusBar();
      }),
      lumine.config.observe("hover.showSignatureWhileTyping", (value) => {
        this.showSignatureWhileTyping = value;
      }),
      lumine.textEditors.observe((editor) => this.watchEditor(editor)),
      lumine.textEditors.onDidRemoveEditor((editor) => this.unwatchEditor(editor)),
      lumine.commands.add("lumine-workspace", {
        "hover:toggle-trace": {
          description: "Turn mouse-driven hover tooltips on or off in this window.",
          didDispatch: () => this.toggleTrace(),
        },
      }),
      // These commands explain whichever editor receives them, including mini
      // editors and registered notebook fragments outside workspace panes.
      lumine.commands.add("lumine-text-editor", {
        "hover:toggle": {
          description: "Show what the language server knows about the symbol at the cursor.",
          didDispatch: (event) => this.toggleHover(event),
        },
        "hover:toggle-signature-help": {
          description: "Show the signature of the call the cursor is inside.",
          didDispatch: (event) => this.toggleSignatureHelp(event),
        },
        "hover:dismiss": {
          description: "Close the hover overlay.",
          didDispatch: () => this.unmountOverlay(),
        },
        // The overlay hangs inside the editor but is not part of its text, so
        // the editor's own copy has nothing to say about a selection made in
        // it. Registered after the editor's, which at equal specificity is
        // what puts this first.
        "core:copy": (event) => {
          const text = this.overlaySelection();
          if (!text) return;
          lumine.clipboard.write(text);
          event.stopImmediatePropagation();
        },
      }),
    );
  }

  dispose() {
    this.disposed = true;
    this.removeStatusBar();
    this.statusBar = null;
    this.unmountOverlay();
    this.mouseMoveTimer.dispose();
    this.cursorMoveTimer.dispose();
    this.hideTimer.dispose();
    this.editorSubscriptions?.dispose();
    this.editorSubscriptions = null;
    for (const editor of [...this.editorWatches.keys()]) this.unwatchEditor(editor);
    this.subscriptions.dispose();
    this.contextHelp = null;
    this.contextHelpPanel = null;
  }

  setTrace(value) {
    this.trace = value;
    if (!value) this.clearPointerEditor();
    this.updateTraceStatus();
  }

  toggleTrace() {
    this.setTrace(!this.trace);
  }

  setStatusBar(statusBar) {
    this.removeStatusBar();
    this.statusBar = statusBar;
    this.updateStatusBar();
  }

  updateStatusBar() {
    if (this.disposed || !this.statusBar || !this.showStatusBar) {
      this.removeStatusBar();
      return;
    }
    if (this.statusBarTile) return;

    const element = document.createElement("status-bar-tile");
    element.classList.add("hover-trace-status");
    element.setAttribute("role", "button");
    element.tabIndex = 0;
    const icon = document.createElement("span");
    icon.classList.add("icon", "is-icon-only", "icon-eye");
    element.appendChild(icon);
    element.addEventListener("click", (event) => {
      if (event.button === 0) this.toggleTrace();
    });
    element.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.toggleTrace();
    });
    this.traceStatusElement = element;
    this.updateTraceStatus();
    this.statusBarTile = this.statusBar.addRightTile({ item: element, priority: 245 });
    this.traceTooltip = lumine.tooltips.add(element, {
      title: () => this.traceStatusTitle(),
      keyBindingCommand: "hover:toggle-trace",
      keyBindingTarget: lumine.views.getView(lumine.workspace),
    });
  }

  traceStatusTitle() {
    return `Hover trace is ${this.trace ? "enabled" : "disabled"}`;
  }

  updateTraceStatus() {
    if (!this.traceStatusElement) return;
    this.traceStatusElement.classList.toggle("active", this.trace);
    this.traceStatusElement.setAttribute("aria-label", this.traceStatusTitle());
    this.traceStatusElement.setAttribute("aria-pressed", String(this.trace));
  }

  removeStatusBar() {
    this.traceTooltip?.dispose();
    this.traceTooltip = null;
    this.statusBarTile?.destroy();
    this.statusBarTile = null;
    this.traceStatusElement = null;
  }

  setContextHelp(registry) {
    if (this.contextHelp === registry) return;
    // Registry edges own documentation requests and content. Signature help
    // shares the overlay slot but has its own provider lifecycle.
    if (this.requestType === "hover") this.cancelRequest();
    if (this.currentOverlayType === "hover") this.unmountOverlay({ cancelRequest: false });
    this.contextHelp = registry;
  }

  setContextHelpPanel(panel) {
    this.contextHelpPanel = panel;
    if (!this.disposed && this.currentOverlayType === "hover") this.updatePanelButton();
  }

  beginRequest(editor, type) {
    this.cancelRequest();
    const controller = new AbortController();
    this.requestController = controller;
    this.requestEditor = editor;
    this.requestType = type;
    return {
      signal: controller.signal,
      isCurrent: () =>
        !this.disposed &&
        !editor.isDestroyed() &&
        this.requestController === controller &&
        !controller.signal.aborted,
    };
  }

  cancelRequest() {
    this.requestController?.abort();
    this.requestController = null;
    this.requestEditor = null;
    this.requestType = null;
  }

  updatePanelButton() {
    this.panelActionDisposable?.dispose();
    this.panelActionDisposable = null;
    if (!this.contextHelpPanel || !this.currentResult || !this.overlayElement) return;
    const toolbar = document.createElement("div");
    toolbar.classList.add("hover-toolbar");
    const button = document.createElement("button");
    button.type = "button";
    button.classList.add("icon", "icon-book", "native-key-bindings", "hover-open-documentation");
    button.title = "Open in Documentation View";
    button.setAttribute("aria-label", button.title);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", async () => {
      const panel = this.contextHelpPanel;
      const result = this.currentResult;
      const overlay = this.overlayElement;
      if (!panel || !result) return;
      button.disabled = true;
      try {
        const view = await panel.show(result, { focus: false });
        if (view && !view.destroyed && this.overlayElement === overlay) this.unmountOverlay();
      } catch (error) {
        console.error(error);
      } finally {
        button.disabled = false;
      }
    });
    toolbar.appendChild(button);
    this.overlayElement.prepend(toolbar);
    // Result controls sit inside their surface, clear of its scrollbar. Keep
    // this corner over the content as its height and scroll gutter settle.
    const content = this.overlayElement.querySelector(".hover-overlay-view");
    const placeAction = () => {
      toolbar.style.right = `${Math.max(0, content.offsetWidth - content.clientWidth)}px`;
    };
    const observer = new ResizeObserver(placeAction);
    observer.observe(content);
    this.panelActionDisposable = new Disposable(() => {
      observer.disconnect();
      toolbar.remove();
    });
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
    if (this.editorWatches.has(editor)) return null;

    const editorView = lumine.views.getView(editor);
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
      editor.onDidDestroy(() => this.unwatchEditor(editor)),
      new Disposable(() => {
        editorView.removeEventListener("focus", focusListener);
        editorView.removeEventListener("mousemove", mouseMoveListener);
        editorView.removeEventListener("mouseleave", mouseLeaveListener);
        if (this.overlayEditor === editor || this.requestEditor === editor) this.unmountOverlay();
        if (this.pointerEditor === editor) this.clearPointerEditor();
        if (this.editor === editor) this.updateCurrentEditor(null);
      }),
    );
    this.editorWatches.set(editor, disposable);
    this.subscriptions.add(disposable);

    return disposable;
  }

  unwatchEditor(editor) {
    const disposable = this.editorWatches.get(editor);
    if (!disposable) return;
    this.editorWatches.delete(editor);
    disposable.dispose();
    this.subscriptions.remove(disposable);
  }

  updateCurrentEditor(editor) {
    if (editor === this.editor) return;
    this.editorSubscriptions?.dispose();
    this.editorSubscriptions = null;
    this.unmountOverlay();
    this.editor = null;
    this.editorView = null;

    if (!editor || !lumine.workspace.isTextEditor(editor)) return;
    this.editor = editor;
    this.editorView = lumine.views.getView(editor);
    this.editorSubscriptions = new CompositeDisposable();

    this.editorSubscriptions.add(
      editor.onDidChangeCursorPosition((event) => this.handleCursorMove(event)),
      editor.getBuffer().onDidChangeText((event) => this.handleTextChange(event, editor)),
    );
  }

  handleTextChange(event, editor) {
    if (event.changes.length === 0) return;
    if (
      this.currentOverlayType === "hover" ||
      (this.requestEditor === editor && this.requestType === "hover")
    ) {
      this.unmountOverlay();
    } else if (this.requestEditor === editor) {
      this.cancelRequest();
    }
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
    if (target.closest("lumine-text-editor") !== editorView) return null;
    if (target.closest(".gutter-container")) return "gutter";
    const line = target.closest(".line:not(.dummy)");
    const lines = line?.parentElement?.parentElement;
    return lines?.classList.contains("lines") && editorView.contains(lines) ? "text" : null;
  }

  handleMouseMove(editor, event) {
    if (!this.trace) return;
    if (this.overlayElement?.contains(event.target)) return;

    const editorView = lumine.views.getView(editor);
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
    const component = lumine.views.getView(editor).getComponent();
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
    const component = lumine.views.getView(editor).getComponent();
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
    const editorView = lumine.views.getView(editor);
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
    if (!lumine.workspace.isTextEditor(editor)) return;
    const position = editor.getCursorBufferPosition();
    if (this.overlayContains(editor, position)) return this.unmountOverlay();
    await this.showHoverOverlay(editor, position);
  }

  async toggleSignatureHelp(event) {
    const editor = event.currentTarget.getModel();
    if (!lumine.workspace.isTextEditor(editor)) return;
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
    const registry = this.contextHelp;
    if (!registry || this.disposed || editor.isDestroyed()) return;
    const request = this.beginRequest(editor, "hover");
    const current = () => request.isCurrent() && (!isCurrent || isCurrent());
    try {
      const result = await registry.request(editor, position, { gutter, signal: request.signal });
      if (!current()) return;
      if (!result) {
        // Nothing to say about this position, which says nothing about the
        // tooltip already open: that one goes on the hide delay, once the
        // pointer has been away from its range for long enough.
        if (this.currentOverlayType === "hover") this.hideTimer.scheduleUnlessPending();
        return;
      }

      const range = result.range;
      // An overlay already covering the reported range needs no update.
      if (
        this.overlayEditor === editor &&
        this.currentOverlayType === "hover" &&
        this.currentMarkerRange &&
        range?.intersectsWith(this.currentMarkerRange)
      ) {
        return;
      }

      const rendered = await registry.render(result, { autoWidth: true, signal: request.signal });
      if (!current()) {
        rendered?.dispose();
        return;
      }
      if (!rendered) return;
      rendered.element.classList.add("hover-overlay-view");
      const element = wrapInPanel(rendered.element);

      this.unmountOverlay({ cancelRequest: false });
      if (!current()) {
        rendered.dispose();
        return;
      }
      this.currentMarkerRange = range ?? new Range(position, position);
      this.mountOverlay(editor, this.currentMarkerRange, position, element, {
        type: "hover",
        highlight: true,
        disposeContent: () => rendered.dispose(),
      });
      this.currentResult = result;
      this.updatePanelButton();
    } catch (error) {
      if (current()) {
        this.unmountOverlay();
        console.error(error);
      }
    }
  }

  // Asks the signature provider for help and mounts the rendered signature.
  async showSignatureHelp(provider, editor, position, context) {
    if (this.disposed || editor.isDestroyed()) return;
    const request = this.beginRequest(editor, "signature-help");
    try {
      const signatureHelp = await provider.getSignature(editor, position, context);
      if (!request.isCurrent()) return;
      if (!signatureHelp?.signatures?.length) {
        if (this.currentOverlayType === "signature-help") this.unmountOverlay();
        return;
      }
      const element = await renderSignatureContent(signatureHelp, {
        includeSignatureDocumentation: lumine.config.get("hover.includeSignatureDocumentation"),
      });
      if (!request.isCurrent()) {
        this.destroyEmbeddedEditors(element);
        return;
      }
      if (!element) return;

      this.unmountOverlay({ cancelRequest: false });
      if (!request.isCurrent()) {
        this.destroyEmbeddedEditors(element);
        return;
      }
      this.currentMarkerRange = new Range(position, position);
      this.mountOverlay(editor, null, position, element, {
        type: "signature-help",
        highlight: false,
        markerInvalidate: "overlap",
      });
    } catch (error) {
      if (request.isCurrent()) console.error(error);
    }
  }

  destroyEmbeddedEditors(element) {
    for (const editorElement of element?.querySelectorAll("lumine-text-editor") ?? []) {
      editorElement.getModel()?.destroy();
    }
  }

  mountOverlay(
    editor,
    range,
    position,
    element,
    { type, highlight, markerInvalidate = "never", disposeContent = null },
  ) {
    const disposables = new CompositeDisposable();
    const view = lumine.views.getView(editor);
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
      // Below the line when that space is free — beside the word, where the
      // eye already is — and above it when something the reader is driving has
      // taken it, which is what the lowest priority here buys. Both kinds of
      // overlay ask for the same thing: a signature help shown with nothing
      // else open belongs at the caret as much as a tooltip does. See `side`
      // and `priority` on `decorateMarker`.
      side: "below",
      priority: 0,
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
    element.addEventListener("mouseup", (event) => {
      if (
        interactiveControl(element, event.target) ||
        interactiveControl(element, document.activeElement)
      )
        return;
      if (element.contains(document.activeElement) && !this.overlaySelection()) view.focus();
    });

    // A keystroke says the reader is done reading. The focus goes back before
    // the character is delivered, so it lands in the editor rather than in a
    // tooltip that cannot take it — except for the keys that act on the
    // tooltip itself, which is what escape and the copy chord are.
    element.addEventListener(
      "keydown",
      (event) => {
        if (event.target.closest?.(".hover-toolbar")) return;
        if (event.key === "Escape" || event.ctrlKey || event.metaKey) return;
        if (INTERACTIVE_KEYS.has(event.key) && interactiveControl(element, event.target)) return;
        view.focus();
      },
      true,
    );
    // These controls live inside the editor's DOM, so its keymap would also
    // interpret Enter and Tab as editing commands. Stop it at this ancestor,
    // after the control receives it, without preventing Chromium's default
    // action. Modified command chords still reach the keymap as usual.
    element.addEventListener("keydown", (event) => {
      if (event.target.closest?.(".hover-toolbar")) return;
      if (
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        INTERACTIVE_KEYS.has(event.key) &&
        interactiveControl(element, event.target)
      )
        event.stopPropagation();
    });

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
        if (event.key === "Escape") {
          this.unmountOverlay();
          return;
        }
        const toolbar = event.target.closest?.(".hover-toolbar");
        if (toolbar && element.contains(toolbar)) return;
        if (INTERACTIVE_KEYS.has(event.key) && interactiveControl(element, event.target)) return;
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
      if (this.trace && this.currentOverlayType === "hover") this.hideTimer.scheduleUnlessPending();
    });

    // Let native scrolling move the overlay's content. Unless chaining is
    // enabled, keep every wheel event inside the overlay, even at its edges.
    // The root draws the popover arrow outside itself, so its scroll box is a
    // descendant: the padded view or an element a provider built. With chaining
    // enabled, stop the event while any scrollable ancestor of the target can
    // still move; otherwise let the editor handle it.
    element.addEventListener(
      "wheel",
      (event) => {
        if (!lumine.config.get("hover.scrollChaining")) {
          event.stopPropagation();
          return;
        }
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

    // The shared renderer owns its node and embedded editors. Signature help
    // still uses its local renderer and tears down its editors here.
    disposables.add(new Disposable(disposeContent ?? (() => this.destroyEmbeddedEditors(element))));

    this.currentOverlayType = type;
    this.overlayDisposables = disposables;
  }

  unmountOverlay({ cancelRequest = true } = {}) {
    if (cancelRequest) this.cancelRequest();
    // Never leave the focus on an element about to be removed.
    if (this.overlayElement?.contains(document.activeElement)) this.overlayEditorView?.focus();
    this.panelActionDisposable?.dispose();
    this.panelActionDisposable = null;
    this.hideTimer?.unschedule();
    this.currentMarkerRange = null;
    this.currentOverlayType = null;
    this.currentResult = null;
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
