const { Readable } = require("stream");
const { TextBuffer } = require("lumine");

const SIGNATURE_HELP = {
  signatures: [{ label: "add(value)", parameters: [{ label: "value" }] }],
  activeSignature: 0,
  activeParameter: 0,
};

async function microtasks() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

describe("Signature help across external reloads", () => {
  let main, editor, source, lease;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("documentation-view");
    main = (await lumine.packages.activatePackage("hover")).mainModule;
    source = {
      text: "add",
      getPath: () => null,
      existsSync: () => true,
      createReadStream() {
        return Readable.from([this.text]);
      },
      onDidChange() {
        return { dispose() {} };
      },
    };
    const buffer = await TextBuffer.load(source);
    editor = lumine.workspace.buildTextEditor({ buffer });
    lumine.workspace.getActivePane().addItem(editor);
    editor.setCursorBufferPosition([0, 3]);
    lumine.views.getView(editor).focus();
    await microtasks();
  });

  afterEach(async () => {
    lease?.dispose();
    editor?.destroy();
    await lumine.packages.deactivatePackage("hover");
    await lumine.packages.deactivatePackage("documentation-view");
    editor = source = lease = main = null;
  });

  function provideSignature(getSignature) {
    const provider = {
      packageName: "reload-signature",
      grammarScopes: [editor.getGrammar().scopeName],
      triggerCharacters: new Set(["("]),
      retriggerCharacters: new Set([","]),
      getSignature:
        getSignature ?? jasmine.createSpy("getSignature").and.callFake(async () => SIGNATURE_HELP),
    };
    lease = main.consumeHoverSignature(provider);
    return provider;
  }

  function overlays() {
    return editor
      .getOverlayDecorations()
      .filter((decoration) => decoration.getProperties().class === "hover-overlay");
  }

  it("ignores a reloaded trigger while allowing the next typed trigger", async () => {
    const provider = provideSignature();
    source.text = "add(";
    await editor.getBuffer().load({ internal: true });
    await microtasks();

    expect(provider.getSignature).not.toHaveBeenCalled();
    expect(overlays().length).toBe(0);
    expect(editor.getFileState()).toBe("unmodified");

    editor.insertText("(");
    await microtasks();
    expect(provider.getSignature.calls.count()).toBe(1);
    expect(provider.getSignature.calls.mostRecent().args[2]).toEqual({
      triggerKind: 2,
      triggerCharacter: "(",
      isRetrigger: false,
    });
    expect(overlays().length).toBe(1);
  });

  it("retires a pending signature request when the source reloads", async () => {
    let finish;
    const getSignature = jasmine.createSpy("getSignature").and.callFake(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    provideSignature(getSignature);
    lumine.commands.dispatch(lumine.views.getView(editor), "hover:toggle-signature-help");
    await microtasks();
    expect(getSignature.calls.count()).toBe(1);

    source.text = "add(";
    await editor.getBuffer().load({ internal: true });
    finish(SIGNATURE_HELP);
    await microtasks();

    expect(getSignature.calls.count()).toBe(1);
    expect(overlays().length).toBe(0);
    expect(main.overlayManager.requestController).toBeNull();
  });

  it("dismisses visible signature help when the source reloads", async () => {
    const provider = provideSignature();
    lumine.commands.dispatch(lumine.views.getView(editor), "hover:toggle-signature-help");
    await microtasks();
    expect(overlays().length).toBe(1);

    source.text = "add(";
    await editor.getBuffer().load({ internal: true });
    await microtasks();

    expect(provider.getSignature.calls.count()).toBe(1);
    expect(overlays().length).toBe(0);
  });

  it("retires a pending signature when a forced reload has no text difference", async () => {
    let finish;
    const getSignature = jasmine.createSpy("getSignature").and.callFake(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    provideSignature(getSignature);
    lumine.commands.dispatch(lumine.views.getView(editor), "hover:toggle-signature-help");
    await microtasks();
    expect(getSignature.calls.count()).toBe(1);

    await editor.getBuffer().load({ internal: true, discardChanges: true });
    finish(SIGNATURE_HELP);
    await microtasks();

    expect(getSignature.calls.count()).toBe(1);
    expect(overlays().length).toBe(0);
    expect(main.overlayManager.requestController).toBeNull();
  });

  it("dismisses visible signature help on a forced reload without text changes", async () => {
    const provider = provideSignature();
    lumine.commands.dispatch(lumine.views.getView(editor), "hover:toggle-signature-help");
    await microtasks();
    expect(overlays().length).toBe(1);

    await editor.getBuffer().load({ internal: true, discardChanges: true });
    await microtasks();

    expect(provider.getSignature.calls.count()).toBe(1);
    expect(overlays().length).toBe(0);
  });
});
