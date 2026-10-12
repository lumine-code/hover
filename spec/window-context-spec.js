describe("window-local hover presentations", () => {
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
  it("keeps local trace, signature overlays, selection and dismissal in each window", async () => {
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
    expect(local.trace).toBe(true);
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
});
