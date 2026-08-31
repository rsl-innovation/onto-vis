import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import fcose from 'cytoscape-fcose';
import { buildCard, type CardNode, type Theme } from './cards.js';

cytoscape.use(dagre);
cytoscape.use(fcose);

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

interface GraphNode extends CardNode {
  comment?: string;
  source?: { uri: string; range: unknown };
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: string;
}

interface GraphModel {
  view: 'ontology' | 'triples';
  nodes: GraphNode[];
  edges: GraphEdge[];
  ontology?: { iri: string; versionInfo?: string; imports: string[]; title?: string };
  truncated?: { shown: number; total: number };
  sources: string[];
}

interface PanelState {
  uri: string;
  view: 'ontology' | 'triples';
  scope: 'file' | 'workspace';
  showIndividuals: boolean;
}

interface LocalPrefs {
  showEdgeLabels: boolean;
}

const graphEl = document.getElementById('graph')!;
const toolbarEl = document.getElementById('toolbar')!;
const bannerEl = document.getElementById('banner')!;
const emptyEl = document.getElementById('empty')!;
const detailsEl = document.getElementById('details')!;

let cy: cytoscape.Core | undefined;
let state: PanelState = { uri: '', view: 'ontology', scope: 'file', showIndividuals: false };
let prefs: LocalPrefs = { showEdgeLabels: true };
let currentModel: GraphModel | undefined;
let lastView: string | undefined;
let lastScope: string | undefined;
const hiddenKinds = new Set<string>();

// --- theme ----------------------------------------------------------------

/**
 * Concrete colours resolved from the host's theme variables.
 *
 * Cytoscape paints to a canvas and the cards are SVG images, so neither can
 * resolve CSS custom properties; the values have to be read here and re-read
 * whenever the theme changes.
 */
function readTheme(): Theme {
  const style = getComputedStyle(document.body);
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    surface: v('--vscode-editorWidget-background', v('--vscode-editor-background', '#1e1e1e')),
    surfaceRaised: v('--vscode-editorHoverWidget-background', '#252526'),
    border: v('--vscode-panel-border', '#454545'),
    borderStrong: v('--vscode-editor-foreground', '#cccccc'),
    foreground: v('--vscode-editor-foreground', '#cccccc'),
    muted: v('--vscode-descriptionForeground', '#9d9d9d'),
    accent: v('--vscode-focusBorder', '#007acc'),
    class: v('--vscode-charts-blue', '#4fc1ff'),
    objectProperty: v('--vscode-charts-green', '#89d185'),
    datatypeProperty: v('--vscode-charts-orange', '#d7ba7d'),
    individual: v('--vscode-charts-purple', '#c586c0'),
    literal: v('--vscode-charts-yellow', '#d7ba7d'),
    blank: v('--vscode-descriptionForeground', '#8c8c8c'),
  };
}

let theme = readTheme();

// --- cytoscape style ------------------------------------------------------

/**
 * Node visuals come entirely from the generated card image, so the node itself
 * is invisible: no fill, no border. Selection and hover are handled by
 * regenerating the card and by an underlay, rather than by stacking a second
 * shape on top of the artwork.
 */
