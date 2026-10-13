describe("hover status action menu", () => {
  let main;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("status-bar");
    main = (await lumine.packages.activatePackage("hover")).mainModule;
    lumine.config.set("hover.statusBar", true);
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("hover");
    await lumine.workspace.discardEditorWindows();
  });
  it("shows the shared workspace state and keeps click and keyboard on the same command", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const domWindow = extra.getDOMWindow();
    const local = main.overlayManager;
    const remote = main.getManager(extra);
    const element = remote.traceStatusElement;
    const menu = () => lumine.contextMenu.templateForElement(element);
    expect(menu().map((item) => item.command)).toEqual(["hover:toggle-trace"]);
    expect(menu()[0].mouseBindingLabel).toBe("LMB");
    const [tooltip] = lumine.tooltips.findTooltips(element);
    expect(tooltip.options.keyBindingCommand).toBeUndefined();
    expect(tooltip.getTitle()).toContain("Click to toggle.");
    element.dispatchEvent(new domWindow.MouseEvent("click", { button: 2 }));
    expect(remote.trace).toBe(true);
    element.click();
    expect(remote.trace).toBe(false);
    expect(menu()[0].checked).toBe(false);
    expect(local.trace).toBe(false);
    element.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter" }));
    expect(menu()[0].checked).toBe(true);
    lumine.commands.dispatch(element, menu()[0].command);
    expect(remote.trace).toBe(false);
    lumine.config.set("hover.statusBar", false);
    expect(menu()).toEqual([]);
    element.click();
    expect(remote.trace).toBe(false);
  });
});
