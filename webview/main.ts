import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import fcose from 'cytoscape-fcose';

cytoscape.use(dagre);
cytoscape.use(fcose);

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

interface GraphNode {
  id: string;
  label: string;
  kind: string;
  curie?: string;
  comment?: string;
  attributes?: Array<{ label: string; datatype: string; iri: string }>;
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

const graphEl = document.getElementById('graph')!;
const toolbarEl = document.getElementById('toolbar')!;
const bannerEl = document.getElementById('banner')!;
const emptyEl = document.getElementById('empty')!;
const detailsEl = document.getElementById('details')!;

let cy: cytoscape.Core | undefined;
let state: PanelState = { uri: '', view: 'ontology', scope: 'file', showIndividuals: false };
let lastView: string | undefined;
let lastScope: string | undefined;
let hiddenKinds = new Set<string>();

/**
 * Concrete colours read from VS Code's theme variables.
 *
 * Cytoscape paints to a canvas and cannot resolve CSS custom properties, so the
 * values have to be resolved here and re-read whenever the theme changes.
 */
function readTheme() {
  const style = getComputedStyle(document.body);
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    foreground: v('--vscode-editor-foreground', '#cccccc'),
    background: v('--vscode-editor-background', '#1e1e1e'),
    border: v('--vscode-panel-border', '#454545'),
    accent: v('--vscode-focusBorder', '#007acc'),
    class: v('--vscode-charts-blue', '#4fc1ff'),
    objectProperty: v('--vscode-charts-green', '#89d185'),
    datatypeProperty: v('--vscode-charts-orange', '#d7ba7d'),
    individual: v('--vscode-charts-purple', '#c586c0'),
    literal: v('--vscode-charts-yellow', '#dcdcaa'),
    blank: v('--vscode-descriptionForeground', '#8c8c8c'),
    muted: v('--vscode-descriptionForeground', '#8c8c8c'),
  };
}

function cytoscapeStyle(theme: ReturnType<typeof readTheme>): cytoscape.StylesheetJson {
  const nodeColour = (kind: string) =>
    ({
      class: theme.class,
      objectProperty: theme.objectProperty,
      datatypeProperty: theme.datatypeProperty,
      individual: theme.individual,
      literal: theme.literal,
      blank: theme.blank,
      ontology: theme.accent,
      resource: theme.class,
    })[kind] ?? theme.class;

  return [
    {
      selector: 'node',
      style: {
        'background-color': theme.background,
        'border-width': 2,
        'border-color': (n: any) => nodeColour(n.data('kind')),
        color: theme.foreground,
        label: 'data(displayLabel)',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': '160px',
        'font-size': '12px',
        'font-family': 'var(--vscode-font-family), sans-serif',
        shape: 'round-rectangle',
        width: 'label',
        height: 'label',
        padding: '10px',
      },
    },
    {
      selector: 'node[kind="literal"]',
      style: { shape: 'round-tag', 'border-style': 'dashed', 'font-style': 'italic' },
    },
    {
      selector: 'node[kind="blank"]',
      style: { shape: 'ellipse', 'border-style': 'dotted' },
    },
    {
      selector: 'node[kind="individual"]',
      style: { shape: 'ellipse' },
    },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'line-color': theme.border,
        'target-arrow-color': theme.border,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.9,
        'curve-style': 'bezier',
        label: 'data(label)',
        'font-size': '10px',
        color: theme.muted,
        'text-background-color': theme.background,
        'text-background-opacity': 0.85,
        'text-background-padding': '2px',
        'text-rotation': 'autorotate',
      },
    },
    {
      selector: 'edge[kind="subClassOf"]',
      style: { 'target-arrow-shape': 'triangle-tee', width: 2, 'line-color': theme.class, 'target-arrow-color': theme.class },
    },
    { selector: 'edge[kind="equivalent"]', style: { 'line-style': 'dashed' } },
    { selector: 'edge[kind="disjoint"]', style: { 'line-style': 'dotted' } },
    { selector: 'edge[kind="type"]', style: { 'line-style': 'dotted', 'line-color': theme.muted } },
    {
      selector: 'edge[kind="restriction"]',
      style: { 'line-style': 'dashed', 'line-color': theme.objectProperty, 'target-arrow-color': theme.objectProperty },
    },
    {
      selector: '.selected-term',
      style: { 'border-width': 4, 'border-color': theme.accent, 'z-index': 999 },
    },
    { selector: '.dimmed', style: { opacity: 0.15 } },
    { selector: ':selected', style: { 'border-width': 4, 'border-color': theme.accent } },
  ] as unknown as cytoscape.StylesheetJson;
}

