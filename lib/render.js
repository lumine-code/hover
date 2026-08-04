// Renders provider results into the overlay elements. All markdown goes
// through the editor's built-in `atom.tools.markdown` API; fenced code blocks are
// converted into embedded read-only editors by `applySyntaxHighlighting` in
// its synchronous "fragment" mode, so no external markdown or sanitizer
// dependency is needed.

// Maps a fenced code block's language string to a grammar scope name. Accepts
// either a bare language id (`js`, `python`) or a full scope (`source.js`).
function scopeForFenceName(fenceName) {
  if (fenceName) {
    if (fenceName.includes(".") && atom.grammars.grammarForScopeName(fenceName)) {
      return fenceName;
    }
    const grammar = atom.grammars.treeSitterGrammarForLanguageString?.(fenceName);
    if (grammar) return grammar.scopeName;
    if (atom.grammars.grammarForScopeName(`source.${fenceName}`)) return `source.${fenceName}`;
  }
  return "text.plain";
}

// Renders a markdown string into a DOM fragment. Raw HTML is kept literal
// (`html: false`): language servers routinely mention tags like `<pre>` in
// prose, and the LSP expects clients to neutralize markup anyway.
async function renderMarkdownFragment(markdown) {
  const html = atom.tools.markdown.render(markdown, {
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
  const fragment = atom.tools.markdown.convertToDOM(html);
  if (fragment.querySelector("pre")) {
    await atom.tools.markdown.applySyntaxHighlighting(fragment, {
      renderMode: "fragment",
      syntaxScopeNameFunc: scopeForFenceName,
    });
  }
  return fragment;
}

function wrapInPanel(view) {
  const panel = document.createElement("atom-panel");
  panel.classList.add("hover-overlay-view-container", "bordered");
  panel.appendChild(view);
  return panel;
}

function createView() {
  const view = document.createElement("div");
  view.classList.add("inset-panel", "padded", "hover-overlay-view");
  return view;
}

// Builds the overlay element for a hover result's `contents`, or resolves to
// null when there is nothing to show.
async function renderHoverContent(contents) {
  const view = createView();
  if (contents.kind === "plaintext") {
    if (!contents.value.trim()) return null;
    const text = document.createElement("div");
    text.classList.add("hover-plaintext");
    text.textContent = contents.value;
    view.appendChild(text);
  } else {
    const fragment = await renderMarkdownFragment(contents.value);
    if (!fragment) return null;
    view.appendChild(fragment);
  }
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