function cytoscapeStyle(t: Theme): cytoscape.StylesheetJson {
  return [
    {
      selector: 'node',
      style: {
        'background-opacity': 0,
        'border-width': 0,
        'background-image': 'data(card)',
        'background-fit': 'none',
        'background-width': 'data(cardW)',
        'background-height': 'data(cardH)',
        'background-clip': 'none',
        width: 'data(cardW)',
        height: 'data(cardH)',
        shape: 'rectangle',
        label: '',
      },
    },
    {
      selector: 'node.hovered',
      style: {
        'underlay-color': t.accent,
        'underlay-opacity': 0.12,
        'underlay-padding': 6,
      },
    },
    {
      selector: 'node.selected-term',
      style: {
        'underlay-color': t.accent,
        'underlay-opacity': 0.55,
        'underlay-padding': 4,
        'z-index': 950,
      },
    },

    // --- edges: the hierarchy carries the diagram, properties support it ---
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        width: 1.1,
        'line-color': t.border,
        'target-arrow-color': t.border,
        'target-arrow-shape': 'vee',
        'arrow-scale': 0.85,
        label: '',
        'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
        'font-size': '10px',
        color: t.muted,
        'text-background-color': t.surface,
        'text-background-opacity': 0.92,
        'text-background-padding': '3px',
        'text-background-shape': 'roundrectangle',
        'text-rotation': 'autorotate',
        'edge-text-rotation': 'autorotate',
      },
    },
    {
      // Generalisation: a hollow triangle, as in UML. The arrowhead states the
      // relationship, so repeating "subClassOf" on all of them is noise.
      selector: 'edge[kind="subClassOf"]',
      style: {
        width: 1.9,
        'line-color': t.muted,
        'target-arrow-color': t.muted,
        'target-arrow-shape': 'triangle',
        'target-arrow-fill': 'hollow',
        'arrow-scale': 1.25,
        'curve-style': 'taxi',
        'taxi-direction': 'upward',
        'taxi-turn': 24,
        'taxi-turn-min-distance': 12,
      },
    },
    {
      selector: 'edge[kind="domainRange"]',
      style: { 'line-color': t.objectProperty, 'target-arrow-color': t.objectProperty, width: 1.2 },
    },
    {
      selector: 'edge[kind="restriction"]',
      style: {
        'line-style': 'dashed',
        'line-dash-pattern': [5, 4],
        'line-color': t.objectProperty,
        'target-arrow-color': t.objectProperty,
      },
    },
    {
      selector: 'edge[kind="disjoint"]',
      style: {
        'line-style': 'dotted',
        'line-color': t.datatypeProperty,
        'target-arrow-shape': 'none',
        'source-arrow-shape': 'none',
      },
    },
    {
      selector: 'edge[kind="equivalent"]',
      style: {
        'line-style': 'dashed',
        'line-color': t.class,
        'target-arrow-shape': 'none',
      },
    },
    { selector: 'edge[kind="type"]', style: { 'line-style': 'dotted', 'line-color': t.individual } },
    { selector: 'edge.labelled', style: { label: 'data(label)' } },
    {
      selector: 'edge.hovered',
      style: {
        width: 2.4,
        'line-color': t.accent,
        'target-arrow-color': t.accent,
        color: t.foreground,
        label: 'data(label)',
        'z-index': 900,
      },
    },
    { selector: '.dimmed', style: { opacity: 0.32, 'text-opacity': 0.25 } },
  ] as unknown as cytoscape.StylesheetJson;
}

// --- rendering ------------------------------------------------------------

function cardDataFor(node: GraphNode) {
  const card = buildCard(node, theme);
  return { card: card.uri, cardW: card.width, cardH: card.height };
}

function ensureCy(): cytoscape.Core {
  if (cy) return cy;
  cy = cytoscape({
    container: graphEl,
    style: cytoscapeStyle(theme),
    wheelSensitivity: 0.2,
    minZoom: 0.08,
    maxZoom: 3,
    boxSelectionEnabled: false,
  });

  cy.on('tap', 'node', (event) => {
    const node = event.target;
    selectNode(node.id());
    const source = node.data('source');
    if (source) vscode.postMessage({ type: 'reveal', location: source });
  });

  cy.on('mouseover', 'node', (e) => e.target.addClass('hovered'));
  cy.on('mouseout', 'node', (e) => e.target.removeClass('hovered'));
  cy.on('mouseover', 'edge', (e) => e.target.addClass('hovered'));
  cy.on('mouseout', 'edge', (e) => e.target.removeClass('hovered'));

  cy.on('tap', (event) => {
    if (event.target === cy) clearSelection();
  });

  // Rotated edge labels turn to hash at low zoom; hide them until they can be read.
  cy.on('zoom', applyEdgeLabels);

  return cy;
}

