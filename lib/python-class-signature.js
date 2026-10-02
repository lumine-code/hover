// Python servers describe constructors as `class Name(parameter: Type, ...)`.
// That is a signature, not Python class syntax: parsing it as a class makes
// parameters look like base classes, assignments and type annotations. Parse
// an equally wide function header privately, then color the original text.
async function renderPythonClassSignature(source, scopeName) {
  if (scopeName !== "source.python" && scopeName !== "source.python.ipy") return null;
  const header = /^class[ \t]+([\p{ID_Start}_][\p{ID_Continue}_]*)[ \t]*(?=\(|\[)/u.exec(source);
  if (!header || !source.trimEnd().endsWith(")")) return null;

  const editor = lumine.workspace.buildTextEditor({ readOnly: true, keyboardInputEnabled: false });
  try {
    editor.setText(`def  ${source.slice(5)}: ...`, { bypassReadOnly: true });
    if (!lumine.grammars.assignLanguageMode(editor, "source.python")) return null;
    if (!(await editor.whenGrammarSettled())) return null;
    const root = editor.getSyntaxNodeAtBufferPosition([0, 0], (node) => !node.parent);
    const definition = root?.firstNamedChild;
    if (
      root?.hasError ||
      root?.namedChildCount !== 1 ||
      definition?.type !== "function_definition"
    ) {
      return null;
    }
    const name = definition.childForFieldName("name");
    if (name?.text !== header[1]) return null;

    const pre = document.createElement("pre");
    pre.classList.add("editor-colors", "lang-python");
    const code = document.createElement("code");
    code.className = "language-python";
    pre.appendChild(code);

    let row = 0;
    let column = 0;
    let run = "";
    let runScopes = [];
    const openScopes = [];
    const elements = [code];
    const flush = () => {
      if (!run) return;
      let shared = 0;
      while (shared < openScopes.length && openScopes[shared] === runScopes[shared]) shared++;
      openScopes.length = shared;
      elements.length = shared + 1;
      for (const scope of runScopes.slice(shared)) {
        const span = document.createElement("span");
        span.className = scope
          .split(".")
          .map((part) => `syntax--${part}`)
          .join(" ");
        elements.at(-1).appendChild(span);
        elements.push(span);
        openScopes.push(scope);
      }
      elements.at(-1).appendChild(document.createTextNode(run));
      run = "";
    };

    // Only the displayed signature is visited: the synthetic function body
    // never enters the DOM or copied text. Buffer columns are UTF-16, while
    // iterating code points keeps a Unicode identifier's surrogate pair whole.
    for (const character of source) {
      let scopes;
      if (row === 0 && column < 5) {
        scopes = ["source.python", "storage.type.class.python"];
      } else if (
        row === name.startPosition.row &&
        column >= name.startPosition.column &&
        column < name.endPosition.column
      ) {
        scopes = ["source.python", "entity.name.type.class.python"];
      } else {
        scopes = editor.scopeDescriptorForBufferPosition([row, column]).getScopesArray();
      }
      if (
        scopes.length !== runScopes.length ||
        scopes.some((scope, index) => scope !== runScopes[index])
      ) {
        flush();
        runScopes = scopes;
      }
      run += character;
      if (character === "\n") {
        row++;
        column = 0;
      } else {
        column += character.length;
      }
    }
    flush();
    return pre;
  } catch {
    // A failed grammar must not take the signature or its documentation away.
    return null;
  } finally {
    editor.destroy();
  }
}

module.exports = { renderPythonClassSignature };
