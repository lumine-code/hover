const OverlayManager = require("./overlay-manager");
const { Disposable } = require("lumine");

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
    this.overlayManager = new OverlayManager();
  },

  deactivate() {
    this.overlayManager?.dispose();
    this.overlayManager = null;
  },

  consumeContextHelp(registry) {
    const manager = this.overlayManager;
    manager.setContextHelp(registry);
    return new Disposable(() => {
      if (manager.contextHelp === registry) manager.setContextHelp(null);
    });
  },

  consumeContextHelpPanel(panel) {
    const manager = this.overlayManager;
    manager.setContextHelpPanel(panel);
    return new Disposable(() => {
      if (manager.contextHelpPanel === panel) manager.setContextHelpPanel(null);
    });
  },

  consumeHoverSignature(provider) {
    return this.overlayManager.signatureRegistry.addProvider(provider);
  },

  consumeStatusBar(statusBar) {
    const manager = this.overlayManager;
    manager.setStatusBar(statusBar);
    return new Disposable(() => {
      if (manager.statusBar === statusBar) manager.setStatusBar(null);
    });
  },
};