let selectedId: string | undefined;

function selectNode(id: string): void {
  if (!cy) return;
  cy.nodes().removeClass('selected-term');
  selectedId = id;

  const node = cy.getElementById(id);
  node.addClass('selected-term');
  if (node.empty()) return;
  showDetails(node.data() as GraphNode);

  // Focus the selection: its neighbourhood stays lit, everything else recedes.
  cy.elements().addClass('dimmed');
  node.removeClass('dimmed');
  node.neighborhood().removeClass('dimmed');
  node.connectedEdges().removeClass('dimmed');

  revealFromBehindPanel(node);
}

/**
 * Nudges a node out from behind the details panel.
 *
 * The panel floats over the top-right of the canvas, so selecting a node there
 * would hide the very thing being described. Only pans when there is an actual
 * overlap, so a selection elsewhere never moves the diagram.
 */
function revealFromBehindPanel(node: cytoscape.NodeSingular): void {
  if (!cy || detailsEl.hidden) return;
  const panel = detailsEl.getBoundingClientRect();
  const canvas = graphEl.getBoundingClientRect();
  const box = node.renderedBoundingBox();

  const panelLeft = panel.left - canvas.left;
  const panelBottom = panel.bottom - canvas.top;

  const overlapX = box.x2 - (panelLeft - 16);
  const overlapsVertically = box.y1 < panelBottom + 16;
  if (overlapX <= 0 || !overlapsVertically) return;

  // Prefer sliding left; drop down instead if the node is too wide to clear.
  const canSlideLeft = box.x1 - overlapX > 16;
  cy.animate({
    panBy: canSlideLeft
      ? { x: -overlapX, y: 0 }
      : { x: 0, y: panelBottom + 24 - box.y1 },
    duration: 180,
  });
}

function clearSelection(): void {
  if (!cy) return;
  selectedId = undefined;
  cy.nodes().removeClass('selected-term');
  cy.elements().removeClass('dimmed');
  detailsEl.hidden = true;
}

/**
 * Detects a cycle in the subclass graph.
 *
 * Relative-placement constraints must be satisfiable: a cyclic hierarchy (which
 * a malformed ontology can express) would make them contradictory and the layout
 * would fail outright rather than degrade.
 */
