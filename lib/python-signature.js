// Python servers describe constructors as `class Name(parameter: Type, ...)`
// and methods as `(method) def name(...) -> Type`, without a function body.
// Parse a valid function privately, using spaces to preserve every original
// column, then transfer the real Python grammar's scopes to the displayed text.
async function renderPythonSignature(source, scopeName) {
  if (scopeName !== "source.python" && scopeName !== "source.python.ipy") return null;
  const header =
    /^(\([^()\r\n]+\)[ \t]+)?(class|(?:async[ \t]+)?def)[ \t]+([\p{ID_Start}_][\p{ID_Continue}_]*)[ \t]*(?=\(|\[)/u.exec(
      source,
    );
  if (!header) return null;
  const prefixLength = header[1]?.length ?? 0;
  const isClass = header[2] === "class";
  if (isClass && !source.trimEnd().endsWith(")")) return null;
  const declaration = isClass
    ? `def  ${source.slice(prefixLength + 5)}`
    : source.slice(prefixLength);
  const projected = `${" ".repeat(prefixLength)}${declaration}: ...`;

  const editor = lumine.workspace.buildTextEditor({ readOnly: true, keyboardInputEnabled: false });
  try {
    editor.setText(projected, { bypassReadOnly: true });
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
    if (name?.text !== header[3]) return null;

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
      if (row === 0 && column < prefixLength) {
        scopes = ["source.python"];
      } else if (isClass && row === 0 && column < prefixLength + 5) {
        scopes = ["source.python", "storage.type.class.python"];
      } else if (
        isClass &&
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

module.exports = { renderPythonSignature };
