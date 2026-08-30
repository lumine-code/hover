// Renders provider results into the overlay elements. All markdown goes
// through the editor's built-in `lumine.tools.markdown` API; fenced code blocks are
// converted into embedded read-only editors by `applySyntaxHighlighting` in
// its synchronous "fragment" mode, so no external markdown or sanitizer
// dependency is needed.

// Maps a fenced code block's language string to a grammar scope name. Accepts
// either a bare language id (`js`, `python`) or a full scope (`source.js`).
function scopeForFenceName(fenceName) {
  if (fenceName) {
    if (fenceName.includes(".") && lumine.grammars.grammarForScopeName(fenceName)) {
      return fenceName;
    }
    const grammar = lumine.grammars.treeSitterGrammarForLanguageString?.(fenceName);
    if (grammar) return grammar.scopeName;
    if (lumine.grammars.grammarForScopeName(`source.${fenceName}`)) return `source.${fenceName}`;
  }
  return "text.plain";
}

// Renders a markdown string into a DOM fragment. Raw HTML is kept literal
// (`html: false`): language servers routinely mention tags like `<pre>` in
// prose, and the LSP expects clients to neutralize markup anyway.
async function renderMarkdownFragment(markdown) {
  const html = lumine.tools.markdown.render(markdown, {
    renderMode: "fragment",
    html: false,
    breaks: false,
    handleFrontMatter: false,
    useTaskCheckbox: false,
    transformImageLinks: false,
    transformLegacyLinks: false,
    transformNonFqdnLinks: false,
  });
  if (!html.trim()) return null;
  const fragment = lumine.tools.markdown.convertToDOM(html);
  if (fragment.querySelector("pre")) {
    await lumine.tools.markdown.applySyntaxHighlighting(fragment, {
      renderMode: "fragment",
      syntaxScopeNameFunc: scopeForFenceName,
      // The overlay is as wide as what it holds, so a code block that took its
      // width from the overlay instead of reporting one would leave the whole
      // tooltip collapsed — a signature-only answer is nothing but code.
      autoWidth: true,
    });
  }
  return fragment;
}

// The overlay is two elements: the container carries the popover chrome and
// draws the pointer arrow outside its own box — which is why it must never
// clip, and why it is the view inside that scrolls (see main.css).
function wrapInPanel(view) {
  const panel = document.createElement("div");
  panel.classList.add("hover-overlay-view-container");
  // Focusable so that a drag through the tooltip does not hand the focus to
  // the editor around it. The editor element is focusable too, and is the
  // nearest one that a click in the overlay would otherwise find: it takes the
  // focus, passes it straight to its hidden input, and the selection the drag
  // was starting dies in the exchange. The overlay gives the focus back on
  // mouse-up, by which point the selection is made and survives the move.
  panel.tabIndex = -1;
  panel.appendChild(view);
  return panel;
}

function createView() {
  const view = document.createElement("div");
  view.classList.add("hover-overlay-view");
  return view;
}

// One provider's answer, as a section of the tooltip, or null when it turns
// out to render to nothing.
async function renderSection(contents) {
  const section = document.createElement("div");
  section.classList.add("hover-section");

  if (contents.element) {
    // A provider whose answer is not prose builds its own: a linter's messages
    // carry a severity, a rule name and a fix, none of which survive being
    // flattened into markdown. The tooltip supplies the surface and every rule
    // about when it comes and goes; what stands on it is the provider's.
    section.classList.add("hover-provided");
    section.appendChild(contents.element);
    return section;
  }
  if (contents.kind === "plaintext") {
    if (!contents.value.trim()) return null;
    const text = document.createElement("div");
    text.classList.add("hover-plaintext");
    text.textContent = contents.value;
    section.appendChild(text);
    return section;
  }
  const fragment = await renderMarkdownFragment(contents.value);
  if (!fragment) return null;
  section.appendChild(fragment);
  return section;
}

// Builds the overlay element for every answer given about a position, in the
// order they were asked. They are all about the same word, and the reader
// wants them all: what is wrong with it, and then what it is.
async function renderHoverContent(contentsList) {
  const view = createView();
  for (const contents of [contentsList].flat()) {
    const section = await renderSection(contents);
    if (section) view.appendChild(section);
  }
  if (!view.firstChild) return null;
  return wrapInPanel(view);
}

function documentationValue(documentation) {
  if (documentation == null) return "";
  return typeof documentation === "string" ? documentation : (documentation.value ?? "");
}

// Resolves the active parameter's bounds within the signature label. The LSP
// allows a parameter label to be either a substring of the signature label or
// a pair of offsets into it.
function parameterBounds(parameter, signature) {
  const label = parameter.label;
  if (Array.isArray(label)) return label;
  if (typeof label === "string") {
    const start = signature.label.indexOf(label);
    if (start !== -1) return [start, start + label.length];
  }
  return null;
}

// Builds the overlay element for an LSP `SignatureHelp` result: the active
// signature's label with the active parameter marked by an inline span,
// followed by the rendered documentation.
async function renderSignatureContent(
  signatureHelp,
  { includeSignatureDocumentation = false } = {},
) {
  const signatures = signatureHelp.signatures ?? [];
  const signature = signatures[Math.min(signatureHelp.activeSignature ?? 0, signatures.length - 1)];
  if (!signature?.label) return null;
  const parameter = signature.parameters?.[signatureHelp.activeParameter ?? 0] ?? null;

  const view = createView();
  const pre = document.createElement("pre");
  pre.classList.add("hover-signature");
  const code = document.createElement("code");
  const bounds = parameter ? parameterBounds(parameter, signature) : null;
  if (bounds) {
    code.append(signature.label.slice(0, bounds[0]));
    const active = document.createElement("span");
    active.classList.add("hover-active-parameter");
    active.textContent = signature.label.slice(bounds[0], bounds[1]);
    code.appendChild(active);
    code.append(signature.label.slice(bounds[1]));
  } else {
    code.textContent = signature.label;
  }
  pre.appendChild(code);
  view.appendChild(pre);

  let docs = documentationValue(parameter?.documentation);
  const signatureDocs = documentationValue(signature.documentation);
  if (signatureDocs && (includeSignatureDocumentation || !docs)) {
    docs = docs ? `${docs}\n\n---\n\n${signatureDocs}` : signatureDocs;
  }
  if (docs) {
    const fragment = await renderMarkdownFragment(docs);
    if (fragment) view.appendChild(fragment);
  }
  return wrapInPanel(view);
}

module.exports = { renderHoverContent, renderSignatureContent, scopeForFenceName };