function displayLabel(node: GraphNode): string {
  const head = node.label || node.curie || node.id;
  if (!node.attributes || node.attributes.length === 0) return head;
  const rows = node.attributes
    .slice(0, 6)
    .map((a) => (a.datatype ? `${a.label}: ${a.datatype}` : a.label));
  const more = node.attributes.length > 6 ? `\n…${node.attributes.length - 6} more` : '';
  return `${head}\n────────\n${rows.join('\n')}${more}`;
}

function ensureCy(): cytoscape.Core {
  if (cy) return cy;
  cy = cytoscape({
    container: graphEl,
    style: cytoscapeStyle(readTheme()),
    wheelSensitivity: 0.2,
    minZoom: 0.05,
    maxZoom: 4,
  });

  cy.on('tap', 'node', (event) => {
    const node = event.target;
    showDetails(node.data());
    const source = node.data('source');
    if (source) vscode.postMessage({ type: 'reveal', location: source });
  });

  cy.on('tap', (event) => {
    if (event.target === cy) {
      detailsEl.hidden = true;
      cy!.elements().removeClass('dimmed');
    }
  });

  return cy;
}

function layoutFor(view: string): cytoscape.LayoutOptions {
  if (view === 'ontology') {
    // Hierarchies read best top-down; dagre is built for exactly this.
    return {
      name: 'dagre',
      rankDir: 'BT',
      nodeSep: 40,
      rankSep: 70,
      animate: false,
      fit: true,
      padding: 30,
    } as unknown as cytoscape.LayoutOptions;
  }
  // A triple graph is a hairball; force-directed keeps it legible.
  return {
    name: 'fcose',
    quality: 'default',
    animate: false,
    randomize: true,
    nodeSeparation: 90,
    idealEdgeLength: 110,
    fit: true,
    padding: 30,
  } as unknown as cytoscape.LayoutOptions;
}

/**
 * Applies a new model to the existing graph.
 *
 * Only genuinely new nodes are positioned, and only when the change is small: a
 * full re-layout on every keystroke would make the graph jump around while the
 * user is typing, which is worse than useless.
 */
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

  emptyEl.hidden = visibleNodes.length > 0;
  if (visibleNodes.length === 0) {
    emptyEl.textContent =
      model.nodes.length === 0
        ? 'Nothing to show yet. Define a class or a property to see the graph.'
        : 'Every node is hidden by the current filters.';
  }

  const nextIds = new Set([...visibleIds, ...visibleEdges.map((e) => e.id)]);
  const existingIds = new Set(core.elements().map((el) => el.id()));

  core.batch(() => {
    // Remove what is gone.
    core.elements().forEach((el) => {
      if (!nextIds.has(el.id())) el.remove();
    });

    const added: string[] = [];
    for (const node of visibleNodes) {
      const data = { ...node, displayLabel: displayLabel(node) };
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

    // Seed new nodes near their neighbours so they do not appear at the origin.
    if (!viewChanged && existingIds.size > 0) {
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
              (Math.random() - 0.5) * 60,
            y: positions.reduce((sum, p) => sum + p.y, 0) / positions.length + 70,
          });
        }
      }
    }
  });

  const total = core.nodes().length;
  const newRatio = total === 0 ? 1 : (total - existingIds.size) / total;
  // Re-lay out only on a structural change, not on incremental edits.
  if (viewChanged || existingIds.size === 0 || newRatio > 0.3) {
    core.layout(layoutFor(model.view)).run();
  }

  renderBanner(model);
  renderToolbar(model);
}

function renderBanner(model: GraphModel): void {
  const parts: string[] = [];
  if (model.truncated) {
    parts.push(
      `Showing the ${model.truncated.shown} most connected of ${model.truncated.total} nodes. Filter or narrow the scope to see more.`
    );
  }
  if (model.ontology) {
    const o = model.ontology;
    const bits = [o.title ?? o.iri];
    if (o.versionInfo) bits.push(`v${o.versionInfo}`);
    if (o.imports.length > 0) bits.push(`imports ${o.imports.length}`);
    parts.push(bits.join(' · '));
  }
  bannerEl.hidden = parts.length === 0;
  bannerEl.textContent = parts.join('  —  ');
  bannerEl.className = model.truncated ? 'banner warn' : 'banner';
}

function button(label: string, title: string, active: boolean, onClick: () => void): HTMLElement {
  const el = document.createElement('button');
  el.textContent = label;
  el.title = title;
  el.className = active ? 'active' : '';
  el.setAttribute('aria-pressed', String(active));
  el.addEventListener('click', onClick);
  return el;
}

