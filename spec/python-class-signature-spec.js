describe("Python class signatures in hover documentation", () => {
  let items, renderHoverContent;

  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-python");
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

  async function render(source, language = "python") {
    const item = await renderHoverContent({
      kind: "markdown",
      value: `\`\`\`${language}\n${source}\n\`\`\`\n\nDocumentation.`,
    });
    items.push(item);
    return item;
  }

  it("colors every constructor parameter consistently and preserves the class signature", async () => {
    const source = `class WindBridgeZ(
    q_pe: Unknown,
    α: Unknown,
    β: int,
    b_tot: float,
    d_tot: float,
    c_s: float = 1,
    c_d: float = 1,
    e_w: float = 0.25
)`;
    const item = await render(source);
    const signature = item.querySelector("pre");
    expect(signature).not.toBeNull();
    if (!signature) return;
    expect(signature.textContent).toBe(source);
    expect(item.textContent).toContain("Documentation.");
    expect(
      [...signature.querySelectorAll(".syntax--variable.syntax--parameter.syntax--function")].map(
        (span) => span.textContent,
      ),
    ).toEqual(["q_pe", "α", "β", "b_tot", "d_tot", "c_s", "c_d", "e_w"]);
    expect(signature.querySelector(".syntax--storage.syntax--class").textContent).toBe("class");
    expect(signature.querySelector(".syntax--entity.syntax--class").textContent).toBe(
      "WindBridgeZ",
    );
    expect(signature.querySelector(".syntax--inherited-class")).toBeNull();
  });

  it("keeps nested annotations, defaults and all parameter names in their own roles", async () => {
    const source = `class DynSchema(
    common: Store,
    groups: dict[int, Store],
    lanes: dict[tuple[str, int], Store],
    models: bool = False,
    subs: bool = False
)`;
    const item = await render(source, "py");
    const signature = item.querySelector("pre");
    expect(signature).not.toBeNull();
    if (!signature) return;
    expect(signature.textContent).toBe(source);
    expect(
      [...signature.querySelectorAll(".syntax--variable.syntax--parameter.syntax--function")].map(
        (span) => span.textContent,
      ),
    ).toEqual(["common", "groups", "lanes", "models", "subs"]);
    expect(
      signature.querySelectorAll(".syntax--constant.syntax--builtin.syntax--false").length,
    ).toBe(2);
  });

  it("leaves real class declarations as embedded Python editors", async () => {
    const source = "class Derived(Base):\n    pass";
    const item = await render(source);
    const editor = item.querySelector("lumine-text-editor").getModel();
    expect(editor.getText()).toBe(source);
    expect(editor.getGrammar().scopeName).toBe("source.python");
  });

  it("preserves Unicode, string defaults and copyable text without retaining the parser editor", async () => {
    const build = spyOn(lumine.workspace, "buildTextEditor").and.callThrough();
    const source = 'class R(𝛼: str = "<tag>(α)</tag>", *, β: int = 2)';
    const item = await render(source, "source.python");
    const signature = item.querySelector("pre");
    expect(signature.textContent).toBe(source);
    expect(signature.querySelector("tag")).toBeNull();
    expect(signature.querySelector(".syntax--entity.syntax--class").textContent).toBe("R");
    expect(
      [...signature.querySelectorAll(".syntax--variable.syntax--parameter.syntax--function")].map(
        (span) => span.textContent,
      ),
    ).toEqual(["𝛼", "β"]);
    expect(build).toHaveBeenCalled();
    expect(build.calls.all().every((call) => call.returnValue.isDestroyed())).toBe(true);
  });

  it("falls back to the ordinary code block when the signature cannot be parsed", async () => {
    const build = spyOn(lumine.workspace, "buildTextEditor").and.callThrough();
    const source = "class Broken(value: )";
    const item = await render(source);
    expect(item.querySelector("lumine-text-editor").getModel().getText()).toBe(source);
    expect(build.calls.first().returnValue.isDestroyed()).toBe(true);
  });

  it("keeps class-like code in other languages on the ordinary renderer", async () => {
    const source = "class Example(value: Type)";
    const item = await render(source, "text");
    expect(item.querySelector("lumine-text-editor").getModel().getText()).toBe(source);
  });
});
