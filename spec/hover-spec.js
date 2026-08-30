const path = require("path");
const { CompositeDisposable, Disposable } = require("lumine");
const { renderHoverContent } = require("../lib/render");

const packageRoot = path.join(__dirname, "..");

// Flushes pending microtasks so async provider/render chains settle without
// advancing the fake clock.
async function microtasks(count = 40) {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

// The overlay reaches the DOM on the editor's next render, and is shown once
// it has been measured and placed. Both take a frame, and the spec clock does
// not drive frames.
async function frames(count = 2) {
  for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame);
}

function overlayDecorations(editor) {
  return editor.getOverlayDecorations().filter((d) => d.getProperties().class === "hover-overlay");
}

function overlayItem(editor) {
  return overlayDecorations(editor)[0]?.getProperties().item ?? null;
}

const SIGNATURE_HELP = {
  signatures: [
    {
      label: "add(a: number, b: number): number",
      documentation: "Adds two numbers.",
      parameters: [
        { label: "a: number", documentation: { kind: "markdown", value: "The **first** addend." } },
        { label: "b: number" },
      ],
    },
  ],
  activeSignature: 0,
  activeParameter: 0,
};

describe("realm-local rendering", () => {
  it("builds hover content in the requested editor document", async () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const element = await renderHoverContent(
      { kind: "plaintext", value: "secondary surface" },
      frame.contentDocument,
    );
    expect(element.ownerDocument).toBe(frame.contentDocument);
    expect(element.querySelector(".hover-section").ownerDocument).toBe(frame.contentDocument);
    frame.remove();
  });
});

