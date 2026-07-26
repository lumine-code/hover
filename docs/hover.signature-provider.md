# hover.signature-provider

Supplies the call signature shown while the user types arguments.

|             |                                                            |
| ----------- | ---------------------------------------------------------- |
| Version     | `1.0.0`                                                    |
| Provided by | `provideHoverSignature()` returning one provider           |
| Consumed by | `consumeHoverSignature(provider)` returning a `Disposable` |
| Owner       | [`hover`](https://github.com/lumine-code/hover)            |

The sibling of [`hover.provider`](hover.provider.md), triggered by typing rather than by pointing. As with hover, a language server reaches this through an [`ide-client`](https://lumine-code.github.io/docs.html#services/ide-client) adapter rather than by implementing the service directly.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "hover.signature-provider": {
      "versions": { "1.0.0": "provideHoverSignature" }
    }
  }
}
```

## Contract

```ts
type SignatureProvider = {
  getSignature(
    editor: TextEditor,
    position: Point,
    context: SignatureContext,
  ): Promise<SignatureHelp | null> | SignatureHelp | null;
  grammarScopes?: string[] | Set<string>;
  priority?: number;
};

type SignatureContext = {
  triggerKind: number;
  isRetrigger: boolean;
  triggerCharacter?: string;
};

type SignatureHelp = {
  signatures: Array<{
    label: string;
    documentation?: string | { kind: string; value: string };
    parameters?: Array<{ label: string | [number, number]; documentation?: string }>;
  }>;
  activeSignature?: number;
  activeParameter?: number;
};
```

| Member                                    | Description                                                |
| ----------------------------------------- | ---------------------------------------------------------- |
| `getSignature(editor, position, context)` | Required. Return the signature help, or `null` to decline. |
| `grammarScopes`                           | Scope names you serve. Omitting it means every grammar.    |
| `priority`                                | Higher is asked first. Defaults to `0`.                    |

`context.triggerKind` follows the LSP values, and `isRetrigger` is `true` when the popup is already open and being refreshed — typically as the user moves between arguments.

## Minimal example

```js
module.exports = {
  provideHoverSignature() {
    return {
      grammarScopes: ["source.mylang"],
      async getSignature(editor, position, context) {
        const call = await resolveCall(editor, position);
        if (!call) return null;
        return {
          signatures: [{ label: call.signature, parameters: call.parameters }],
          activeSignature: 0,
          activeParameter: call.argumentIndex,
        };
      },
    };
  },
};
```

## Behavior

Unlike hover, **only the highest-priority matching provider is asked** — there is no fallthrough to the next one. A provider that declines for an editor it claims leaves the user with nothing, so scope your `grammarScopes` to what you can actually answer.

A result with an empty `signatures` array is treated as declining and dismisses any open popup.

`activeParameter` is what highlights the argument being typed; without it the popup shows the signature but nothing moves as the user types commas.

Whether parameter documentation is rendered is a user setting (`hover.includeSignatureDocumentation`), so supply it and let the user decide.

The signature popup and the hover overlay share one slot: showing a signature replaces a visible hover, and vice versa.

A provider that throws logs to the console and shows nothing.

## Teardown

`consumeHoverSignature` returns a `Disposable` that removes the provider. Return it from your consumer method.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