function hierarchyHasCycle(core: cytoscape.Core): boolean {
  const parents = new Map<string, string[]>();
  core.edges('[kind = "subClassOf"]').forEach((e) => {
    const list = parents.get(e.source().id());
    if (list) list.push(e.target().id());
    else parents.set(e.source().id(), [e.target().id()]);
  });

  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    const seen = state.get(id);
    if (seen === 1) return true;
    if (seen === 2) return false;
    state.set(id, 1);
    for (const parent of parents.get(id) ?? []) {
      if (visit(parent)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const id of parents.keys()) {
    if (visit(id)) return true;
  }
  return false;
}

/**
 * Lays the graph out.
 *
 * A real ontology is usually a shallow forest, not a deep tree: this one has
 * four small families and eleven classes with no superclass at all. Ranking
 * purely on generalisation therefore strings those roots out into one enormous
 * row, while ranking on every edge lets the property web drag related classes to
 * opposite corners.
 *
 * So the ontology view uses a force layout with two asymmetries. Generalisation
 * gets a much shorter ideal length, which pulls each family into a tight cluster
 * that reads as a unit; and every subclass carries a constraint placing it below
 * its parent, so the hierarchy still reads top-down. Compact, and the tree is
 * still the thing you see first.
 */
function runLayout(core: cytoscape.Core, view: string): void {
  const isOntology = view === 'ontology';

  const constraints =
    isOntology && !hierarchyHasCycle(core)
      ? core.edges('[kind = "subClassOf"]').map((e) => ({
          top: e.target().id(),
          bottom: e.source().id(),
          gap: 110,
        }))
      : [];

  const options = {
    name: 'fcose',
    quality: 'proof',
    animate: false,
    randomize: true,
    fit: false,
    padding: 30,
    nodeSeparation: isOntology ? 140 : 120,
    nodeRepulsion: isOntology ? 14000 : 11000,
    idealEdgeLength: (edge: cytoscape.EdgeSingular) => {
      const kind = edge.data('kind');
      if (kind === 'subClassOf') return 95;
      if (kind === 'disjoint' || kind === 'equivalent') return 130;
      if (kind === 'type') return 90;
      return 210;
    },
    edgeElasticity: (edge: cytoscape.EdgeSingular) =>
      edge.data('kind') === 'subClassOf' ? 0.6 : 0.2,
    relativePlacementConstraint: constraints.length > 0 ? constraints : undefined,
  } as unknown as cytoscape.LayoutOptions;

  const run = (opts: cytoscape.LayoutOptions) => {
    const layout = core.layout(opts);
    // The layout settles asynchronously; fitting before `layoutstop` measures
    // positions that are still moving and crops the result.
    layout.one('layoutstop', () => fitReadably(core));
    layout.run();
  };

  try {
    run(options);
  } catch {
    // Unsatisfiable constraints: lay out without them rather than not at all.
    run({
      ...(options as unknown as Record<string, unknown>),
      relativePlacementConstraint: undefined,
    } as unknown as cytoscape.LayoutOptions);
  }
}

/**
 * Fits the graph, but never zooms out past the point where card text stops
 * being readable. A diagram you cannot read is not more useful for being whole,
 * and the banner already says when content is off-screen.
 */
const MIN_READABLE_ZOOM = 0.5;

function fitReadably(core: cytoscape.Core): void {
  // Pick up any chrome that changed the container's height before measuring.
  core.resize();
  core.fit(undefined, 36);
  if (core.zoom() < MIN_READABLE_ZOOM) {
    core.zoom({
      level: MIN_READABLE_ZOOM,
      renderedPosition: { x: graphEl.clientWidth / 2, y: graphEl.clientHeight / 2 },
    });
    core.center();
  }
}

function render(model: GraphModel): void {
  const core = ensureCy();
  const viewChanged = lastView !== model.view || lastScope !== state.scope;
  lastView = model.view;
  lastScope = state.scope;

  const visibleNodes = model.nodes.filter((n) => !hiddenKinds.has(n.kind));
  const visibleIds = new Set(visibleNodes.map((n) => n.id));
  const visibleEdges = model.edges.filter(
    (e) => visibleIds.has(e.source) && visibleIds.has(e.target) && !hiddenKinds.has(e.kind)
  );

  renderEmptyState(model, visibleNodes.length);

  const nextIds = new Set([...visibleIds, ...visibleEdges.map((e) => e.id)]);
  const hadElements = core.elements().length > 0;
  const added: string[] = [];

  core.batch(() => {
    core.elements().forEach((el) => {
      if (!nextIds.has(el.id())) el.remove();
    });

    for (const node of visibleNodes) {
      const data = { ...node, ...cardDataFor(node) };
      const existing = core.getElementById(node.id);
      if (existing.nonempty()) existing.data(data);
      else {
        core.add({ group: 'nodes', data });
        added.push(node.id);
      }
    }
    for (const edge of visibleEdges) {
      if (core.getElementById(edge.id).nonempty()) continue;
      core.add({ group: 'edges', data: edge });
    }

    // Seed new nodes beside their neighbours so they never appear at the origin.
    if (!viewChanged && hadElements) {
      for (const id of added) {
        const node = core.getElementById(id);
        const placed = node
          .neighborhood()
          .nodes()
          .filter((n) => !added.includes(n.id()));
        if (placed.nonempty()) {
          const positions: Array<{ x: number; y: number }> = [];
          placed.forEach((n) => {
            positions.push(n.position());
          });
          node.position({
            x:
              positions.reduce((sum, p) => sum + p.x, 0) / positions.length +
              (Math.random() - 0.5) * 80,
            y: positions.reduce((sum, p) => sum + p.y, 0) / positions.length + 110,
          });
        }
      }
    }
  });

  applyEdgeLabels();

  // Chrome first. The toolbar, banner and legend all consume height from the
  // graph container, so laying out before they exist fits against a viewport
  // taller than the one the diagram actually gets, and crops it.
  document.body.classList.remove('loading');
  renderBanner(model);
  renderToolbar(model);
  renderLegend(model);

  // Node width and height are style mappings off card data. Inside a batch those
  // are deferred, and laying out before they resolve measures stale sizes.
  core.style().update();

  const total = core.nodes().length;
  const newRatio = total === 0 ? 0 : added.length / total;
  // Re-lay out only on a structural change, never on an incremental edit -
  // otherwise the graph jumps around while the user is still typing.
  if (viewChanged || !hadElements || newRatio > 0.3) {
    runLayout(core, model.view);
  }
}

const LABEL_ZOOM_THRESHOLD = 0.5;

function applyEdgeLabels(): void {
  if (!cy) return;
  cy.edges().removeClass('labelled');
  if (!prefs.showEdgeLabels || cy.zoom() < LABEL_ZOOM_THRESHOLD) return;
  // subClassOf is stated by its hollow arrowhead; labelling all of them is noise.
  cy.edges().filter((e) => e.data('kind') !== 'subClassOf').addClass('labelled');
}

function renderEmptyState(model: GraphModel, visibleCount: number): void {
  emptyEl.hidden = visibleCount > 0;
  if (visibleCount > 0) return;

  emptyEl.replaceChildren();
  const title = document.createElement('p');
  const hint = document.createElement('p');
  hint.className = 'hint';

  if (model.nodes.length === 0) {
    title.textContent =
      model.view === 'ontology' ? 'No classes to show yet' : 'No statements to show yet';
    hint.textContent =
      model.view === 'ontology'
        ? 'Declare a class with `a owl:Class`, or a property with rdfs:domain and rdfs:range, and it will appear here.'
        : 'Add a statement to this file and it will appear here.';
  } else {
    title.textContent = 'Everything is hidden by the current filters';
    hint.textContent = 'Turn a filter back on in the toolbar to see the graph.';
  }
  emptyEl.append(title, hint);
}

function renderBanner(model: GraphModel): void {
  bannerEl.replaceChildren();
  const parts: HTMLElement[] = [];

  if (model.ontology) {
    const o = model.ontology;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const name = document.createElement('strong');
    name.textContent = o.title ?? o.iri;
    meta.append(name);
    if (o.versionInfo) {
      const version = document.createElement('span');
      version.className = 'chip';
      version.textContent = `v${o.versionInfo}`;
      meta.append(version);
    }
    if (o.imports.length > 0) {
      const imports = document.createElement('span');
      imports.className = 'chip';
      imports.textContent = `${o.imports.length} import${o.imports.length === 1 ? '' : 's'}`;
      meta.append(imports);
    }
    parts.push(meta);
  }

  if (model.truncated) {
    const warn = document.createElement('span');
    warn.className = 'truncation';
    warn.textContent = `Showing the ${model.truncated.shown} most connected of ${model.truncated.total} nodes — narrow the scope or filter to see the rest.`;
    parts.push(warn);
  }

  bannerEl.hidden = parts.length === 0;
  bannerEl.className = model.truncated ? 'banner warn' : 'banner';
  bannerEl.append(...parts);
}

// --- toolbar --------------------------------------------------------------

function button(
  label: string,
  title: string,
  active: boolean,
  onClick: () => void,
  extraClass = ''
): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  el.title = title;
  el.className = `${active ? 'active' : ''} ${extraClass}`.trim();
  el.setAttribute('aria-pressed', String(active));
  el.addEventListener('click', onClick);
  return el;
}

