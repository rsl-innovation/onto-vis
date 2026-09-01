# Turtle & RDF — Ontology Language Server + Graph Preview

[![CI](https://github.com/rsl-innovation/onto-vis/actions/workflows/ci.yml/badge.svg)](https://github.com/rsl-innovation/onto-vis/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A VS Code extension for authoring ontologies. It gives Turtle, RDF/XML and OWL files
a real language server — diagnostics, navigation, rename, outline — and renders the
ontology as a live graph beside the editor.

Two problems it solves:

- **Authoring is blind.** VS Code has no built-in support for these formats: no
  highlighting, no error squiggles, no way to jump from a use of `:Person` to where
  it is defined.
- **Ontologies are graphs, but the files are text.** A `subClassOf` hierarchy or a
  `domain → range` property web is hard to hold in your head from a flat file.

## Features

### Ontology graph preview

Run **RDF: Show Ontology Graph Preview** (or the editor-title icon) to open the
graph beside your file. It updates as you type.

- **Ontology view** — every class is a UML-style card: a header band with the class
  name, then its datatype properties as aligned attribute rows with their types.
  Laid out with ELK's layered algorithm, so classes land in clean columns and
  never overlap, with `rdfs:subClassOf` drawn as an orthogonal hollow-triangle
  generalisation flowing left to right.
  `owl:Restriction` becomes an annotated edge (`hasParent only Person`) or an
  italic constraint row, rather than an anonymous blob.
- **Triples view** — every subject, predicate and object, with literals and blank
  nodes as distinctly shaped leaves.
- **Click a node** to jump to its definition — in whichever file and format defines
  it. **Move the cursor** in the editor and the matching node highlights.
- Search, filters, workspace-wide scope, zoom controls, a legend, and PNG export.
- Selecting a class opens a panel with its attributes, its place in the hierarchy
  and its relationships — each one clickable to walk the graph.

### Language server

Everything works across files **and across formats** — a class defined in a `.owl`
file is navigable from a `.ttl` file, because the index is keyed by resolved IRI.

| Feature | Turtle family | RDF/XML |
| --- | :---: | :---: |
| Syntax highlighting | ✅ | ✅ |
| Diagnostics (multiple errors at once) | ✅ | ✅ |
| Semantic highlighting by term role | ✅ | ✅ |
| Hover (`rdfs:label` / `rdfs:comment` / built-in vocabularies) | ✅ | ✅ |
| Completion (with automatic `@prefix` insertion) | ✅ | ✅ |
| Go to definition / Find references | ✅ | ✅ |
| Rename across files and formats | ✅ | ✅ |
| Outline and workspace symbols | ✅ | ✅ |
| Format document | ✅ | — |

RDF/XML formatting is deliberately left to existing XML tooling.

## Supported files

`.ttl` `.turtle` `.nt` `.nq` `.trig` `.n3` `.rdf` `.rdfs` `.owl`

`.owl` is ambiguous — Protégé writes RDF/XML by default but can also write Turtle —
so the extension sniffs the file's content rather than trusting its extension.

## Design notes

Three decisions worth knowing about, because they show up in the behaviour:

**Rename never does text replacement.** The same IRI can be written `ex:Person`,
`<http://example.org/Person>`, `<#Person>`, `rdf:about="#Person"` or
`rdf:ID="Person"`. Each occurrence is re-rendered in *its own* form. If any
affected file cannot be read, the whole rename is refused rather than applied
halfway — a partial rename silently corrupts an ontology.

**Formatting declines when unsure.** The formatter works from the token stream, so
comments survive (a re-serialisation through `N3.Writer` would drop them). If the
file has a syntax error or an unbalanced bracket, it makes no edits at all.

**The preview never parses anything.** It asks the language server, which already
holds the parsed workspace, so the graph can never disagree with the squiggles.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `rdf.workspace.enabled` | `true` | Index every RDF file for cross-file navigation |
| `rdf.workspace.maxFiles` | `2000` | Stop indexing after this many files |
| `rdf.preview.maxNodes` | `2000` | Above this, render the most connected subgraph and say so |
| `rdf.preview.defaultView` | `ontology` | Which view the preview opens in |
| `rdf.preview.showIndividuals` | `false` | Show instances and `rdf:type` edges |
| `rdf.format.indent` | `4` | Spaces for predicate-object lists |

## Not included

Out of scope for now, listed so the boundaries are clear: OWL reasoning and
inference, SPARQL, remote `owl:imports` fetching, OWL Functional (`.ofn`) and
Manchester (`.omn`) syntax, and SVG export.

## Development

```bash
npm install
npm run watch     # rebuild on change
# then press F5 in VS Code to launch the Extension Development Host
npm test          # unit + end-to-end LSP tests
npm run typecheck
npm run package   # build a .vsix
```

Open `test/fixtures/retail/` in the development host to try it on something
realistic — a small e-commerce ontology of customers, vendors, products, SKUs,
addresses and orders, split across Turtle (`retail.ttl`), RDF/XML (`vendors.owl`)
and sample data (`instances.ttl`) so cross-format navigation is exercised too.
`test/fixtures/turtle/broken.ttl` shows error recovery.

See [CONTRIBUTING.md](CONTRIBUTING.md) for more.

## License

[MIT](LICENSE).

The graph layout uses [elkjs](https://github.com/kieler/elkjs), which is
EPL-2.0 licensed, so the packaged `.vsix` contains EPL-2.0 code alongside this
project's MIT source. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for
the full picture and for how to build without it.
