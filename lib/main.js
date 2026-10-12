const OverlayManager = require("./overlay-manager");
const { CompositeDisposable, Disposable } = require("lumine");
const ProviderRegistry = require("./provider-registry");

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "hover",
      tips: [
        "You can read the documentation of the symbol under the cursor with {{ 'hover:toggle' | keystroke }}",
        "You can see the signature of the call you are inside with {{ 'hover:toggle-signature-help' | keystroke }}",
      ],
    };
  },

  activate() {
    this.managers = new Map();
    this.signatureRegistry = new ProviderRegistry();
    this.contextHelp = null;
    this.contextHelpPanel = null;
    this.subscriptions = new CompositeDisposable();
    this.subscriptions.add(
      lumine.workspace.observeWindows((window) => {
        const manager = this.getManager(window);
        const subscription = window.onWillDestroy(() => {
          this.managers.delete(window);
          manager.dispose();
          subscription.dispose();
        });
        this.subscriptions.add(subscription);
      }),
    );
    this.overlayManager = this.getManager(lumine.workspace.getMainWindow());
  },

  getManager(window) {
    let manager = this.managers.get(window);
    if (!manager) {
      manager = new OverlayManager({ window, signatureRegistry: this.signatureRegistry });
      manager.setContextHelp(this.contextHelp);
      manager.setContextHelpPanel(this.contextHelpPanel);
      this.managers.set(window, manager);
    }
    return manager;
  },

  deactivate() {
    this.subscriptions?.dispose();
    this.subscriptions = null;
    for (const manager of this.managers.values()) manager.dispose();
    this.managers.clear();
    this.overlayManager = null;
    this.contextHelp = this.contextHelpPanel = null;
  },

  consumeContextHelp(registry) {
    this.contextHelp = registry;
    for (const manager of this.managers.values()) manager.setContextHelp(registry);
    return new Disposable(() => {
      if (this.contextHelp !== registry) return;
      this.contextHelp = null;
      for (const manager of this.managers.values()) manager.setContextHelp(null);
    });
  },

  consumeContextHelpPanel(panel) {
    this.contextHelpPanel = panel;
    for (const manager of this.managers.values()) manager.setContextHelpPanel(panel);
    return new Disposable(() => {
      if (this.contextHelpPanel !== panel) return;
      this.contextHelpPanel = null;
      for (const manager of this.managers.values()) manager.setContextHelpPanel(null);
    });
  },

  consumeHoverSignature(provider) {
    return this.signatureRegistry.addProvider(provider);
  },

  consumeStatusBar(service) {
    return service.observeWindows(
      (scopedStatusBar, context) => this.consumeWindowStatusBar(scopedStatusBar, context),
      { windows: "all" },
    );
  },

  consumeWindowStatusBar(statusBar, context) {
    const manager = this.getManager(context.window);
    manager.setStatusBar(statusBar);
    return new Disposable(() => {
      if (manager.statusBar === statusBar) manager.setStatusBar(null);
    });
  },
};