describe("hover", () => {
  let mainModule;
  let editor;
  let editorView;
  let disposables;
  let showDelay;
  let hideDelay;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    disposables = new CompositeDisposable();

    const pack = await lumine.packages.activatePackage(packageRoot);
    mainModule = pack.mainModule;
    showDelay = lumine.config.get("hover.showDelay");
    hideDelay = lumine.config.get("hover.hideDelay");

    editor = await lumine.workspace.open();
    editor.setText("add\nsecond line\n");
    editor.setCursorBufferPosition([0, 0]);
    editorView = lumine.views.getView(editor);
    editorView.focus();
    await microtasks();
  });

  afterEach(async () => {
    disposables.dispose();
    await lumine.packages.deactivatePackage("hover");
    for (const open of lumine.workspace.getTextEditors()) open.destroy();
  });

  function addHoverProvider(hover, targetEditor = editor) {
    const provider = {
      name: "Hover Stub",
      packageName: "hover-spec",
      priority: 1,
      get grammarScopes() {
        return [targetEditor.getGrammar().scopeName];
      },
      hover,
    };
    disposables.add(mainModule.consumeHover(provider));
    return provider;
  }

  function addSignatureProvider({
    getSignature = jasmine
      .createSpy("getSignature")
      .and.callFake(async () => structuredClone(SIGNATURE_HELP)),
    triggerCharacters = () => new Set(["("]),
    retriggerCharacters = () => new Set([","]),
    targetEditor = editor,
  } = {}) {
    const provider = {
      name: "Signature Stub",
      packageName: "hover-spec",
      priority: 1,
      get grammarScopes() {
        return [targetEditor.getGrammar().scopeName];
      },
      get triggerCharacters() {
        return triggerCharacters();
      },
      get retriggerCharacters() {
        return retriggerCharacters();
      },
      getSignature,
    };
    disposables.add(mainModule.consumeHoverSignature(provider));
    return provider;
  }

  function addRegisteredEditor(role = "fragment", text = "add\n") {
    const targetEditor = lumine.workspace.buildTextEditor({ mini: false });
    targetEditor.setGrammar(editor.getGrammar());
    targetEditor.setText(text);
    const targetView = lumine.views.getView(targetEditor);
    targetView.style.height = "100px";
    jasmine.attachToDOM(targetView);
    const registration = lumine.textEditors.add(targetEditor, { role });
    disposables.add(
      new Disposable(() => {
        registration.dispose();
        if (!targetEditor.isDestroyed()) targetEditor.destroy();
        targetView.remove();
      }),
    );
    return { editor: targetEditor, view: targetView, registration };
  }

  // Where a buffer position sits in the editor's content coordinates. The
  // pointer moves below stay on the first row: the component clamps a mouse
  // event to its scroll container, and a spec editor is short.
  function pixelFor(bufferPosition, targetEditor = editor) {
    const targetView = lumine.views.getView(targetEditor);
    const component = targetView.getComponent();
    component.updateSync();
    const { left, top } = component.pixelPositionForScreenPosition(
      targetEditor.screenPositionForBufferPosition(bufferPosition),
    );
    return { left, top: top + component.getLineHeight() / 2 };
  }

  // Selects everything in the mounted overlay, the way a drag across it would.
  // It only takes if the package's stylesheet has turned native selection back
  // on for the overlay, which the editor around it turns off.
  function selectTooltipContents() {
    const range = document.createRange();
    range.selectNodeContents(overlayItem(editor).querySelector(".hover-overlay-view"));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
  }

  // A pointer event at a content coordinate, carrying the client coordinates
  // the component reads back out of it.
  function movePointerTo({ left, top }, targetEditor = editor) {
    const targetView = lumine.views.getView(targetEditor);
    const MouseEvent = targetView.ownerDocument.defaultView.MouseEvent;
    const component = targetView.getComponent();
    component.updateSync();
    const screenRow = component.screenPositionForPixelPosition({ left, top }).row;
    const line = targetView.querySelector(`.line[data-screen-row="${screenRow}"]`);
    const lines = targetView.querySelector(".lines").getBoundingClientRect();
    line.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        clientX: lines.left + left,
        clientY: lines.top + top,
      }),
    );
  }

  describe("registered embedded editors", () => {
    it("keeps pointer hover in the editor's current document after it moves surfaces", async () => {
      const frame = document.createElement("iframe");
      document.body.appendChild(frame);

      const fragment = addRegisteredEditor();
      disposables.add(new Disposable(() => frame.remove()));
      frame.contentDocument.adoptNode(fragment.view);
      frame.contentDocument.body.appendChild(fragment.view);
      const hover = jasmine.createSpy("hover").and.resolveTo({
        range: [
          [0, 0],
          [0, 3],
        ],
        contents: { kind: "plaintext", value: "detached docs" },
      });
      addHoverProvider(hover, fragment.editor);

      movePointerTo(pixelFor([0, 1], fragment.editor), fragment.editor);
      advanceClock(showDelay);
      await microtasks();

      expect(hover).toHaveBeenCalled();
      expect(overlayItem(fragment.editor).ownerDocument).toBe(frame.contentDocument);
      expect(overlayItem(fragment.editor).textContent).toContain("detached docs");

      const transition = await lumine.workspace.windowSurfaceTransitions.begin({
        item: fragment.editor,
        from: {
          id: "detached",
          kind: "detached-pane",
          window: frame.contentWindow,
          document: frame.contentDocument,
          element: frame.contentDocument.body,
        },
        to: {
          id: "primary",
          kind: "primary",
          window,
          document,
          element: lumine.views.getView(lumine.workspace),
        },
        reason: "attach",
      });
      expect(overlayDecorations(fragment.editor).length).toBe(0);

      document.adoptNode(fragment.view);
      document.body.appendChild(fragment.view);
      await transition.commit();
      transition.complete();

      movePointerTo(pixelFor([0, 1], fragment.editor), fragment.editor);
      advanceClock(showDelay);
      await microtasks();
      expect(hover.calls.count()).toBe(2);
      expect(overlayItem(fragment.editor).ownerDocument).toBe(document);
    });

    it("returns focus from an unselected tooltip in the editor's current Window", async () => {
      const frame = document.createElement("iframe");
      document.body.appendChild(frame);

      const fragment = addRegisteredEditor();
      disposables.add(new Disposable(() => frame.remove()));
      frame.contentDocument.adoptNode(fragment.view);
      frame.contentDocument.body.appendChild(fragment.view);
      addHoverProvider(
        async () => ({ contents: { kind: "plaintext", value: "detached docs" } }),
        fragment.editor,
      );

      lumine.commands.dispatch(fragment.view, "hover:toggle");
      await microtasks();
      fragment.view.getComponent().updateSync();

      const item = overlayItem(fragment.editor);
      const focusTarget = frame.contentDocument.createElement("button");
      item.appendChild(focusTarget);
      spyOnProperty(frame.contentDocument, "activeElement", "get").and.returnValue(focusTarget);
      frame.contentWindow.getSelection().removeAllRanges();
      spyOn(fragment.view, "focus").and.callThrough();
      item.dispatchEvent(new frame.contentWindow.MouseEvent("mouseup", { bubbles: true }));

      expect(fragment.view.focus).toHaveBeenCalled();
    });

    it("shows pointer and command hover in a fragment editor outside a workspace pane", async () => {
      const fragment = addRegisteredEditor();
      const hover = jasmine.createSpy("hover").and.resolveTo({
        range: [
          [0, 0],
          [0, 3],
        ],
        contents: { kind: "markdown", value: "fragment docs" },
      });
      addHoverProvider(hover, fragment.editor);

      movePointerTo(pixelFor([0, 1], fragment.editor), fragment.editor);
      advanceClock(showDelay);
      await microtasks();

      expect(hover).toHaveBeenCalled();
      expect(hover.calls.mostRecent().args[0]).toBe(fragment.editor);
      expect(overlayItem(fragment.editor).textContent).toContain("fragment docs");

      lumine.commands.dispatch(fragment.view, "hover:dismiss");
      fragment.editor.setCursorBufferPosition([0, 1]);
      lumine.commands.dispatch(fragment.view, "hover:toggle");
      await microtasks();

      expect(hover.calls.count()).toBe(2);
      expect(overlayDecorations(fragment.editor).length).toBe(1);
    });

    it("shows signature help while typing in a registered fragment", async () => {
      const fragment = addRegisteredEditor("fragment", "add");
      const provider = addSignatureProvider({ targetEditor: fragment.editor });
      fragment.view.focus();
      fragment.editor.setCursorBufferPosition([0, 3]);
      await microtasks();

      fragment.editor.insertText("(");
      await microtasks();

      expect(provider.getSignature).toHaveBeenCalled();
      expect(provider.getSignature.calls.mostRecent().args[0]).toBe(fragment.editor);
      expect(overlayItem(fragment.editor).querySelector(".hover-signature").textContent).toBe(
        "add(a: number, b: number): number",
      );
    });

    it("stops watching a fragment when it is unregistered or destroyed", async () => {
      const unregistered = addRegisteredEditor();
      addHoverProvider(
        async () => ({ contents: { kind: "plaintext", value: "registered docs" } }),
        unregistered.editor,
      );
      expect(mainModule.overlayManager.editorWatches.has(unregistered.editor)).toBe(true);
      lumine.commands.dispatch(unregistered.view, "hover:toggle");
      await microtasks();
      expect(overlayDecorations(unregistered.editor).length).toBe(1);

      unregistered.registration.dispose();
      expect(mainModule.overlayManager.editorWatches.has(unregistered.editor)).toBe(false);
      expect(overlayDecorations(unregistered.editor).length).toBe(0);

      const destroyed = addRegisteredEditor();
      expect(mainModule.overlayManager.editorWatches.has(destroyed.editor)).toBe(true);

      destroyed.editor.destroy();
      expect(mainModule.overlayManager.editorWatches.has(destroyed.editor)).toBe(false);
    });

    it("does not watch or build a view for a background editor", () => {
      const background = lumine.workspace.buildTextEditor({ mini: false });
      const getView = spyOn(lumine.views, "getView").and.callThrough();
      const registration = lumine.textEditors.add(background, { role: "background" });
      disposables.add(
        new Disposable(() => {
          registration.dispose();
          if (!background.isDestroyed()) background.destroy();
        }),
      );

      expect(mainModule.overlayManager.editorWatches.has(background)).toBe(false);
      expect(getView).not.toHaveBeenCalledWith(background);
    });
  });

  describe("hover tooltips", () => {
    it("shows rendered markdown from the provider for hover:toggle, and toggles it away", async () => {
      const hover = jasmine.createSpy("hover").and.callFake(async () => ({
        range: [
          [0, 0],
          [0, 3],
        ],
        contents: { kind: "markdown", value: "**Adds** two `numbers`." },
      }));
      addHoverProvider(hover);
      editor.setCursorBufferPosition([0, 1]);

      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();

      expect(hover).toHaveBeenCalled();
      const [hoveredEditor, point] = hover.calls.mostRecent().args;
      expect(hoveredEditor).toBe(editor);
      expect(point.isEqual([0, 1])).toBe(true);

      const decorations = overlayDecorations(editor);
      expect(decorations.length).toBe(1);
      const item = decorations[0].getProperties().item;
      expect(item.classList.contains("hover-overlay-view-container")).toBe(true);
      expect(item.querySelector("strong").textContent).toBe("Adds");
      expect(item.textContent).toContain("numbers");

      // The provider range is marked with a highlight decoration.
      const highlights = editor
        .getHighlightDecorations()
        .filter((d) => d.getProperties().class === "hover-highlight-region");
      expect(highlights.length).toBe(1);
      expect(
        highlights[0]
          .getMarker()
          .getBufferRange()
          .isEqual([
            [0, 0],
            [0, 3],
          ]),
      ).toBe(true);

      // Toggling again at the same position dismisses the tooltip.
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      expect(overlayDecorations(editor).length).toBe(0);
    });

    it("honors the hover delay when showing on cursor rest", async () => {
      lumine.config.set("hover.showOnCursorMove", true);
      const hover = jasmine.createSpy("hover").and.callFake(async () => ({
        contents: { kind: "markdown", value: "docs" },
      }));
      addHoverProvider(hover);

      editor.setCursorBufferPosition([0, 2]);
      await microtasks();
      expect(hover).not.toHaveBeenCalled();

      advanceClock(showDelay - 1);
      await microtasks();
      expect(hover).not.toHaveBeenCalled();
      expect(overlayDecorations(editor).length).toBe(0);

      advanceClock(1);
      await microtasks();
      expect(hover).toHaveBeenCalled();
      expect(overlayDecorations(editor).length).toBe(1);
    });

    it("dismisses the tooltip with the escape-bound dismiss command", async () => {
      addHoverProvider(async () => ({
        range: [
          [0, 0],
          [0, 3],
        ],
        contents: { kind: "markdown", value: "docs" },
      }));
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      expect(overlayDecorations(editor).length).toBe(1);

      // While an overlay is open the editor carries the class that scopes the
      // escape keybinding to it.
      expect(editorView.classList.contains("hover-active")).toBe(true);
      const bindings = lumine.keymaps
        .findKeyBindings({ keystrokes: "escape", target: editorView })
        .map((binding) => binding.command);
      expect(bindings).toContain("hover:dismiss");

      lumine.commands.dispatch(editorView, "hover:dismiss");
      expect(overlayDecorations(editor).length).toBe(0);
      expect(editorView.classList.contains("hover-active")).toBe(false);
    });

    describe("with the pointer", () => {
      // Points on the hovered word "add", and two well past its last
      // character but still on its row.
      let inside;
      let outside;
      let furtherOutside;

      beforeEach(async () => {
        // Hiding well inside the show delay keeps the two paths apart: a
        // pointer that comes to rest off the text is dismissed by the show
        // path, and these specs are about the other one.
        lumine.config.set("hover.hideDelay", Math.round(showDelay / 5));
        hideDelay = lumine.config.get("hover.hideDelay");

        // Enough rows below the hovered word for the buffer to scroll.
        editor.setText(`add\n${"second line\n".repeat(40)}`);

        addHoverProvider(async () => ({
          range: [
            [0, 0],
            [0, 3],
          ],
          contents: { kind: "markdown", value: "docs" },
        }));
        const charWidth = editor.getDefaultCharWidth();
        inside = pixelFor([0, 1]);
        const end = pixelFor([0, 3]);
        outside = { left: end.left + 3 * charWidth, top: end.top };
        furtherOutside = { left: end.left + 6 * charWidth, top: end.top };

        movePointerTo(inside);
        advanceClock(showDelay);
        await microtasks();
        await frames();
        expect(overlayDecorations(editor).length).toBe(1);
      });

      it("retires the tooltip once the pointer has left the range, moving or not", () => {
        movePointerTo(outside);
        advanceClock(hideDelay - 1);
        // Still moving, and away: a deadline every move pushed back would
        // never arrive, which is what left the tooltip standing over text it
        // no longer describes.
        movePointerTo(furtherOutside);
        expect(overlayDecorations(editor).length).toBe(1);

        advanceClock(1);
        expect(overlayDecorations(editor).length).toBe(0);
      });

      it("keeps the tooltip while the pointer moves within the range", async () => {
        movePointerTo(pixelFor([0, 2]));
        advanceClock(hideDelay * 2);
        await microtasks();
        expect(overlayDecorations(editor).length).toBe(1);
      });

      it("retires the tooltip when the text scrolls out from under a still pointer", () => {
        // No pointer event at all: the range moves, the pointer does not, and
        // nothing would ask the question if the scroll did not.
        const component = editorView.getComponent();
        editorView.style.height = "40px";
        component.measureDimensions();
        component.updateSync();
        editorView.setScrollTop(component.getLineHeight() * 3);
        component.updateSync();
        expect(editorView.getScrollTop()).toBeGreaterThan(0);

        advanceClock(hideDelay);
        expect(overlayDecorations(editor).length).toBe(0);
      });

      it("keeps the tooltip while the pointer is over it", () => {
        movePointerTo(outside);
        overlayItem(editor).dispatchEvent(new MouseEvent("mouseenter"));
        advanceClock(hideDelay * 2);
        expect(overlayDecorations(editor).length).toBe(1);

        // Leaving the tooltip starts the countdown again.
        overlayItem(editor).dispatchEvent(new MouseEvent("mouseleave"));
        advanceClock(hideDelay);
        expect(overlayDecorations(editor).length).toBe(0);
      });

      it("retires the tooltip when the pointer leaves the editor", () => {
        editorView.dispatchEvent(new MouseEvent("mouseleave"));
        advanceClock(hideDelay);
        expect(overlayDecorations(editor).length).toBe(0);
      });

      it("waits out the hide delay however short the show delay is", async () => {
        // A show delay well below the hide delay used to retire the tooltip
        // almost at once: the timer that asks for one also decided to drop
        // one, so the hide delay never got a say.
        lumine.config.set("hover.showDelay", 1);
        lumine.config.set("hover.hideDelay", 500);
        movePointerTo(inside);
        advanceClock(1);
        await microtasks();
        expect(overlayDecorations(editor).length).toBe(1);

        movePointerTo(outside);
        advanceClock(499);
        await microtasks();
        expect(overlayDecorations(editor).length).toBe(1);

        advanceClock(1);
        expect(overlayDecorations(editor).length).toBe(0);
      });

      it("retires the tooltip the moment a key is pressed", () => {
        // Reaching for a modifier is not a keystroke yet, and a chord may be
        // for the tooltip itself — the copy that takes what is selected in it.
        editorView.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", bubbles: true }));
        editorView.dispatchEvent(
          new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }),
        );
        expect(overlayDecorations(editor).length).toBe(1);

        // Anything else, and the reader has gone back to work. No delay: the
        // cursor moving used to be noticed a show delay later and acted on a
        // hide delay after that.
        editorView.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        );
        expect(overlayDecorations(editor).length).toBe(0);
      });

      it("retires the tooltip the moment a click lands outside it", () => {
        overlayItem(editor).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(overlayDecorations(editor).length).toBe(1);

        // No delay: a click elsewhere is not an ambiguous signal.
        editorView.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(overlayDecorations(editor).length).toBe(0);
      });

      it("keeps the tooltip when the pointer leaves it and comes straight back", () => {
        const item = overlayItem(editor);
        item.dispatchEvent(new MouseEvent("mouseenter"));
        item.dispatchEvent(new MouseEvent("mouseleave"));
        movePointerTo(outside);
        item.dispatchEvent(new MouseEvent("mouseenter"));

        // Long enough for both delays: the hide is cancelled by coming back,
        // and the request left pending over the text must not answer for a
        // position the pointer has left.
        advanceClock(Math.max(showDelay, hideDelay) * 2);
        expect(overlayDecorations(editor).length).toBe(1);
      });

      it("keeps the tooltip while its text is selected", () => {
        selectTooltipContents();
        movePointerTo(outside);
        advanceClock(hideDelay * 2);
        expect(overlayDecorations(editor).length).toBe(1);

        // Once the selection is gone the pointer decides again.
        window.getSelection().removeAllRanges();
        movePointerTo(furtherOutside);
        advanceClock(hideDelay);
        expect(overlayDecorations(editor).length).toBe(0);
      });

      it("copies the tooltip's selection rather than the editor's", () => {
        editor.setSelectedBufferRange([
          [1, 0],
          [1, 6],
        ]);
        lumine.clipboard.write("untouched");
        selectTooltipContents();

        lumine.commands.dispatch(editorView, "core:copy");
        expect(lumine.clipboard.read()).toBe("docs");

        // With nothing selected in it the editor's own copy runs as before.
        window.getSelection().removeAllRanges();
        lumine.commands.dispatch(editorView, "core:copy");
        expect(lumine.clipboard.read()).toBe("second");
      });
    });

    it("does not look through a block decoration for source text", async () => {
      const hover = jasmine.createSpy("hover").and.resolveTo({
        range: [
          [1, 0],
          [1, 6],
        ],
        contents: { kind: "markdown", value: "docs behind the result" },
      });
      addHoverProvider(hover);

      const result = document.createElement("div");
      result.classList.add("inline-result");
      result.style.height = "30px";
      const marker = editor.markBufferPosition([0, Infinity]);
      const decoration = editor.decorateMarker(marker, {
        type: "block",
        position: "after",
        item: result,
      });
      disposables.add(
        new CompositeDisposable(
          new Disposable(() => decoration.destroy()),
          new Disposable(() => marker.destroy()),
        ),
      );
      editorView.getComponent().updateSync();

      const lines = editorView.querySelector(".lines").getBoundingClientRect();
      const resultRect = result.getBoundingClientRect();
      result.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: lines.left + editor.getDefaultCharWidth(),
          clientY: resultRect.top + resultRect.height / 2,
        }),
      );
      advanceClock(showDelay);
      await microtasks();

      expect(hover).not.toHaveBeenCalled();
      expect(overlayDecorations(editor).length).toBe(0);
    });

    it("shows pointer hover in an editor that is not active", async () => {
      const otherEditor = await lumine.workspace.open(undefined, {
        split: "right",
        activatePane: false,
      });
      otherEditor.setText("other symbol\n");
      const otherView = lumine.views.getView(otherEditor);
      editorView.focus();
      await microtasks();

      const hover = jasmine.createSpy("hover").and.resolveTo({
        range: [
          [0, 0],
          [0, 5],
        ],
        contents: { kind: "markdown", value: "other docs" },
      });
      addHoverProvider(hover);

      movePointerTo(pixelFor([0, 2], otherEditor), otherEditor);
      advanceClock(showDelay);
      await microtasks();

      expect(lumine.workspace.getActiveTextEditor()).toBe(editor);
      expect(hover).toHaveBeenCalled();
      expect(hover.calls.mostRecent().args[0]).toBe(otherEditor);
      expect(overlayDecorations(otherEditor).length).toBe(1);
      expect(overlayDecorations(editor).length).toBe(0);
      expect(otherView.classList.contains("hover-active")).toBe(true);
    });

    it("dismisses the tooltip when the cursor leaves the hovered range", async () => {
      addHoverProvider(async () => ({
        range: [
          [0, 0],
          [0, 3],
        ],
        contents: { kind: "markdown", value: "docs" },
      }));
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      expect(overlayDecorations(editor).length).toBe(1);

      // The cursor leaving is noticed on the show delay and acted on after the
      // hide delay, the one deadline every way of losing a tooltip goes
      // through.
      editor.setCursorBufferPosition([1, 3]);
      advanceClock(showDelay);
      await microtasks();
      expect(overlayDecorations(editor).length).toBe(1);

      advanceClock(hideDelay);
      expect(overlayDecorations(editor).length).toBe(0);
    });

    it("keeps the tooltip when the next symbol has nothing to say", async () => {
      // Moving off a symbol onto one no provider answers for — a bracket, a
      // comma — is the pointer leaving, and leaving is the hide delay's to
      // time. An empty answer used to retire the tooltip there and then,
      // which a short show delay turned into an instant disappearance.
      lumine.config.set("hover.showDelay", 1);
      lumine.config.set("hover.hideDelay", 500);
      editor.setText("add and more\n");
      addHoverProvider(async (_editor, point) =>
        point.column <= 3
          ? {
              range: [
                [0, 0],
                [0, 3],
              ],
              contents: { kind: "markdown", value: "docs" },
            }
          : null,
      );

      movePointerTo(pixelFor([0, 1]));
      advanceClock(1);
      await microtasks();
      expect(overlayDecorations(editor).length).toBe(1);

      movePointerTo(pixelFor([0, 8]));
      advanceClock(1);
      await microtasks();
      expect(overlayDecorations(editor).length).toBe(1);

      advanceClock(499);
      expect(overlayDecorations(editor).length).toBe(0);
    });

    it("stacks what every provider has to say, the highest priority first", async () => {
      // A word can be both wrong and worth explaining. Priority decides the
      // order of the sections, not which of them is heard.
      const documentation = addHoverProvider(async () => ({
        range: [
          [0, 0],
          [0, 3],
        ],
        contents: { kind: "markdown", value: "Adds two numbers." },
      }));
      documentation.priority = 2;
      const diagnostic = addHoverProvider(async () => ({
        range: [
          [0, 0],
          [0, 3],
        ],
        contents: { kind: "markdown", value: "unused variable" },
      }));
      diagnostic.priority = 100;

      editor.setCursorBufferPosition([0, 1]);
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();

      const sections = overlayItem(editor).querySelectorAll(".hover-section");
      expect(sections.length).toBe(2);
      expect(sections[0].textContent).toContain("unused variable");
      expect(sections[1].textContent).toContain("Adds two numbers.");
    });

    it("mounts an element a provider built for itself", async () => {
      // Not every answer is prose: a linter message carries a severity and a
      // rule name that markdown would flatten into text.
      const built = document.createElement("div");
      built.classList.add("provider-built");
      built.textContent = "a message";
      addHoverProvider(async () => ({ contents: { element: built } }));

      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();

      const item = overlayItem(editor);
      expect(item.querySelector(".provider-built")).toBe(built);
      // The popover drops its prose padding for a section that lays out its own.
      expect(item.querySelector(".hover-section").classList).toContain("hover-provided");
    });

    it("asks about the row when the pointer rests on the gutter", async () => {
      const hover = jasmine.createSpy("hover").and.resolveTo(null);
      const hoverGutter = jasmine.createSpy("hoverGutter").and.callFake(async () => ({
        contents: { kind: "markdown", value: "two problems on this line" },
      }));
      const provider = addHoverProvider(hover);
      provider.hoverGutter = hoverGutter;

      // Tall enough for the second row to be reachable: the component clamps
      // a mouse event into its scroll container, and a spec editor is short.
      editorView.style.height = "100px";
      editorView.getComponent().measureDimensions();
      editorView.getComponent().updateSync();

      const gutterContainer = editorView.querySelector(".gutter-container");
      const gutter = gutterContainer.getBoundingClientRect();
      const lines = editorView.querySelector(".lines").getBoundingClientRect();
      // Dispatched on the gutter, because what marks a pointer event as a
      // gutter event is where it landed, not where it was heard.
      gutterContainer.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: gutter.left + gutter.width / 2,
          clientY: lines.top + pixelFor([1, 0]).top,
        }),
      );
      advanceClock(showDelay);
      await microtasks();

      // The row is the question, so the position-based method is not asked at
      // a column the pointer never rested on.
      expect(hover).not.toHaveBeenCalled();
      expect(hoverGutter).toHaveBeenCalled();
      expect(hoverGutter.calls.mostRecent().args[1]).toBe(1);
      expect(overlayDecorations(editor).length).toBe(1);

      // An answer without a range stands for the whole row, so the highlight
      // covers the line and the pointer can travel along it.
      const highlight = editor
        .getHighlightDecorations()
        .find((d) => d.getProperties().class === "hover-highlight-region");
      expect(
        highlight
          .getMarker()
          .getBufferRange()
          .isEqual([
            [1, 0],
            [1, editor.lineTextForBufferRow(1).length],
          ]),
      ).toBe(true);
    });

    it("renders fenced code blocks as embedded read-only editors and destroys them on dismiss", async () => {
      addHoverProvider(async () => ({
        contents: { kind: "markdown", value: "```js\nlet x = 1;\n```\n\nSome docs." },
      }));
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();

      const item = overlayItem(editor);
      expect(item).not.toBeNull();
      const embedded = item.querySelector("lumine-text-editor");
      expect(embedded).not.toBeNull();
      const model = embedded.getModel();
      expect(model.getText()).toBe("let x = 1;");
      expect(item.textContent).toContain("Some docs.");

      lumine.commands.dispatch(editorView, "hover:dismiss");
      expect(model.isDestroyed()).toBe(true);
    });

    it("sizes the tooltip to a code block when the answer is nothing else", async () => {
      // The overlay is as wide as what it holds, and an answer that is one
      // fenced signature holds a single embedded editor: it has to report its
      // own width or the tooltip collapses to its padding.
      addHoverProvider(async () => ({
        contents: { kind: "markdown", value: "```js\nfunction addTwoNumbers(a, b) {}\n```" },
      }));
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();

      // The overlay reaches the DOM on the editor's next render, and the code
      // block measures itself the moment it lands there.
      const item = overlayItem(editor);
      editorView.getComponent().updateSync();
      expect(item.isConnected).toBe(true);
      expect(item.getBoundingClientRect().width).toBeGreaterThan(100);
    });

    it("renders plaintext contents literally and keeps raw HTML in markdown as text", async () => {
      addHoverProvider(async () => ({
        contents: { kind: "plaintext", value: "a < b & c" },
      }));
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      expect(overlayItem(editor).querySelector(".hover-plaintext").textContent).toBe("a < b & c");
      lumine.commands.dispatch(editorView, "hover:dismiss");

      addHoverProvider(async () => ({
        contents: { kind: "markdown", value: "Mentions <pre> tags in prose." },
      }));
      // The first registered provider answers null so the second one is asked.
      const providers = mainModule.overlayManager.hoverRegistry.providers;
      providers[0].hover = async () => null;
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      const item = overlayItem(editor);
      expect(item.querySelector("pre")).toBeNull();
      expect(item.textContent).toContain("<pre>");
    });

    it("shows nothing when every provider answers null", async () => {
      const hover = jasmine.createSpy("hover").and.resolveTo(null);
      addHoverProvider(hover);
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      expect(hover).toHaveBeenCalled();
      expect(overlayDecorations(editor).length).toBe(0);
      expect(editorView.classList.contains("hover-active")).toBe(false);
    });
  });

  describe("signature help", () => {
    it("shows the active signature when a trigger character is typed", async () => {
      const provider = addSignatureProvider();
      editor.setText("add");
      editor.setCursorBufferPosition([0, 3]);
      await microtasks();

      editor.insertText("(");
      await microtasks();

      expect(provider.getSignature).toHaveBeenCalled();
      const [signatureEditor, point, context] = provider.getSignature.calls.mostRecent().args;
      expect(signatureEditor).toBe(editor);
      expect(point.isEqual([0, 4])).toBe(true);
      expect(context).toEqual({ triggerKind: 2, triggerCharacter: "(", isRetrigger: false });

      const decorations = overlayDecorations(editor);
      expect(decorations.length).toBe(1);
      const item = decorations[0].getProperties().item;
      expect(item.querySelector(".hover-signature").textContent).toBe(
        "add(a: number, b: number): number",
      );
      expect(item.querySelector(".hover-active-parameter").textContent).toBe("a: number");
      // The active parameter's documentation is rendered as markdown.
      expect(item.querySelector("strong").textContent).toBe("first");
      // The signature documentation is excluded by default.
      expect(item.textContent).not.toContain("Adds two numbers.");
    });

    it("keeps an open overlay updating on retrigger characters", async () => {
      const provider = addSignatureProvider();
      editor.setText("add");
      editor.setCursorBufferPosition([0, 3]);
      editor.insertText("(");
      await microtasks();
      expect(provider.getSignature.calls.count()).toBe(1);

      editor.insertText("1,");
      await microtasks();
      expect(provider.getSignature.calls.count()).toBe(2);
      expect(provider.getSignature.calls.mostRecent().args[2]).toEqual({
        triggerKind: 2,
        triggerCharacter: ",",
        isRetrigger: true,
      });
      expect(overlayDecorations(editor).length).toBe(1);

      // A retrigger character with no open overlay does not query the provider.
      lumine.commands.dispatch(editorView, "hover:dismiss");
      editor.insertText(",");
      await microtasks();
      expect(provider.getSignature.calls.count()).toBe(2);
      expect(overlayDecorations(editor).length).toBe(0);
    });

    it("re-reads the trigger character getters on every keystroke", async () => {
      const triggerCharacters = jasmine
        .createSpy("triggerCharacters")
        .and.callFake(() => new Set(["("]));
      addSignatureProvider({ triggerCharacters });
      editor.setText("add");
      editor.setCursorBufferPosition([0, 3]);
      await microtasks();

      editor.insertText("x");
      await microtasks();
      const readsAfterFirstKeystroke = triggerCharacters.calls.count();
      expect(readsAfterFirstKeystroke).toBeGreaterThan(0);

      editor.insertText("(");
      await microtasks();
      expect(triggerCharacters.calls.count()).toBeGreaterThan(readsAfterFirstKeystroke);
      expect(overlayDecorations(editor).length).toBe(1);
    });

    it("dismisses the overlay on escape and when the cursor leaves the row", async () => {
      addSignatureProvider();
      // A second row so the cursor can actually leave the signature's row.
      editor.setText("add\nnext");
      editor.setCursorBufferPosition([0, 3]);
      editor.insertText("(");
      await microtasks();
      expect(overlayDecorations(editor).length).toBe(1);

      lumine.commands.dispatch(editorView, "hover:dismiss");
      expect(overlayDecorations(editor).length).toBe(0);

      editor.insertText("1");
      await microtasks();
      lumine.commands.dispatch(editorView, "hover:toggle-signature-help");
      await microtasks();
      expect(overlayDecorations(editor).length).toBe(1);

      editor.setCursorBufferPosition([1, 0]);
      await microtasks();
      expect(overlayDecorations(editor).length).toBe(0);
    });

    it("does not trigger while typing when the setting is disabled, but the command still works", async () => {
      lumine.config.set("hover.showSignatureWhileTyping", false);
      const provider = addSignatureProvider();
      editor.setText("add");
      editor.setCursorBufferPosition([0, 3]);
      editor.insertText("(");
      await microtasks();
      expect(provider.getSignature).not.toHaveBeenCalled();
      expect(overlayDecorations(editor).length).toBe(0);

      lumine.commands.dispatch(editorView, "hover:toggle-signature-help");
      await microtasks();
      expect(provider.getSignature).toHaveBeenCalled();
      expect(provider.getSignature.calls.mostRecent().args[2]).toEqual({
        triggerKind: 1,
        isRetrigger: false,
      });
      expect(overlayDecorations(editor).length).toBe(1);
    });
  });
});
