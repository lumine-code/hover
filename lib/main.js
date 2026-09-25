const OverlayManager = require("./overlay-manager");

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

  consumeHover(provider) {
    return this.overlayManager.hoverRegistry.addProvider(provider);
  },

  consumeHoverSignature(provider) {
    return this.overlayManager.signatureRegistry.addProvider(provider);
  },
};
