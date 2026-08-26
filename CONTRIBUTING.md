# Contributing

Thanks for taking a look. Issues and pull requests are welcome.

## Getting set up

```bash
git clone https://github.com/aradhya2211/turtle-syntax-extension.git
cd turtle-syntax-extension
npm install
npm run watch
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with the
extension loaded. Open `test/fixtures/turtle/ontology.ttl` to exercise it.

To reload after a change: <kbd>Cmd/Ctrl</kbd>+<kbd>R</kbd> in the development host.

## Layout

```
src/extension.ts              Extension host: starts the client, registers commands
src/preview/                  Webview panel lifecycle and message protocol
src/server/server.ts          Language server entry point
src/server/core/              Format dispatch, parsing, index, graph model
src/server/formats/turtle/    Turtle scanner (ranges) + N3 parser (quads)
src/server/formats/rdfxml/    saxes scanner (ranges) + RDF/XML parser (quads)
src/server/features/          One module per LSP feature
webview/                      Cytoscape graph UI
```

The architecture in one sentence: **each format contributes a scanner for source
ranges and a parser for quads, joined on the resolved absolute IRI**, so every
feature downstream is written once and works for all formats.

## Adding a format

1. Write a scanner producing `TermOccurrence[]` with exact ranges.
2. Write a parser producing `RdfQuad[]`.
3. Register both in `src/server/core/document.ts` and `formats.ts`.

Nothing else needs to change — features, the index and the preview are all
format-agnostic.

## Testing

```bash
npm test           # unit tests plus an end-to-end LSP test against the built server
npm run typecheck
```

The integration test spawns `dist/server.js` and speaks real LSP to it, so run
`npm run build` first if you want it to execute rather than skip.

### What to test

Two invariants matter more than anything else and should be kept green:

- **Range round-trip.** Every `TermOccurrence.range` must slice source text that
  actually produced its IRI. Nearly every position bug shows up here first.
- **Formatting preserves meaning.** Formatting a document and re-parsing it must
  yield the same quads.

If you touch rename, add a case to `test/unit/rename.test.ts` for the spelling you
changed. Rename is the one feature that can destroy a user's file.

## Style

- TypeScript, strict mode, no `any` in new code where it can be avoided.
- Comments explain *why*, not *what*.
- Prefer refusing an operation over guessing when correctness is at stake.
