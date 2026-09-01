# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Syntax highlighting for Turtle, N-Triples, N-Quads, TriG, Notation3 and RDF/XML.
- Diagnostics with error recovery, reporting every syntax error in a file rather
  than stopping at the first.
- Hover, completion (with automatic `@prefix` insertion), go to definition, find
  references, rename, document outline, workspace symbols and semantic highlighting.
- Cross-file *and cross-format* navigation: a class defined in an `.owl` file is
  navigable from a `.ttl` file.
- Turtle document formatting that preserves comments and declines to format files
  it cannot parse with confidence.
- Live ontology graph preview with an ontology view and a raw triples view,
  bidirectional selection sync with the editor, search, filters, workspace scope
  and PNG export.
- Content sniffing for `.owl` files, which may contain either RDF/XML or Turtle.
- A worked retail/e-commerce example ontology under `test/fixtures/retail/`,
  spanning Turtle, RDF/XML and instance data.

### Changed

- The ontology view now uses ELK's layered layout instead of a force layout, so
  classes are arranged in columns with no overlaps rather than scattered
  organically. This adds `elkjs` (EPL-2.0) to the bundle; see
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

[Unreleased]: https://github.com/rsl-innovation/onto-vis/commits/main
