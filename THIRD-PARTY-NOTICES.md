# Third-party notices

This extension is MIT licensed (see [LICENSE](LICENSE)) and bundles the following
third-party components.

## Permissive (MIT / ISC)

| Component | License |
| --- | --- |
| [n3](https://github.com/rdfjs/N3.js) | MIT |
| [rdfxml-streaming-parser](https://github.com/rdfjs/rdfxml-streaming-parser.js) | MIT |
| [saxes](https://github.com/lddubeau/saxes) | ISC |
| [cytoscape](https://github.com/cytoscape/cytoscape.js) | MIT |
| [cytoscape-fcose](https://github.com/iVis-at-Bilkent/cytoscape.js-fcose) | MIT |
| [cytoscape-elk](https://github.com/cytoscape/cytoscape.js-elk) | MIT |
| [vscode-languageclient / vscode-languageserver](https://github.com/microsoft/vscode-languageserver-node) | MIT |

## Eclipse Public License 2.0

**[elkjs](https://github.com/kieler/elkjs)** — © Kieler Institute, dual licensed
under **EPL-2.0 OR GPL-3.0-or-later**. This project uses it under the **EPL-2.0**.

elkjs provides the layered (Sugiyama) graph layout used by the ontology view. It
is bundled unmodified into `dist/webview.js`.

The EPL-2.0 is a file-level copyleft licence. It does not change the licence of
this project's own source, which remains MIT, but it does mean the distributed
`.vsix` contains EPL-2.0 code. If you redistribute this extension:

- keep this notice intact;
- the corresponding source for elkjs is available at
  <https://github.com/kieler/elkjs> and on npm;
- the full licence text is at <https://www.eclipse.org/legal/epl-2.0/>.

If you need a build with no EPL-2.0 code at all, remove `cytoscape-elk` and set
the ontology view's layout to `fcose` in `webview/main.ts`. The graph still
works; it is laid out organically rather than in layers.