function renderToolbar(model: GraphModel): void {
  toolbarEl.replaceChildren();

  const views = document.createElement('div');
  views.className = 'group';
  views.append(
    button('Ontology', 'Classes, hierarchy and properties', state.view === 'ontology', () =>
      vscode.postMessage({ type: 'setView', view: 'ontology' })
    ),
    button('Triples', 'Every subject, predicate and object', state.view === 'triples', () =>
      vscode.postMessage({ type: 'setView', view: 'triples' })
    )
  );
  toolbarEl.append(views);

  const scope = document.createElement('div');
  scope.className = 'group';
  scope.append(
    button('This file', 'Only the active document', state.scope === 'file', () =>
      vscode.postMessage({ type: 'setScope', scope: 'file' })
    ),
    button(
      'Workspace',
      `All indexed RDF files (${model.sources.length})`,
      state.scope === 'workspace',
      () => vscode.postMessage({ type: 'setScope', scope: 'workspace' })
    )
  );
  toolbarEl.append(scope);

  if (model.view === 'ontology') {
    const filters = document.createElement('div');
    filters.className = 'group';
    filters.append(
      button('Individuals', 'Show instances and their rdf:type edges', state.showIndividuals, () =>
        vscode.postMessage({ type: 'setShowIndividuals', value: !state.showIndividuals })
      )
    );
    toolbarEl.append(filters);
  } else {
    const filters = document.createElement('div');
    filters.className = 'group';
    filters.append(
      button('Literals', 'Show literal values', !hiddenKinds.has('literal'), () => {
        toggleKind('literal');
        vscode.postMessage({ type: 'refresh' });
      }),
      button('rdf:type', 'Show rdf:type edges', !hiddenKinds.has('type'), () => {
        toggleKind('type');
        vscode.postMessage({ type: 'refresh' });
      })
    );
    toolbarEl.append(filters);
  }

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Find a term…';
  search.setAttribute('aria-label', 'Find a term in the graph');
  search.addEventListener('input', () => focusSearch(search.value));
  toolbarEl.append(search);

  const actions = document.createElement('div');
  actions.className = 'group right';
  actions.append(
    button('Fit', 'Fit the graph to the panel', false, () => cy?.fit(undefined, 30)),
    button('PNG', 'Export the graph as a PNG image', false, () => {
      if (!cy) return;
      const data = cy.png({ full: true, scale: 2, bg: readTheme().background });
      vscode.postMessage({ type: 'export', data, format: 'png' });
    })
  );
  toolbarEl.append(actions);
}

let currentModel: GraphModel | undefined;

function toggleKind(kind: string): void {
  if (hiddenKinds.has(kind)) hiddenKinds.delete(kind);
  else hiddenKinds.add(kind);
  if (currentModel) render(currentModel);
}

function focusSearch(query: string): void {
  if (!cy) return;
  const needle = query.trim().toLowerCase();
  if (!needle) {
    cy.elements().removeClass('dimmed');
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
  if (matches.nonempty()) cy.animate({ fit: { eles: matches, padding: 80 }, duration: 200 });
}

function showDetails(data: any): void {
  detailsEl.hidden = false;
  detailsEl.replaceChildren();

  const title = document.createElement('h2');
  title.textContent = data.label ?? data.id;
  detailsEl.append(title);

  if (data.curie) {
    const curie = document.createElement('code');
    curie.textContent = data.curie;
    detailsEl.append(curie);
  }

  const iri = document.createElement('div');
  iri.className = 'iri';
  iri.textContent = data.id;
  iri.title = 'Click to copy';
  iri.addEventListener('click', () => vscode.postMessage({ type: 'copy', text: data.id }));
  detailsEl.append(iri);

  if (data.comment) {
    const comment = document.createElement('p');
    comment.textContent = data.comment;
    detailsEl.append(comment);
  }

  if (data.attributes?.length) {
    const list = document.createElement('ul');
    for (const a of data.attributes) {
      const li = document.createElement('li');
      li.textContent = a.datatype ? `${a.label}: ${a.datatype}` : a.label;
      list.append(li);
    }
    detailsEl.append(list);
  }
}

function highlight(iri: string | null): void {
  if (!cy) return;
  cy.nodes().removeClass('selected-term');
  if (!iri) return;
  const node = cy.getElementById(iri);
  if (node.nonempty()) {
    node.addClass('selected-term');
    showDetails(node.data());
  }
}

window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message?.type) {
    case 'graph':
      state = message.state ?? state;
      currentModel = message.model;
      vscode.setState(state);
      render(message.model);
      break;
    case 'highlight':
      highlight(message.iri ?? null);
      break;
    case 'error':
      bannerEl.hidden = false;
      bannerEl.className = 'banner error';
      bannerEl.textContent = message.message;
      break;
    default:
      break;
  }
});

// Re-resolve theme colours when VS Code switches themes.
new MutationObserver(() => {
  if (cy) cy.style(cytoscapeStyle(readTheme()));
}).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

const saved = vscode.getState();
if (saved && typeof saved === 'object') state = { ...state, ...(saved as PanelState) };

vscode.postMessage({ type: 'ready' });