function segmented(...buttons: HTMLElement[]): HTMLElement {
  const group = document.createElement('div');
  group.className = 'group';
  group.setAttribute('role', 'group');
  group.append(...buttons);
  return group;
}

function renderToolbar(model: GraphModel): void {
  toolbarEl.replaceChildren();

  toolbarEl.append(
    segmented(
      button('Ontology', 'Classes, hierarchy and properties', state.view === 'ontology', () =>
        vscode.postMessage({ type: 'setView', view: 'ontology' })
      ),
      button('Triples', 'Every subject, predicate and object', state.view === 'triples', () =>
        vscode.postMessage({ type: 'setView', view: 'triples' })
      )
    )
  );

  toolbarEl.append(
    segmented(
      button('This file', 'Only the active document', state.scope === 'file', () =>
        vscode.postMessage({ type: 'setScope', scope: 'file' })
      ),
      button(
        'Workspace',
        `Every indexed RDF file (${model.sources.length})`,
        state.scope === 'workspace',
        () => vscode.postMessage({ type: 'setScope', scope: 'workspace' })
      )
    )
  );

  const filters: HTMLElement[] = [
    button('Labels', 'Show the name of each property edge', prefs.showEdgeLabels, () => {
      prefs = { ...prefs, showEdgeLabels: !prefs.showEdgeLabels };
      persistPrefs();
      applyEdgeLabels();
      renderToolbar(model);
    }),
  ];
  if (model.view === 'ontology') {
    filters.push(
      button('Individuals', 'Show instances and their rdf:type edges', state.showIndividuals, () =>
        vscode.postMessage({ type: 'setShowIndividuals', value: !state.showIndividuals })
      )
    );
  } else {
    filters.push(
      button('Literals', 'Show literal values', !hiddenKinds.has('literal'), () =>
        toggleKind('literal')
      )
    );
  }
  toolbarEl.append(segmented(...filters));

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Find a term…';
  search.setAttribute('aria-label', 'Find a term in the graph');
  search.addEventListener('input', () => focusSearch(search.value));
  toolbarEl.append(search);

  const right = document.createElement('div');
  right.className = 'group right';
  right.append(
    button('−', 'Zoom out', false, () => zoomBy(1 / 1.3), 'icon'),
    button('+', 'Zoom in', false, () => zoomBy(1.3), 'icon'),
    button('Fit', 'Fit the graph to the panel', false, () => cy?.fit(undefined, 40)),
    button('PNG', 'Export the graph as a PNG image', false, exportPng)
  );
  toolbarEl.append(right);
}

