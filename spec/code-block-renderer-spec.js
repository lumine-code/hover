describe("Provider code-block rendering", () => {
  let renderHoverContent, items;

  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-typescript");
    await lumine.packages.activatePackage("language-javascript");
    ({ renderHoverContent } = require("../lib/render"));
    items = [];
  });

  afterEach(() => {
    for (const item of items) {
      for (const element of item.querySelectorAll("lumine-text-editor"))
        element.getModel().destroy();
      item.remove();
    }
  });

  async function render(value, renderCodeBlock, kind = "markdown") {
    const item = await renderHoverContent({ kind, value, renderCodeBlock });
    items.push(item);
    return item;
  }

  it("passes each fence's own language and grammar to the provider and preserves prose", async () => {
    const callback = jasmine.createSpy("renderCodeBlock").and.callFake(async ({ text }) => {
      if (text === "const x = 1;") return null;
      const pre = document.createElement("pre");
      pre.textContent = text;
      return pre;
    });
    const signature = "(method) Array<string>.filter(): string[]";
    const item = await render(
      `\`\`\`ts\n${signature}\n\`\`\`\n\nDocumentation.\n\n\`\`\`js\nconst x = 1;\n\`\`\``,
      callback,
    );
    expect(callback.calls.allArgs()).toEqual([
      [{ text: signature, language: "ts", scopeName: "source.ts" }],
      [{ text: "const x = 1;", language: "js", scopeName: "source.js" }],
    ]);
    expect(item.querySelector("pre").textContent).toBe(signature);
    expect(item.textContent).toContain("Documentation.");
    expect(item.querySelector("lumine-text-editor").getModel().getGrammar().scopeName).toBe(
      "source.js",
    );
  });

  it("falls back to the declared grammar when a provider renderer fails", async () => {
    const callback = jasmine.createSpy("renderCodeBlock").and.rejectWith(new Error("failed"));
    const source = "const x: number = 1;";
    const item = await render(`\`\`\`typescript\n${source}\n\`\`\`\n\nDocumentation.`, callback);
    const editor = item.querySelector("lumine-text-editor").getModel();
    expect(editor.getGrammar().scopeName).toBe("source.ts");
    expect(editor.getText()).toBe(source);
    expect(item.textContent).toContain("Documentation.");
  });

  it("does not interpret plain text or require a custom renderer", async () => {
    const callback = jasmine.createSpy("renderCodeBlock");
    const source = "```ts\nconst x: number = 1;\n```";
    const plain = await render(source, callback, "plaintext");
    expect(plain.textContent).toContain(source);
    expect(callback).not.toHaveBeenCalled();
    const normal = await render(source);
    expect(normal.querySelector("lumine-text-editor").getModel().getGrammar().scopeName).toBe(
      "source.ts",
    );
  });
});
