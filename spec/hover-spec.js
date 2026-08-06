const path = require("path");
const { CompositeDisposable } = require("atom");

const packageRoot = path.join(__dirname, "..");

// Flushes pending microtasks so async provider/render chains settle without
// advancing the fake clock.
async function microtasks(count = 40) {
  for (let i = 0; i < count; i++) await Promise.resolve();
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

describe("hover", () => {
  let mainModule;
  let editor;
  let editorView;
  let disposables;
  let hoverTime;

  beforeEach(async () => {
    jasmine.attachToDOM(atom.views.getView(atom.workspace));
    disposables = new CompositeDisposable();

    const pack = await atom.packages.activatePackage(packageRoot);
    mainModule = pack.mainModule;
    hoverTime = atom.config.get("hover.hoverTime");

    editor = await atom.workspace.open();
    editor.setText("add\nsecond line\n");
    editor.setCursorBufferPosition([0, 0]);
    editorView = atom.views.getView(editor);
    editorView.focus();
    await microtasks();
  });

  afterEach(async () => {
    disposables.dispose();
    await atom.packages.deactivatePackage("hover");
    for (const open of atom.workspace.getTextEditors()) open.destroy();
  });

  function addHoverProvider(hover) {
    const provider = {
      name: "Hover Stub",
      packageName: "hover-spec",
      priority: 1,
      get grammarScopes() {
        return [editor.getGrammar().scopeName];
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
  } = {}) {
    const provider = {
      name: "Signature Stub",
      packageName: "hover-spec",
      priority: 1,
      get grammarScopes() {
        return [editor.getGrammar().scopeName];
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

      atom.commands.dispatch(editorView, "hover:toggle");
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
      atom.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      expect(overlayDecorations(editor).length).toBe(0);
    });

    it("honors the hover delay when showing on cursor rest", async () => {
      atom.config.set("hover.showOnCursorMove", true);
      const hover = jasmine.createSpy("hover").and.callFake(async () => ({
        contents: { kind: "markdown", value: "docs" },
      }));
      addHoverProvider(hover);

      editor.setCursorBufferPosition([0, 2]);
      await microtasks();
      expect(hover).not.toHaveBeenCalled();

      advanceClock(hoverTime - 1);
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
      atom.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      expect(overlayDecorations(editor).length).toBe(1);

      // While an overlay is open the editor carries the class that scopes the
      // escape keybinding to it.
      expect(editorView.classList.contains("hover-active")).toBe(true);
      const bindings = atom.keymaps
        .findKeyBindings({ keystrokes: "escape", target: editorView })
        .map((binding) => binding.command);
      expect(bindings).toContain("hover:dismiss");

      atom.commands.dispatch(editorView, "hover:dismiss");
      expect(overlayDecorations(editor).length).toBe(0);
      expect(editorView.classList.contains("hover-active")).toBe(false);
    });

    it("dismisses the tooltip when the cursor leaves the hovered range", async () => {
      addHoverProvider(async () => ({
        range: [
          [0, 0],
          [0, 3],
        ],
        contents: { kind: "markdown", value: "docs" },
      }));
      atom.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      expect(overlayDecorations(editor).length).toBe(1);

      editor.setCursorBufferPosition([1, 3]);
      advanceClock(hoverTime);
      await microtasks();
      expect(overlayDecorations(editor).length).toBe(0);
    });

    it("renders fenced code blocks as embedded read-only editors and destroys them on dismiss", async () => {
      addHoverProvider(async () => ({
        contents: { kind: "markdown", value: "```js\nlet x = 1;\n```\n\nSome docs." },
      }));
      atom.commands.dispatch(editorView, "hover:toggle");
      await microtasks();

      const item = overlayItem(editor);
      expect(item).not.toBeNull();
      const embedded = item.querySelector("atom-text-editor");
      expect(embedded).not.toBeNull();
      const model = embedded.getModel();
      expect(model.getText()).toBe("let x = 1;");
      expect(item.textContent).toContain("Some docs.");

      atom.commands.dispatch(editorView, "hover:dismiss");
      expect(model.isDestroyed()).toBe(true);
    });

    it("sizes the tooltip to a code block when the answer is nothing else", async () => {
      // The overlay is as wide as what it holds, and an answer that is one
      // fenced signature holds a single embedded editor: it has to report its
      // own width or the tooltip collapses to its padding.
      addHoverProvider(async () => ({
        contents: { kind: "markdown", value: "```js\nfunction addTwoNumbers(a, b) {}\n```" },
      }));
      atom.commands.dispatch(editorView, "hover:toggle");
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
      atom.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      expect(overlayItem(editor).querySelector(".hover-plaintext").textContent).toBe("a < b & c");
      atom.commands.dispatch(editorView, "hover:dismiss");

      addHoverProvider(async () => ({
        contents: { kind: "markdown", value: "Mentions <pre> tags in prose." },
      }));
      // The first registered provider answers null so the second one is asked.
      const providers = mainModule.overlayManager.hoverRegistry.providers;
      providers[0].hover = async () => null;
      atom.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      const item = overlayItem(editor);
      expect(item.querySelector("pre")).toBeNull();
      expect(item.textContent).toContain("<pre>");
    });

    it("shows nothing when every provider answers null", async () => {
      const hover = jasmine.createSpy("hover").and.resolveTo(null);
      addHoverProvider(hover);
      atom.commands.dispatch(editorView, "hover:toggle");
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
      atom.commands.dispatch(editorView, "hover:dismiss");
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

      atom.commands.dispatch(editorView, "hover:dismiss");
      expect(overlayDecorations(editor).length).toBe(0);

      editor.insertText("1");
      await microtasks();
      atom.commands.dispatch(editorView, "hover:toggle-signature-help");
      await microtasks();
      expect(overlayDecorations(editor).length).toBe(1);

      editor.setCursorBufferPosition([1, 0]);
      await microtasks();
      expect(overlayDecorations(editor).length).toBe(0);
    });

    it("does not trigger while typing when the setting is disabled, but the command still works", async () => {
      atom.config.set("hover.showSignatureWhileTyping", false);
      const provider = addSignatureProvider();
      editor.setText("add");
      editor.setCursorBufferPosition([0, 3]);
      editor.insertText("(");
      await microtasks();
      expect(provider.getSignature).not.toHaveBeenCalled();
      expect(overlayDecorations(editor).length).toBe(0);

      atom.commands.dispatch(editorView, "hover:toggle-signature-help");
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