function zoomBy(factor: number): void {
  if (!cy) return;
  cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: graphEl.clientWidth / 2, y: graphEl.clientHeight / 2 } });
}

function exportPng(): void {
  if (!cy) return;
  const data = cy.png({ full: true, scale: 2, bg: theme.surface });
  vscode.postMessage({ type: 'export', data, format: 'png' });
}

function toggleKind(kind: string): void {
  if (hiddenKinds.has(kind)) hiddenKinds.delete(kind);
  else hiddenKinds.add(kind);
  if (currentModel) render(currentModel);
}

// --- legend ---------------------------------------------------------------

function swatch(markup: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'swatch';
  el.innerHTML = markup;
  return el;
}

function legendRow(markup: string, label: string): HTMLElement {
  const row = document.createElement('li');
  const text = document.createElement('span');
  text.textContent = label;
  row.append(swatch(markup), text);
  return row;
}

function line(color: string, extra = ''): string {
  return `<svg width="26" height="10" viewBox="0 0 26 10" aria-hidden="true"><line x1="1" y1="5" x2="25" y2="5" stroke="${color}" stroke-width="1.8" ${extra}/></svg>`;
}

function renderLegend(model: GraphModel): void {
  const legend = document.getElementById('legend');
  if (!legend) return;
  legend.replaceChildren();

  const list = document.createElement('ul');
  if (model.view === 'ontology') {
    list.append(
      legendRow(
        `<svg width="26" height="10" viewBox="0 0 26 10" aria-hidden="true"><line x1="1" y1="5" x2="18" y2="5" stroke="${theme.muted}" stroke-width="1.8"/><path d="M18 1.5 L25 5 L18 8.5 Z" fill="none" stroke="${theme.muted}" stroke-width="1.5"/></svg>`,
        'is a subclass of'
      ),
      legendRow(line(theme.objectProperty), 'property (domain → range)'),
      legendRow(line(theme.objectProperty, 'stroke-dasharray="5 4"'), 'restriction'),
      legendRow(line(theme.datatypeProperty, 'stroke-dasharray="1 3"'), 'disjoint with'),
      legendRow(line(theme.class, 'stroke-dasharray="5 4"'), 'equivalent to'),
      legendRow(`<span class="dot" style="background:${theme.class}"></span>`, 'class')
    );
    if (state.showIndividuals) {
      list.append(
        legendRow(`<span class="dot" style="background:${theme.individual}"></span>`, 'individual'),
        legendRow(line(theme.individual, 'stroke-dasharray="1 3"'), 'is an instance of')
      );
    }
  } else {
    list.append(
      legendRow(line(theme.border), 'predicate'),
      legendRow(line(theme.individual, 'stroke-dasharray="1 3"'), 'rdf:type'),
      legendRow(`<span class="dot" style="background:${theme.class}"></span>`, 'resource'),
      legendRow(`<span class="pill-swatch literal"></span>`, 'literal'),
      legendRow(`<span class="pill-swatch blank"></span>`, 'blank node')
    );
  }
  legend.append(list);
}

