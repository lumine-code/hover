const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));

// Guards for the pulsar-hover -> hover rebrand and the TypeScript/Rollup/Less
// -> plain CommonJS/CSS modernization. The command prefix, config namespace,
// and package name all move to `hover`; markdown rendering moves to the
// built-in `atom.tools.markdown` API, and the legacy atom-ide back-compat
// services are dropped.
describe("hover package assets", () => {
  it("ships the keymap as JSON, not CSON", () => {
    expect(exists("keymaps/hover.json")).toBe(true);
    expect(exists("keymaps/hover.cson")).toBe(false);
    expect(exists("keymaps/pulsar-hover.cson")).toBe(false);
    expect(exists("keymaps/pulsar-hover.json")).toBe(false);
  });

  it("uses the hover: command prefix and escape dismissal in the keymap", () => {
    const keymap = JSON.parse(read("keymaps/hover.json"));
    expect(keymap["atom-text-editor"]["cmdorctrl-alt-h"]).toBe("hover:toggle");
    expect(keymap["atom-text-editor"]["cmdorctrl-alt-j"]).toBe("hover:toggle-signature-help");
    expect(keymap["atom-text-editor.hover-active"]["escape"]).toBe("hover:dismiss");
    expect(read("keymaps/hover.json")).not.toContain("pulsar-hover:");
  });

  it("ships a CSS stylesheet built on custom properties, not Less", () => {
    expect(exists("styles/hover.css")).toBe(true);
    expect(exists("styles/hover.less")).toBe(false);
    expect(exists("styles/pulsar-hover.less")).toBe(false);
    const css = read("styles/hover.css");
    expect(css).toContain(".hover-overlay-view-container");
    expect(css).toContain(".hover-active-parameter");
    expect(css).toContain("var(--");
    expect(css).not.toContain("pulsar");
    expect(css).not.toContain("@import");
    expect(css).not.toMatch(/\bfade\(|\bcontrast\(|\blighten\(|\bdarken\(|@[a-z-]+:/);
  });

  it("is named `hover`, has no runtime dependencies, and drops the build step", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("hover");
    expect(pkg.author).toBe("lumine-code");
    expect(pkg.repository).toBe("https://github.com/lumine-code/hover");
    expect(pkg.bugs.url).toBe("https://github.com/lumine-code/hover/issues");
    expect(pkg.main).toBe("./lib/main");
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies.typescript).toBeUndefined();
    expect(pkg.devDependencies.rollup).toBeUndefined();
    expect(pkg.devDependencies.marked).toBeUndefined();
    expect(pkg.devDependencies.dompurify).toBeUndefined();
    expect(exists("tsconfig.json")).toBe(false);
    expect(exists("rollup.config.mjs")).toBe(false);
    expect(exists("src")).toBe(false);
  });

  it("consumes hover and signature and provides no legacy services", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.consumedServices["hover.provider"].versions["^1.0.0"]).toBe("consumeHover");
    expect(pkg.consumedServices["hover.signature-provider"].versions["^1.0.0"]).toBe(
      "consumeHoverSignature",
    );
    expect(pkg.providedServices).toBeUndefined();
  });

  it("defines the config schema under the hover namespace without order keys", () => {
    const pkg = JSON.parse(read("package.json"));
    const schema = pkg.configSchema;
    expect(Object.keys(schema).sort()).toEqual([
      "hoverTime",
      "includeSignatureDocumentation",
      "showOnCursorMove",
      "showOnMouseMove",
      "showSignatureWhileTyping",
    ]);
    for (const entry of Object.values(schema)) {
      expect(entry.order).toBeUndefined();
      expect(entry.title).toBeDefined();
      expect(entry.description).toBeDefined();
      expect(entry.type).toBeDefined();
      // `default` must be the last key of every entry.
      const keys = Object.keys(entry);
      expect(keys[keys.length - 1]).toBe("default");
    }
  });

  it("keeps the README description in sync with package.json", () => {
    const pkg = JSON.parse(read("package.json"));
    const lines = read("README.md").split(/\r?\n/);
    expect(lines[0]).toBe("# hover");
    const sentence = lines.find((line, index) => index > 0 && line.trim().length > 0);
    expect(sentence).toBe(pkg.description);
  });

  it("has no leftover pulsar / atom-ide / marked / dompurify references in lib", () => {
    const libDir = path.join(root, "lib");
    for (const file of fs.readdirSync(libDir)) {
      if (!file.endsWith(".js")) continue;
      const src = fs.readFileSync(path.join(libDir, file), "utf8");
      expect(src.toLowerCase()).not.toContain("pulsar");
      expect(src).not.toContain("atom-ide");
      expect(src).not.toContain('require("marked")');
      expect(src).not.toContain('require("dompurify")');
      expect(src).not.toContain("datatip");
    }
  });
});
