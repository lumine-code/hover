const { Disposable } = require("lumine");

// Keeps the providers of one service. `grammarScopes` is read through on every
// call: hub providers expose it as a getter whose value changes as language
// server sessions come and go, so it must never be snapshotted.
module.exports = class ProviderRegistry {
  constructor() {
    this.providers = [];
  }

  addProvider(provider) {
    this.providers.push(provider);
    return new Disposable(() => this.removeProvider(provider));
  }

  removeProvider(provider) {
    const index = this.providers.indexOf(provider);
    if (index !== -1) this.providers.splice(index, 1);
  }

  getProviderForEditor(editor) {
    return this.getAllProvidersForEditor(editor)[0] ?? null;
  }

  // All providers claiming the editor's grammar, highest priority first.
  getAllProvidersForEditor(editor) {
    const scopeName = editor.getGrammar()?.scopeName;
    return this.providers
      .filter((provider) => {
        const scopes = provider.grammarScopes;
        return !scopes || Array.from(scopes).includes(scopeName);
      })
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }
};