// --- details --------------------------------------------------------------

function showDetails(data: GraphNode): void {
  detailsEl.hidden = false;
  detailsEl.replaceChildren();

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'close';
  close.textContent = '×';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close details');
  close.addEventListener('click', clearSelection);
  detailsEl.append(close);

  const title = document.createElement('h2');
  title.textContent = data.label || data.id;
  detailsEl.append(title);

  if (data.curie) {
    const curie = document.createElement('code');
    curie.className = 'curie';
    curie.textContent = data.curie;
    detailsEl.append(curie);
  }

  if (data.comment) {
    const comment = document.createElement('p');
    comment.textContent = data.comment;
    detailsEl.append(comment);
  }

  if (data.attributes?.length) {
    detailsEl.append(sectionTitle('Attributes'));
    const table = document.createElement('dl');
    table.className = 'attrs';
    for (const a of data.attributes) {
      const name = document.createElement('dt');
      name.textContent = a.label;
      const type = document.createElement('dd');
      type.textContent = a.datatype || '—';
      table.append(name, type);
    }
    detailsEl.append(table);
  }

  // Relationships, read straight off the rendered graph.
  const node = cy?.getElementById(data.id);
  if (node && node.nonempty()) {
    const outgoing = node.outgoers('edge').filter((e) => e.data('kind') !== 'subClassOf');
    const parents = node.outgoers('edge').filter((e) => e.data('kind') === 'subClassOf');
    const children = node.incomers('edge').filter((e) => e.data('kind') === 'subClassOf');

    if (parents.nonempty() || children.nonempty()) {
      detailsEl.append(sectionTitle('Hierarchy'));
      const list = document.createElement('ul');
      list.className = 'links';
      parents.forEach((e) => list.append(linkRow('↑', e.target().data('label'), e.target().id())));
      children.forEach((e) => list.append(linkRow('↓', e.source().data('label'), e.source().id())));
      detailsEl.append(list);
    }

    if (outgoing.nonempty()) {
      detailsEl.append(sectionTitle('Relationships'));
      const list = document.createElement('ul');
      list.className = 'links';
      outgoing.forEach((e) =>
        list.append(linkRow(e.data('label'), e.target().data('label'), e.target().id()))
      );
      detailsEl.append(list);
    }
  }

  const iri = document.createElement('button');
  iri.type = 'button';
  iri.className = 'iri';
  iri.textContent = data.id;
  iri.title = 'Copy this IRI';
  iri.addEventListener('click', () => vscode.postMessage({ type: 'copy', text: data.id }));
  detailsEl.append(iri);
}

