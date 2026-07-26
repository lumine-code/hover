const OverlayManager = require("./overlay-manager");

module.exports = {
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

  consumeSignature(provider) {
    return this.overlayManager.signatureRegistry.addProvider(provider);
  },
};
