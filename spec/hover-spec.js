const path = require("path");
const { CompositeDisposable, Disposable, Point } = require("lumine");

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

describe("hover", () => {
  let mainModule;
  let contextHelpModule;
  let editor;
  let editorView;
  let disposables;
  let showDelay;
  let hideDelay;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    disposables = new CompositeDisposable();

    const helpPack = await lumine.packages.activatePackage("documentation-view");
    contextHelpModule = helpPack.mainModule;
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
    await lumine.packages.deactivatePackage("documentation-view");
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
      getHelp: hover,
    };
    disposables.add(contextHelpModule.consumeContextHelp(provider));
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

  describe("trace mode", () => {
    it("takes its initial state from config and resets a local override on activation", async () => {
      lumine.config.set("hover.trace", false);
      await lumine.packages.deactivatePackage("hover");
      mainModule = (await lumine.packages.activatePackage(packageRoot)).mainModule;
      expect(mainModule.overlayManager.trace).toBe(false);

      mainModule.overlayManager.toggleTrace();
      expect(mainModule.overlayManager.trace).toBe(true);
      expect(lumine.config.get("hover.trace")).toBe(false);

      await lumine.packages.deactivatePackage("hover");
      mainModule = (await lumine.packages.activatePackage(packageRoot)).mainModule;
      expect(mainModule.overlayManager.trace).toBe(false);
    });

    it("uses config changes to replace the local override", () => {
      expect(mainModule.overlayManager.trace).toBe(true);
      mainModule.overlayManager.toggleTrace();
      expect(mainModule.overlayManager.trace).toBe(false);
      expect(lumine.config.get("hover.trace")).toBe(true);

      lumine.config.set("hover.trace", false);
      mainModule.overlayManager.toggleTrace();
      expect(mainModule.overlayManager.trace).toBe(true);
      expect(lumine.config.get("hover.trace")).toBe(false);

      lumine.config.set("hover.trace", true);
      expect(mainModule.overlayManager.trace).toBe(true);
      lumine.config.set("hover.trace", false);
      expect(mainModule.overlayManager.trace).toBe(false);
    });

    it("cancels pointer rest when disabled and resumes tracking when enabled", async () => {
      const hover = jasmine.createSpy("hover").and.resolveTo({
        contents: { kind: "markdown", value: "pointer docs" },
      });
      addHoverProvider(hover);
      const point = pixelFor([0, 1]);
      movePointerTo(point);
      mainModule.overlayManager.toggleTrace();
      advanceClock(showDelay);
      await microtasks();
      expect(hover).not.toHaveBeenCalled();

      movePointerTo(point);
      advanceClock(showDelay);
      await microtasks();
      expect(hover).not.toHaveBeenCalled();

      mainModule.overlayManager.toggleTrace();
      movePointerTo(point);
      advanceClock(showDelay);
      await microtasks();
      expect(hover).toHaveBeenCalledTimes(1);
      expect(overlayItem(editor).textContent).toContain("pointer docs");
    });

    it("rejects a pointer answer even after tracking is enabled again", async () => {
      let resolveHelp;
      addHoverProvider(
        () =>
          new Promise((resolve) => {
            resolveHelp = resolve;
          }),
      );
      movePointerTo(pixelFor([0, 1]));
      advanceClock(showDelay);
      await microtasks();
      expect(resolveHelp).toBeDefined();

      mainModule.overlayManager.toggleTrace();
      mainModule.overlayManager.toggleTrace();
      resolveHelp({ contents: { kind: "markdown", value: "stale pointer docs" } });
      await microtasks();
      expect(overlayItem(editor)).toBeNull();
    });

    it("keeps command and cursor hover available when tracking is disabled", async () => {
      lumine.config.set("hover.trace", false);
      lumine.config.set("hover.showOnCursorMove", true);
      const hover = jasmine.createSpy("hover").and.resolveTo({
        contents: { kind: "markdown", value: "cursor docs" },
      });
      addHoverProvider(hover);

      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      expect(overlayItem(editor).textContent).toContain("cursor docs");
      lumine.commands.dispatch(editorView, "hover:dismiss");
      hover.calls.reset();

      editor.setCursorBufferPosition([0, 2]);
      advanceClock(showDelay);
      await microtasks();
      expect(hover).toHaveBeenCalledTimes(1);
      expect(overlayItem(editor).textContent).toContain("cursor docs");
      expect(mainModule.overlayManager.trace).toBe(false);
    });

    it("toggles once from workspace descendants without notifications when the icon is hidden", () => {
      spyOn(lumine.notifications, "addInfo");
      lumine.commands.dispatch(editorView, "hover:toggle-trace");
      expect(mainModule.overlayManager.trace).toBe(false);
      expect(lumine.notifications.addInfo).not.toHaveBeenCalled();
      expect(lumine.config.get("hover.trace")).toBe(true);

      lumine.commands.dispatch(lumine.views.getView(lumine.workspace), "hover:toggle-trace");
      expect(mainModule.overlayManager.trace).toBe(true);
      expect(lumine.notifications.addInfo).not.toHaveBeenCalled();
    });

    it("dispatches Ctrl-H from an editor and a panel through the workspace keymap", () => {
      const panelItem = document.createElement("div");
      const control = document.createElement("button");
      panelItem.appendChild(control);
      const panel = lumine.workspace.addBottomPanel({ item: panelItem });
      disposables.add(new Disposable(() => panel.destroy()));

      for (const [target, trace] of [
        [editorView, false],
        [control, true],
      ]) {
        const bindings = lumine.keymaps.findKeyBindings({ keystrokes: "ctrl-h", target });
        expect(
          bindings.some(
            ({ command, selector }) =>
              command === "hover:toggle-trace" && selector === "lumine-workspace",
          ),
        ).toBe(true);
        lumine.keymaps.handleKeyboardEvent(
          lumine.keymaps.constructor.buildKeydownEvent("h", { ctrl: true, target }),
        );
        expect(mainModule.overlayManager.trace).toBe(trace);
        expect(lumine.config.get("hover.trace")).toBe(true);
      }
    });
  });

  describe("trace status bar", () => {
    let statusBar;
    let statusSubscription;
    let tiles;
    let tooltipDisposals;

    beforeEach(() => {
      tiles = [];
      tooltipDisposals = [];
      statusBar = {
        addRightTile: jasmine.createSpy("addRightTile").and.callFake(({ item }) => {
          jasmine.attachToDOM(item);
          const tile = {
            item,
            destroy: jasmine.createSpy("destroy tile").and.callFake(() => item.remove()),
          };
          tiles.push(tile);
          return tile;
        }),
      };
      spyOn(lumine.tooltips, "add").and.callFake(() => {
        const dispose = jasmine.createSpy("dispose tooltip");
        tooltipDisposals.push(dispose);
        return new Disposable(dispose);
      });
      statusSubscription = mainModule.consumeStatusBar(statusBar);
      disposables.add(statusSubscription);
    });

    it("shows an optional right-side icon whose state follows local and config changes", () => {
      expect(lumine.config.get("hover.statusBar")).toBe(false);
      expect(statusBar.addRightTile).not.toHaveBeenCalled();
      lumine.config.set("hover.statusBar", true);
      expect(statusBar.addRightTile).toHaveBeenCalledTimes(1);
      const item = tiles[0].item;
      expect(statusBar.addRightTile.calls.mostRecent().args[0].priority).toBe(245);
      expect(item.matches("status-bar-tile.hover-trace-status.active")).toBe(true);
      expect(item.querySelector(".icon.is-icon-only.icon-eye")).not.toBeNull();
      expect(item.textContent).toBe("");
      expect(item.getAttribute("aria-label")).toMatch(/enabled/i);
      expect(lumine.tooltips.add.calls.mostRecent().args[0]).toBe(item);
      const tooltip = lumine.tooltips.add.calls.mostRecent().args[1];
      expect(tooltip.title()).toMatch(/enabled/i);
      expect(tooltip.keyBindingCommand).toBe("hover:toggle-trace");

      item.click();
      expect(mainModule.overlayManager.trace).toBe(false);
      expect(lumine.config.get("hover.trace")).toBe(true);
      expect(item.classList.contains("active")).toBe(false);
      expect(item.getAttribute("aria-label")).toMatch(/disabled/i);
      expect(tooltip.title()).toMatch(/disabled/i);

      lumine.config.set("hover.trace", false);
      lumine.config.set("hover.trace", true);
      expect(item.classList.contains("active")).toBe(true);
      expect(item.getAttribute("aria-label")).toMatch(/enabled/i);
    });

    it("toggles without notifications and recreates the icon with the current local state", () => {
      spyOn(lumine.notifications, "addInfo");
      lumine.config.set("hover.statusBar", true);
      lumine.commands.dispatch(editorView, "hover:toggle-trace");
      expect(lumine.notifications.addInfo).not.toHaveBeenCalled();
      expect(tiles[0].item.classList.contains("active")).toBe(false);

      lumine.config.set("hover.statusBar", false);
      expect(tiles[0].destroy).toHaveBeenCalledTimes(1);
      expect(tooltipDisposals[0]).toHaveBeenCalledTimes(1);
      lumine.commands.dispatch(editorView, "hover:toggle-trace");
      expect(lumine.notifications.addInfo).not.toHaveBeenCalled();

      lumine.config.set("hover.statusBar", true);
      expect(statusBar.addRightTile).toHaveBeenCalledTimes(2);
      expect(tiles[1].item.classList.contains("active")).toBe(true);
    });

    it("destroys its tile and tooltip when the service disconnects and on deactivation", async () => {
      lumine.config.set("hover.statusBar", true);
      const disconnectedTile = tiles[0];
      const disconnectedTooltip = tooltipDisposals[0];
      statusSubscription.dispose();
      expect(disconnectedTile.destroy).toHaveBeenCalledTimes(1);
      expect(disconnectedTooltip).toHaveBeenCalledTimes(1);

      disposables.add(mainModule.consumeStatusBar(statusBar));
      const deactivatedTile = tiles[tiles.length - 1];
      const deactivatedTooltip = tooltipDisposals[tooltipDisposals.length - 1];
      await lumine.packages.deactivatePackage("hover");
      expect(deactivatedTile.destroy).toHaveBeenCalledTimes(1);
      expect(deactivatedTooltip).toHaveBeenCalledTimes(1);

      mainModule = (await lumine.packages.activatePackage(packageRoot)).mainModule;
      disposables.add(mainModule.consumeStatusBar(statusBar));
      const activeTile = tiles[tiles.length - 1];
      expect(activeTile.item.classList.contains("active")).toBe(true);
      activeTile.item.click();
      expect(mainModule.overlayManager.trace).toBe(false);
    });
  });

  describe("shared context help lifecycle", () => {
    it("does not mount a request that completes after dismissal", async () => {
      let resolveHelp;
      let signal;
      addHoverProvider(
        (_editor, _position, context) =>
          new Promise((resolve) => {
            resolveHelp = resolve;
            signal = context.signal;
          }),
      );
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      lumine.commands.dispatch(editorView, "hover:dismiss");
      expect(signal.aborted).toBe(true);
      resolveHelp({ contents: { kind: "markdown", value: "late docs" } });
      await microtasks();
      expect(overlayItem(editor)).toBeNull();
    });

    it("keeps the newer request when an older provider finishes last", async () => {
      const answers = [];
      addHoverProvider(
        () =>
          new Promise((resolve) => {
            answers.push(resolve);
          }),
      );
      const manager = mainModule.overlayManager;
      const older = manager.showHoverOverlay(editor, new Point(0, 0));
      await microtasks();
      const newer = manager.showHoverOverlay(editor, new Point(0, 1));
      await microtasks();
      answers[1]({ contents: { kind: "markdown", value: "newer docs" } });
      await newer;
      answers[0]({ contents: { kind: "markdown", value: "older docs" } });
      await older;
      expect(overlayItem(editor).textContent).toContain("newer docs");
      expect(overlayItem(editor).textContent).not.toContain("older docs");
    });

    it("disposes a rendered node when dismissal wins the rendering race", async () => {
      addHoverProvider(async () => ({ contents: { kind: "markdown", value: "docs" } }));
      let finishRender;
      const dispose = jasmine.createSpy("dispose rendered content");
      const manager = mainModule.overlayManager;
      const registry = manager.contextHelp;
      disposables.add(
        mainModule.consumeContextHelp({
          request: (...args) => registry.request(...args),
          render: () =>
            new Promise((resolve) => {
              finishRender = resolve;
            }),
        }),
      );
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      lumine.commands.dispatch(editorView, "hover:dismiss");
      finishRender({ element: document.createElement("div"), dispose });
      await microtasks();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(overlayItem(editor)).toBeNull();
    });

    it("cancels requests when the source editor is destroyed", async () => {
      let resolveHelp;
      addHoverProvider(
        () =>
          new Promise((resolve) => {
            resolveHelp = resolve;
          }),
      );
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      editor.destroy();
      resolveHelp({ contents: { kind: "markdown", value: "late docs" } });
      await microtasks();
      expect(mainModule.overlayManager.overlayElement).toBeNull();
    });

    it("cancels requests when the registry service disappears", async () => {
      let resolveHelp;
      addHoverProvider(
        () =>
          new Promise((resolve) => {
            resolveHelp = resolve;
          }),
      );
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      await lumine.packages.deactivatePackage("documentation-view");
      resolveHelp({ contents: { kind: "markdown", value: "late docs" } });
      await microtasks();
      expect(mainModule.overlayManager.contextHelp).toBeNull();
      expect(overlayItem(editor)).toBeNull();
    });

    it("keeps visible signature help when the documentation registry disconnects and reconnects", async () => {
      addSignatureProvider();
      lumine.commands.dispatch(editorView, "hover:toggle-signature-help");
      await microtasks();
      const item = overlayItem(editor);
      expect(item.querySelector(".hover-signature")).not.toBeNull();
      await lumine.packages.deactivatePackage("documentation-view");
      expect(mainModule.overlayManager.contextHelp).toBeNull();
      expect(overlayItem(editor)).toBe(item);
      await lumine.packages.activatePackage("documentation-view");
      expect(mainModule.overlayManager.contextHelp).not.toBeNull();
      expect(overlayItem(editor)).toBe(item);
    });

    it("removes documentation without aborting a signature request already replacing it", async () => {
      addHoverProvider(async () => ({ contents: { kind: "markdown", value: "docs" } }));
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      expect(overlayItem(editor).textContent).toContain("docs");
      let resolveSignature;
      addSignatureProvider({
        getSignature: () =>
          new Promise((resolve) => {
            resolveSignature = resolve;
          }),
      });
      lumine.commands.dispatch(editorView, "hover:toggle-signature-help");
      await microtasks();
      await lumine.packages.deactivatePackage("documentation-view");
      expect(overlayItem(editor)).toBeNull();
      resolveSignature(structuredClone(SIGNATURE_HELP));
      await microtasks();
      expect(overlayItem(editor).querySelector(".hover-signature")).not.toBeNull();
    });

    it("keeps a visible signature while cancelling a pending documentation request", async () => {
      addSignatureProvider();
      lumine.commands.dispatch(editorView, "hover:toggle-signature-help");
      await microtasks();
      const item = overlayItem(editor);
      let resolveHelp;
      addHoverProvider(
        () =>
          new Promise((resolve) => {
            resolveHelp = resolve;
          }),
      );
      const request = mainModule.overlayManager.showHoverOverlay(editor, new Point(0, 1));
      await microtasks();
      await lumine.packages.deactivatePackage("documentation-view");
      resolveHelp({ contents: { kind: "markdown", value: "late documentation" } });
      await request;
      expect(overlayItem(editor)).toBe(item);
    });

    it("does not mount a provider result after the package is deactivated", async () => {
      let resolveHelp;
      addHoverProvider(
        () =>
          new Promise((resolve) => {
            resolveHelp = resolve;
          }),
      );
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      const manager = mainModule.overlayManager;
      await lumine.packages.deactivatePackage("hover");
      resolveHelp({ contents: { kind: "markdown", value: "late docs" } });
      await microtasks();
      expect(manager.overlayElement).toBeNull();
      expect(overlayItem(editor)).toBeNull();
    });

    it("lets the toolbar receive Enter without dismissing its subject first", async () => {
      addHoverProvider(async () => ({ contents: { kind: "markdown", value: "toolbar docs" } }));
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      const item = overlayItem(editor);
      editorView.getComponent().updateSync();
      await frames();
      const button = item.querySelector(".hover-open-documentation");
      expect(button.classList.contains("icon-book")).toBe(true);
      expect(button.textContent).toBe("");
      expect(button.getAttribute("aria-label")).toBe("Open in Documentation View");
      expect(button.title).toBe("Open in Documentation View");
      expect(getComputedStyle(button.parentElement).position).toBe("absolute");
      button.focus();
      expect(document.activeElement).toBe(button);
      expect(getComputedStyle(button.parentElement).opacity).toBe("1");
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(overlayItem(editor)).toBe(item);
      button.click();
      await microtasks();
      expect(overlayItem(editor)).toBeNull();
      expect(lumine.workspace.getRightDock().isVisible()).toBe(true);
    });

    async function showInteractiveContent(tag) {
      const clicked = jasmine.createSpy("provider action");
      addHoverProvider(async () => ({
        contents: {
          render() {
            const root = document.createElement("div");
            const control = document.createElement(tag);
            if (tag === "button") control.type = "button";
            else control.href = "#diagnostic-reference";
            control.className = "provider-source-action";
            const label = document.createElement("span");
            label.textContent = "Open source";
            control.appendChild(label);
            control.addEventListener("click", (event) => {
              event.preventDefault();
              clicked();
            });
            root.appendChild(control);
            return root;
          },
        },
      }));
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      editorView.getComponent().updateSync();
      await frames();
      const item = overlayItem(editor);
      const control = item.querySelector(".provider-source-action");
      control.focus();
      return { item, control, clicked };
    }

    for (const tag of ["button", "a"]) {
      it(`keeps a provider ${tag} focused for activation and keyboard navigation`, async () => {
        const { item, control, clicked } = await showInteractiveContent(tag);
        expect(document.activeElement).toBe(control);
        control.querySelector("span").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        expect(document.activeElement).toBe(control);
        const keydown = jasmine.createSpy("provider keydown");
        control.addEventListener("keydown", keydown);
        for (const key of ["Enter", " ", "Tab"]) {
          const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
          control.dispatchEvent(event);
          expect(keydown).toHaveBeenCalledWith(event);
          expect(event.defaultPrevented).toBe(false);
          expect(overlayItem(editor)).toBe(item);
          expect(document.activeElement).toBe(control);
        }
        control.click();
        expect(clicked).toHaveBeenCalledTimes(1);
        expect(overlayItem(editor)).toBe(item);
      });

      it(`returns typing from a provider ${tag} to the editor and dismisses the overlay`, async () => {
        const { control } = await showInteractiveContent(tag);
        control.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
        expect(overlayItem(editor)).toBeNull();
        expect(editorView.hasFocus()).toBe(true);
      });

      it(`dismisses a focused provider ${tag} on Escape even with modifiers`, async () => {
        const { control } = await showInteractiveContent(tag);
        control.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", ctrlKey: true, bubbles: true }),
        );
        expect(overlayItem(editor)).toBeNull();
      });
    }

    it("does not treat an outside button as an overlay action", async () => {
      const { item } = await showInteractiveContent("button");
      const outside = document.createElement("button");
      jasmine.attachToDOM(outside);
      outside.focus();
      outside.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(overlayItem(editor)).not.toBe(item);
      expect(overlayItem(editor)).toBeNull();
    });

    it("opens the same snapshot in the panel with fresh provider content", async () => {
      const created = [];
      const getHelp = jasmine.createSpy("getHelp").and.resolveTo({
        contents: {
          render() {
            const element = document.createElement("button");
            element.textContent = "Provider action";
            element.addEventListener("click", () => element.classList.add("clicked"));
            created.push(element);
            return element;
          },
        },
      });
      addHoverProvider(getHelp);
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      const item = overlayItem(editor);
      const button = item.querySelector(".hover-open-documentation");
      expect(button).not.toBeNull();
      const original = item.querySelector(".context-help-provided button");
      button.click();
      await microtasks();
      expect(getHelp).toHaveBeenCalledTimes(1);
      expect(created.length).toBe(2);
      expect(created[0]).toBe(original);
      expect(created[1]).not.toBe(original);
      expect(created[1].isConnected).toBe(true);
      created[1].click();
      expect(created[1].classList.contains("clicked")).toBe(true);
      expect(overlayItem(editor)).toBeNull();
      expect(editorView.hasFocus()).toBe(true);
    });

    it("hides the panel action when the optional panel service is removed", async () => {
      addHoverProvider(async () => ({ contents: { kind: "markdown", value: "docs" } }));
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      const manager = mainModule.overlayManager;
      const item = overlayItem(editor);
      expect(item.querySelector(".hover-open-documentation")).not.toBeNull();
      manager.setContextHelpPanel(null);
      expect(item.querySelector(".hover-open-documentation")).toBeNull();
      expect(overlayItem(editor)).toBe(item);
    });
  });

  describe("registered embedded editors", () => {
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

    it("ignores an unregistered hidden editor without building its view", () => {
      const hidden = lumine.workspace.buildTextEditor({ mini: false });
      const getView = spyOn(lumine.views, "getView").and.callThrough();
      disposables.add(
        new Disposable(() => {
          if (!hidden.isDestroyed()) hidden.destroy();
        }),
      );

      expect(mainModule.overlayManager.editorWatches.has(hidden)).toBe(false);
      expect(getView).not.toHaveBeenCalledWith(hidden);
    });

    it("watches a registered viewer as a normal surface", () => {
      const viewer = addRegisteredEditor("viewer");

      expect(mainModule.overlayManager.editorWatches.has(viewer.editor)).toBe(true);
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

      const sections = overlayItem(editor).querySelectorAll(".context-help-section");
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
      addHoverProvider(async () => ({ contents: { render: () => built } }));

      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();

      const item = overlayItem(editor);
      expect(item.querySelector(".provider-built")).toBe(built);
      // The popover drops its prose padding for a section that lays out its own.
      expect(item.querySelector(".context-help-section").classList).toContain(
        "context-help-provided",
      );
    });

    it("preserves tooltip scrolling, prose padding, plain-text breaks and overlay colors", async () => {
      addHoverProvider(async () => ({
        contents: { kind: "markdown", value: "```text\nexample\n```\n\nDocumentation." },
      }));
      addHoverProvider(async () => ({
        contents: { kind: "plaintext", value: "First line\nSecond line" },
      }));
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      const item = overlayItem(editor);
      item.style.setProperty("--overlay-border-color", "rgb(10, 20, 30)");
      item.style.setProperty("--ui-spacing", "12px");
      editorView.getComponent().updateSync();
      const content = item.querySelector(".context-help-content");
      const toolbar = item.querySelector(".hover-toolbar");
      const sections = item.querySelectorAll(".context-help-section");
      expect(getComputedStyle(toolbar).position).toBe("absolute");
      expect(item.offsetHeight).toBe(content.offsetHeight + 2);
      expect(getComputedStyle(content).overflowY).toBe("auto");
      expect(getComputedStyle(content).maxHeight).toBe("300px");
      expect(getComputedStyle(content).userSelect).toBe("text");
      expect(getComputedStyle(sections[0]).paddingTop).toBe("6px");
      expect(getComputedStyle(sections[0]).paddingLeft).toBe("12px");
      expect(getComputedStyle(sections[1]).borderTopColor).toBe("rgb(10, 20, 30)");
      expect(getComputedStyle(content.querySelector("lumine-text-editor")).borderTopColor).toBe(
        "rgb(10, 20, 30)",
      );
      expect(getComputedStyle(content.querySelector(".context-help-plaintext")).whiteSpace).toBe(
        "pre-wrap",
      );
    });

    it("asks about the row when the pointer rests on the gutter", async () => {
      const hover = jasmine.createSpy("hover").and.resolveTo(null);
      const hoverGutter = jasmine.createSpy("hoverGutter").and.callFake(async () => ({
        contents: { kind: "markdown", value: "two problems on this line" },
      }));
      const provider = addHoverProvider(hover);
      provider.getGutterHelp = hoverGutter;

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

    it("sizes an embedded code editor when global soft wrap is enabled", async () => {
      const previousSoftWrap = lumine.config.get("editor.softWrap");
      lumine.config.set("editor.softWrap", true);
      disposables.add(new Disposable(() => lumine.config.set("editor.softWrap", previousSoftWrap)));
      const code = "function wrappedHoverCode(a, b) {}";
      addHoverProvider(async () => ({
        contents: { kind: "markdown", value: `\`\`\`js\n${code}\n\`\`\`` },
      }));

      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();

      const item = overlayItem(editor);
      const embedded = item.querySelector("lumine-text-editor");
      const model = embedded.getModel();
      expect(model.isSoftWrapped()).toBe(true);
      expect(model.displayLayer.softWrapColumn).toBe(model.maxScreenLineLength);
      expect(model.getScreenLineCount()).toBe(1);
      expect(model.lineTextForScreenRow(0)).toBe(code);
      embedded.getComponent().updateSync();
      expect(item.getBoundingClientRect().width).toBeGreaterThan(100);
    });

    it("renders plaintext contents literally and keeps raw HTML in markdown as text", async () => {
      const plainProvider = addHoverProvider(async () => ({
        contents: { kind: "plaintext", value: "a < b & c" },
      }));
      lumine.commands.dispatch(editorView, "hover:toggle");
      await microtasks();
      expect(overlayItem(editor).querySelector(".context-help-plaintext").textContent).toBe(
        "a < b & c",
      );
      lumine.commands.dispatch(editorView, "hover:dismiss");

      addHoverProvider(async () => ({
        contents: { kind: "markdown", value: "Mentions <pre> tags in prose." },
      }));
      // The first registered provider answers null so the second one is asked.
      plainProvider.getHelp = async () => null;
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

  for (const type of ["hover", "signature-help"]) {
    describe(`${type} scrolling`, () => {
      let item;
      let content;
      let editorWheel;

      beforeEach(async () => {
        const previousScrollChaining = lumine.config.get("hover.scrollChaining");
        disposables.add(
          new Disposable(() => lumine.config.set("hover.scrollChaining", previousScrollChaining)),
        );
        const documentation = "Scrolling documentation.\n\n".repeat(50);
        if (type === "hover") {
          addHoverProvider(async () => ({
            contents: { kind: "plaintext", value: documentation },
          }));
        } else {
          const help = structuredClone(SIGNATURE_HELP);
          help.signatures[0].parameters[0].documentation = documentation;
          addSignatureProvider({ getSignature: async () => help });
        }
        lumine.commands.dispatch(
          editorView,
          `hover:toggle${type === "hover" ? "" : "-signature-help"}`,
        );
        await microtasks();

        item = overlayItem(editor);
        content = item.querySelector(".hover-overlay-view");
        content.style.maxHeight = "40px";
        editorView.getComponent().updateSync();
        expect(item.isConnected).toBe(true);
        expect(content.scrollHeight).toBeGreaterThan(content.clientHeight);

        editorWheel = jasmine.createSpy("editorWheel");
        editorView.addEventListener("wheel", editorWheel);
        disposables.add(new Disposable(() => editorView.removeEventListener("wheel", editorWheel)));
      });

      function wheel(deltaY, deltaX = 0) {
        editorWheel.calls.reset();
        const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, deltaX });
        content.firstElementChild.dispatchEvent(event);
        return event;
      }

      it("keeps scrolling inside the overlay by default, including at its boundaries", () => {
        expect(lumine.config.get("hover.scrollChaining")).toBe(false);
        for (const [scrollTop, deltaY, deltaX] of [
          [0, -100, 0],
          [10, 100, 0],
          [content.scrollHeight, 100, 0],
          [0, 0, 100],
        ]) {
          content.scrollTop = scrollTop;
          expect(wheel(deltaY, deltaX).defaultPrevented).toBe(false);
          expect(editorWheel).not.toHaveBeenCalled();
        }

        content.style.maxHeight = "none";
        expect(content.scrollHeight).toBe(content.clientHeight);
        expect(wheel(100).defaultPrevented).toBe(false);
        expect(editorWheel).not.toHaveBeenCalled();
      });

      it("passes scrolling to the editor only when enabled and the content cannot move", () => {
        lumine.config.set("hover.scrollChaining", true);
        for (const [scrollTop, deltaY, reachesEditor] of [
          [0, -100, true],
          [0, 100, false],
          [content.scrollHeight, 100, true],
          [content.scrollHeight, -100, false],
        ]) {
          content.scrollTop = scrollTop;
          const event = wheel(deltaY);
          expect(editorWheel.calls.count()).toBe(reachesEditor ? 1 : 0);
          if (!reachesEditor) expect(event.defaultPrevented).toBe(false);
        }

        content.style.maxHeight = "none";
        expect(content.scrollHeight).toBe(content.clientHeight);
        wheel(100);
        expect(editorWheel).toHaveBeenCalledTimes(1);
      });

      it("applies setting changes to an already open overlay", () => {
        content.scrollTop = content.scrollHeight;
        wheel(100);
        expect(editorWheel).not.toHaveBeenCalled();

        lumine.config.set("hover.scrollChaining", true);
        wheel(100);
        expect(editorWheel).toHaveBeenCalledTimes(1);

        lumine.config.set("hover.scrollChaining", false);
        wheel(100);
        expect(editorWheel).not.toHaveBeenCalled();
        expect(overlayItem(editor)).toBe(item);
      });
    });
  }

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
