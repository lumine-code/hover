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
    const owner = this.subscriptions;
    this.subscriptions.add(
      lumine.config.observe("hover.trace", (value) => {
        if (this.subscriptions === owner) this.setTrace(value);
      }),
      lumine.commands.add("lumine-workspace", {
        "hover:toggle-trace": {
          description: "Turn mouse-driven hover tooltips on or off in this workspace.",
          didDispatch: () => {
            if (this.subscriptions === owner) this.toggleTrace();
          },
        },
      }),
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
      const owner = this.subscriptions;
      manager = new OverlayManager({
        window,
        signatureRegistry: this.signatureRegistry,
        trace: this.trace,
        onToggleTrace: () => {
          if (owner && this.subscriptions === owner && !owner.disposed) this.toggleTrace();
        },
      });
      manager.setContextHelp(this.contextHelp);
      manager.setContextHelpPanel(this.contextHelpPanel);
      this.managers.set(window, manager);
    }
    return manager;
  },

  setTrace(value) {
    this.trace = Boolean(value);
    for (const manager of this.managers.values()) manager.setTrace(this.trace);
  },

  toggleTrace() {
    this.setTrace(!this.trace);
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
