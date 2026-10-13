describe("shared hover tracing and window-local presentations", () => {
  let main, providerLease;
  const result = {
    signatures: [{ label: "call(value)", parameters: [{ label: "value" }] }],
    activeSignature: 0,
    activeParameter: 0,
  };
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("status-bar");
    main = (await lumine.packages.activatePackage("hover")).mainModule;
    lumine.config.set("hover.statusBar", true);
  });
  afterEach(async () => {
    providerLease?.dispose();
    await lumine.packages.deactivatePackage("hover");
    await lumine.workspace.discardEditorWindows();
  });
  it("shares trace while keeping signature overlays, selection and dismissal local", async () => {
    const workspace = lumine.workspace;
    const first = await workspace.open();
    first.setText("call(value)");
    const extra = await workspace.openEditorWindow({ show: false });
    const second = workspace.buildTextEditor();
    second.setText("call(value)");
    extra.getEditorContainer().getActivePane().activateItem(second, { activatePane: true });
    const provider = { getSignature: jasmine.createSpy("signature").and.resolveTo(result) };
    providerLease = main.consumeHoverSignature(provider);
    const local = main.overlayManager,
      remote = main.getManager(extra);
    expect(local.signatureRegistry).toBe(remote.signatureRegistry);
    await lumine.commands.dispatch(first.getElement(), "hover:toggle-signature-help");
    await lumine.commands.dispatch(second.getElement(), "hover:toggle-signature-help");
    expect(provider.getSignature.calls.count()).toBe(2);
    expect(local.overlayEditor).toBe(first);
    expect(remote.overlayEditor).toBe(second);
    expect(remote.overlayElement.ownerDocument).toBe(extra.getDocument());
    const range = extra.getDocument().createRange();
    range.selectNodeContents(remote.overlayElement.querySelector("code"));
    const selection = extra.getDocument().defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    expect(remote.overlaySelection()).toBe("call(value)");
    expect(local.overlaySelection()).toBe("");
    await lumine.commands.dispatch(extra.getElement(), "hover:toggle-trace");
    expect(local.trace).toBe(false);
    expect(remote.trace).toBe(false);
    expect(remote.traceStatusElement.ownerDocument).toBe(extra.getDocument());
    await lumine.commands.dispatch(second.getElement(), "hover:dismiss");
    expect(remote.overlayElement).toBeNull();
    expect(local.overlayElement).not.toBeNull();
    await workspace.detachPane(workspace.paneForItem(first), { window: extra });
    expect(local.overlayElement).toBeNull();
    await workspace.closeEditorWindow(extra);
    expect(main.managers.has(extra)).toBe(false);
    expect(remote.disposed).toBe(true);
  });
  it("synchronizes every icon and gives future windows the current workspace mode", async () => {
    const workspace = lumine.workspace;
    const extra = await workspace.openEditorWindow({ show: false });
    const local = main.overlayManager;
    const remote = main.getManager(extra);
    remote.traceStatusElement.click();
    expect(main.trace).toBeFalse();
    expect(local.trace).toBeFalse();
    expect(remote.trace).toBeFalse();
    expect(local.traceStatusElement.getAttribute("aria-pressed")).toBe("false");
    expect(remote.traceStatusElement.getAttribute("aria-pressed")).toBe("false");
    expect(lumine.config.get("hover.trace")).toBeTrue();
    const future = await workspace.openEditorWindow({ show: false });
    const futureManager = main.getManager(future);
    expect(futureManager.trace).toBeFalse();
    expect(futureManager.traceStatusElement.classList.contains("active")).toBeFalse();
    futureManager.traceStatusElement.dispatchEvent(
      new (future.getDOMWindow().KeyboardEvent)("keydown", { key: " ", bubbles: true }),
    );
    for (const manager of main.managers.values()) {
      expect(manager.trace).toBeTrue();
      expect(manager.traceStatusElement.getAttribute("aria-pressed")).toBe("true");
    }
    await workspace.closeEditorWindow(extra);
    local.traceStatusElement.click();
    expect(local.trace).toBeFalse();
    expect(futureManager.trace).toBeFalse();
    lumine.config.set("hover.trace", false);
    lumine.config.set("hover.trace", true);
    expect(local.trace).toBeTrue();
    expect(futureManager.trace).toBeTrue();
  });
  it("does not let a retired presentation toggle the replacement workspace mode", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const retired = main.getManager(extra);
    const retiredToggle = retired.onToggleTrace;
    await lumine.packages.deactivatePackage("hover");
    main = (await lumine.packages.activatePackage("hover")).mainModule;
    expect(main.trace).toBeTrue();
    retiredToggle();
    retired.toggleTrace();
    expect(main.trace).toBeTrue();
    expect(main.overlayManager.trace).toBeTrue();
    expect(main.getManager(extra).trace).toBeTrue();
  });
});