function sectionTitle(text: string): HTMLElement {
  const el = document.createElement('h3');
  el.textContent = text;
  return el;
}

function linkRow(prefix: string, label: string, targetId: string): HTMLElement {
  const li = document.createElement('li');
  const rel = document.createElement('span');
  rel.className = 'rel';
  rel.textContent = prefix;
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'link';
  link.textContent = label ?? targetId;
  link.addEventListener('click', () => {
    selectNode(targetId);
    const node = cy?.getElementById(targetId);
    if (node?.nonempty()) cy?.animate({ center: { eles: node }, duration: 200 });
  });
  li.append(rel, link);
  return li;
}

// --- search and highlight -------------------------------------------------

function focusSearch(query: string): void {
  if (!cy) return;
  const needle = query.trim().toLowerCase();
  if (!needle) {
    cy.elements().removeClass('dimmed');
    if (selectedId) selectNode(selectedId);
    return;
  }
  const matches = cy.nodes().filter((n) => {
    const d = n.data();
    return (
      String(d.label ?? '').toLowerCase().includes(needle) ||
      String(d.curie ?? '').toLowerCase().includes(needle) ||
      String(d.id ?? '').toLowerCase().includes(needle)
    );
  });
  cy.elements().addClass('dimmed');
  matches.removeClass('dimmed');
  matches.neighborhood().removeClass('dimmed');
  if (matches.nonempty()) cy.animate({ fit: { eles: matches, padding: 90 }, duration: 200 });
}

function highlight(iri: string | null): void {
  if (!cy || !iri) return;
  const node = cy.getElementById(iri);
  if (node.nonempty()) selectNode(iri);
}

// --- wiring ---------------------------------------------------------------

function persistPrefs(): void {
  vscode.setState({ ...state, ...prefs });
}

window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message?.type) {
    case 'graph':
      state = message.state ?? state;
      currentModel = message.model;
      persistPrefs();
      render(message.model);
      break;
    case 'highlight':
      highlight(message.iri ?? null);
      break;
    case 'error':
      document.body.classList.remove('loading');
      bannerEl.hidden = false;
      bannerEl.className = 'banner error';
      bannerEl.textContent = message.message;
      break;
    default:
      break;
  }
});

// Re-resolve colours and repaint every card when the host theme changes.
new MutationObserver(() => {
  const next = readTheme();
  if (JSON.stringify(next) === JSON.stringify(theme)) return;
  theme = next;
  if (!cy) return;

  cy.style(cytoscapeStyle(theme));

  // Every card is now stale artwork. Cytoscape will not repaint a node whose
  // background image changes in place, so replace the elements outright and put
  // them back exactly where they were.
  const positions = new Map<string, { x: number; y: number }>();
  cy.nodes().forEach((n) => {
    positions.set(n.id(), { ...n.position() });
  });
  const pan = cy.pan();
  const zoom = cy.zoom();

  cy.elements().remove();
  if (currentModel) {
    render(currentModel);
    cy.batch(() => {
      cy!.nodes().forEach((n) => {
        const p = positions.get(n.id());
        if (p) n.position(p);
      });
    });
    cy.viewport({ zoom, pan });
    if (selectedId) selectNode(selectedId);
    renderLegend(currentModel);
  }
}).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

// Keep the canvas in step with the panel, including chrome that wraps onto a
// second line when the panel narrows.
new ResizeObserver(() => cy?.resize()).observe(graphEl);

const saved = vscode.getState();
if (saved && typeof saved === 'object') {
  const s = saved as Partial<PanelState & LocalPrefs>;
  state = { ...state, ...(s as PanelState) };
  prefs = { showEdgeLabels: s.showEdgeLabels !== false };
}

document.body.classList.add('loading');
vscode.postMessage({ type: 'ready' });
