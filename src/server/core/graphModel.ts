import { localName } from './text.js';
import { OWL, RDF, RDFS } from './vocab.js';
import type { WorkspaceIndex } from './workspaceIndex.js';
import type { Location, RdfQuad, RdfTerm } from './types.js';

const RDF_TYPE = `${RDF}type`;
const RDF_FIRST = `${RDF}first`;
const RDF_REST = `${RDF}rest`;
const RDFS_SUBCLASS = `${RDFS}subClassOf`;
const RDFS_DOMAIN = `${RDFS}domain`;
const RDFS_RANGE = `${RDFS}range`;
const RDFS_LABEL = `${RDFS}label`;
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const CLASS_TYPES = new Set([`${OWL}Class`, `${RDFS}Class`]);
const OBJECT_PROPERTY = `${OWL}ObjectProperty`;
const DATATYPE_PROPERTY = `${OWL}DatatypeProperty`;
const ANNOTATION_PROPERTY = `${OWL}AnnotationProperty`;

/** Restriction predicates, mapped to the operator shown on the edge label. */
const RESTRICTION_OPERATORS: Record<string, string> = {
  [`${OWL}someValuesFrom`]: 'some',
  [`${OWL}allValuesFrom`]: 'only',
  [`${OWL}hasValue`]: 'value',
  [`${OWL}cardinality`]: 'exactly',
  [`${OWL}minCardinality`]: 'min',
  [`${OWL}maxCardinality`]: 'max',
  [`${OWL}minQualifiedCardinality`]: 'min',
  [`${OWL}maxQualifiedCardinality`]: 'max',
  [`${OWL}qualifiedCardinality`]: 'exactly',
};

export type GraphView = 'ontology' | 'triples';

export type NodeKind =
  | 'class'
  | 'objectProperty'
  | 'datatypeProperty'
  | 'individual'
  | 'literal'
  | 'blank'
  | 'resource'
  | 'ontology';

export type EdgeKind =
  | 'subClassOf'
  | 'domainRange'
  | 'equivalent'
  | 'disjoint'
  | 'type'
  | 'restriction'
  | 'predicate';

export interface GraphNodeAttribute {
  label: string;
  datatype: string;
  iri: string;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  curie?: string;
  comment?: string;
  attributes?: GraphNodeAttribute[];
  source?: Location;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: EdgeKind;
}

export interface GraphOntologyMeta {
  iri: string;
  versionInfo?: string;
  imports: string[];
  title?: string;
}

export interface GraphModel {
  view: GraphView;
  nodes: GraphNode[];
  edges: GraphEdge[];
  ontology?: GraphOntologyMeta;
  /** Present only when the graph was too large to render in full. */
  truncated?: { shown: number; total: number };
  /** Files the model was built from, so the webview can show its scope. */
  sources: string[];
}

export interface GraphOptions {
  view: GraphView;
  maxNodes: number;
  showIndividuals: boolean;
  /** Prefixes used to render compact labels like `ex:Person`. */
  prefixes: Record<string, string>;
}

interface QuadIndex {
  bySubject: Map<string, RdfQuad[]>;
  byPredicate: Map<string, RdfQuad[]>;
}

function indexQuads(quads: RdfQuad[]): QuadIndex {
  const bySubject = new Map<string, RdfQuad[]>();
  const byPredicate = new Map<string, RdfQuad[]>();
  for (const q of quads) {
    push(bySubject, termKey(q.subject), q);
    push(byPredicate, q.predicate.value, q);
  }
  return { bySubject, byPredicate };
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** A stable node id: literals and blank nodes need synthetic, collision-free ids. */
function termKey(term: RdfTerm): string {
  if (term.termType === 'BlankNode') return `_:${term.value}`;
  if (term.termType === 'Literal') {
    return `"${term.value}"${term.language ? `@${term.language}` : ''}${
      term.datatype ? `^^${term.datatype}` : ''
    }`;
  }
  return term.value;
}

/** Renders `http://example.org/Person` as `ex:Person` when a prefix matches. */
function toCurie(iri: string, prefixes: Record<string, string>): string | undefined {
  let best: { prefix: string; ns: string } | undefined;
  for (const [prefix, ns] of Object.entries(prefixes)) {
    if (!ns || !iri.startsWith(ns)) continue;
    if (!best || ns.length > best.ns.length) best = { prefix, ns };
  }
  if (!best) return undefined;
  return `${best.prefix}:${iri.slice(best.ns.length)}`;
}

/**
 * Builds the graph the preview renders.
 *
 * Both views are derived from the merged quad store rather than from source text,
 * so a Turtle file and an RDF/XML file describing the same ontology produce the
 * same picture.
 */
export function buildGraphModel(
  quads: RdfQuad[],
  index: WorkspaceIndex,
  sources: string[],
  options: GraphOptions
): GraphModel {
  const model =
    options.view === 'triples'
      ? buildTripleGraph(quads, index, options)
      : buildOntologyGraph(quads, index, options);
  model.sources = sources;
  model.ontology = extractOntologyMeta(quads);
  return truncate(model, options.maxNodes);
}

function extractOntologyMeta(quads: RdfQuad[]): GraphOntologyMeta | undefined {
  const ontology = quads.find(
    (q) => q.predicate.value === RDF_TYPE && q.object.value === `${OWL}Ontology`
  );
  if (!ontology) return undefined;
  const iri = ontology.subject.value;
  const meta: GraphOntologyMeta = { iri, imports: [] };
  for (const q of quads) {
    if (q.subject.value !== iri) continue;
    if (q.predicate.value === `${OWL}imports`) meta.imports.push(q.object.value);
    else if (q.predicate.value === `${OWL}versionInfo`) meta.versionInfo = q.object.value;
    else if (q.predicate.value === RDFS_LABEL || q.predicate.value === 'http://purl.org/dc/terms/title')
      meta.title = q.object.value;
  }
  return meta;
}

function buildOntologyGraph(
  quads: RdfQuad[],
  index: WorkspaceIndex,
  options: GraphOptions
): GraphModel {
  const qi = indexQuads(quads);
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const typesOf = (iri: string): Set<string> => {
    const set = new Set<string>();
    for (const q of qi.bySubject.get(iri) ?? []) {
      if (q.predicate.value === RDF_TYPE) set.add(q.object.value);
    }
    return set;
  };

  const addNode = (iri: string, kind: NodeKind): GraphNode | undefined => {
    if (!iri || iri.startsWith('_:') || iri.startsWith('"')) return undefined;
    const existing = nodes.get(iri);
    if (existing) {
      // A later, more specific classification wins over a generic one.
      if (existing.kind === 'resource' && kind !== 'resource') existing.kind = kind;
      return existing;
    }
    const node: GraphNode = {
      id: iri,
      label: index.label(iri) ?? localName(iri),
      kind,
    };
    const curie = toCurie(iri, options.prefixes);
    if (curie) node.curie = curie;
    const comment = index.comment(iri);
    if (comment) node.comment = comment;
    const source = index.primaryLocation(iri);
    if (source) node.source = source;
    nodes.set(iri, node);
    return node;
  };

  const addEdge = (source: string, target: string, label: string, kind: EdgeKind) => {
    if (!nodes.has(source) || !nodes.has(target)) return;
    const id = `${kind}|${source}|${label}|${target}`;
    if (!edges.has(id)) edges.set(id, { id, source, target, label, kind });
  };

  // --- 1. Declared classes ------------------------------------------------
  for (const q of qi.byPredicate.get(RDF_TYPE) ?? []) {
    if (CLASS_TYPES.has(q.object.value)) addNode(q.subject.value, 'class');
  }
  // Anything used structurally as a class is one, even if never declared.
  for (const predicate of [RDFS_SUBCLASS, RDFS_DOMAIN, RDFS_RANGE]) {
    for (const q of qi.byPredicate.get(predicate) ?? []) {
      if (q.object.termType === 'NamedNode' && !q.object.value.startsWith(XSD)) {
        addNode(q.object.value, 'class');
      }
      if (predicate === RDFS_SUBCLASS && q.subject.termType === 'NamedNode') {
        addNode(q.subject.value, 'class');
      }
    }
  }

  // --- 2. Class hierarchy and class relations -----------------------------
  for (const q of qi.byPredicate.get(RDFS_SUBCLASS) ?? []) {
    if (q.subject.termType !== 'NamedNode') continue;
    if (q.object.termType === 'NamedNode') {
      addEdge(q.subject.value, q.object.value, 'subClassOf', 'subClassOf');
    } else if (q.object.termType === 'BlankNode') {
      addRestriction(q.subject.value, q.object, qi, addNode, addEdge);
    }
  }
  for (const [predicate, kind, label] of [
    [`${OWL}equivalentClass`, 'equivalent', 'equivalentClass'],
    [`${OWL}disjointWith`, 'disjoint', 'disjointWith'],
  ] as const) {
    for (const q of qi.byPredicate.get(predicate) ?? []) {
      if (q.subject.termType === 'NamedNode' && q.object.termType === 'NamedNode') {
        addNode(q.subject.value, 'class');
        addNode(q.object.value, 'class');
        addEdge(q.subject.value, q.object.value, label, kind);
      }
    }
  }

  // --- 3. Properties: object properties become edges, datatype properties
  //        become attribute rows on their domain class (UML style) ----------
  const propertySubjects = new Set<string>();
  for (const q of qi.byPredicate.get(RDF_TYPE) ?? []) {
    if (
      q.object.value === OBJECT_PROPERTY ||
      q.object.value === DATATYPE_PROPERTY ||
      q.object.value === ANNOTATION_PROPERTY ||
      q.object.value === `${RDF}Property`
    ) {
      propertySubjects.add(q.subject.value);
    }
  }
  for (const q of qi.byPredicate.get(RDFS_DOMAIN) ?? []) propertySubjects.add(q.subject.value);

  for (const property of propertySubjects) {
    const types = typesOf(property);
    const domains = valuesOf(qi, property, RDFS_DOMAIN);
    const ranges = valuesOf(qi, property, RDFS_RANGE);
    const label = index.label(property) ?? localName(property);

    const isDatatype =
      types.has(DATATYPE_PROPERTY) ||
      (!types.has(OBJECT_PROPERTY) && ranges.some((r) => r.startsWith(XSD)));

    if (isDatatype) {
      // Show as an attribute row inside each domain class.
      for (const domain of domains) {
        const node = nodes.get(domain);
        if (!node) continue;
        node.attributes ??= [];
        node.attributes.push({
          label,
          datatype: ranges.length > 0 ? localName(ranges[0]) : 'Literal',
          iri: property,
        });
      }
      if (domains.length === 0) addNode(property, 'datatypeProperty');
      continue;
    }

    // Object property: an edge from each domain to each range.
    if (domains.length > 0 && ranges.length > 0) {
      for (const domain of domains) {
        addNode(domain, 'class');
        for (const range of ranges) {
          addNode(range, 'class');
          addEdge(domain, range, label, 'domainRange');
        }
      }
    } else {
      addNode(property, 'objectProperty');
    }
  }

  // --- 4. Individuals, only when asked for --------------------------------
  if (options.showIndividuals) {
    for (const q of qi.byPredicate.get(RDF_TYPE) ?? []) {
      if (q.subject.termType !== 'NamedNode' || q.object.termType !== 'NamedNode') continue;
      if (!nodes.has(q.object.value) || nodes.get(q.object.value)!.kind !== 'class') continue;
      if (nodes.has(q.subject.value) && nodes.get(q.subject.value)!.kind === 'class') continue;
      addNode(q.subject.value, 'individual');
      addEdge(q.subject.value, q.object.value, 'a', 'type');
    }
  }

  return { view: 'ontology', nodes: [...nodes.values()], edges: [...edges.values()], sources: [] };
}

function valuesOf(qi: QuadIndex, subject: string, predicate: string): string[] {
  return (qi.bySubject.get(subject) ?? [])
    .filter((q) => q.predicate.value === predicate && q.object.termType === 'NamedNode')
    .map((q) => q.object.value);
}

/**
 * Renders an owl:Restriction as an annotated edge off the enclosing class rather
 * than as a visible blank node — `Person -[hasParent only Person]-> Person` reads
 * far better than a bare anonymous node in the middle of the graph.
 */
function addRestriction(
  owner: string,
  bnode: RdfTerm,
  qi: QuadIndex,
  addNode: (iri: string, kind: NodeKind) => GraphNode | undefined,
  addEdge: (s: string, t: string, label: string, kind: EdgeKind) => void
): void {
  const quads = qi.bySubject.get(termKey(bnode)) ?? [];
  const onProperty = quads.find((q) => q.predicate.value === `${OWL}onProperty`)?.object;
  if (!onProperty || onProperty.termType !== 'NamedNode') return;

  const constraint = quads.find((q) => RESTRICTION_OPERATORS[q.predicate.value]);
  if (!constraint) return;

  const operator = RESTRICTION_OPERATORS[constraint.predicate.value];
  const propertyLabel = localName(onProperty.value);

  if (constraint.object.termType === 'NamedNode') {
    addNode(owner, 'class');
    addNode(constraint.object.value, 'class');
    addEdge(owner, constraint.object.value, `${propertyLabel} ${operator}`, 'restriction');
    return;
  }

  // A cardinality restriction has a literal bound and no target class, so it
  // becomes an attribute row instead of a dangling edge.
  const node = addNode(owner, 'class');
  if (node) {
    node.attributes ??= [];
    node.attributes.push({
      label: `${propertyLabel} ${operator} ${constraint.object.value}`,
      datatype: '',
      iri: onProperty.value,
    });
  }
}

function buildTripleGraph(
  quads: RdfQuad[],
  index: WorkspaceIndex,
  options: GraphOptions
): GraphModel {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  const addTerm = (term: RdfTerm): string => {
    const id = termKey(term);
    if (!nodes.has(id)) {
      const node: GraphNode = {
        id,
        label: labelForTerm(term, index),
        kind: kindForTerm(term),
      };
      if (term.termType === 'NamedNode') {
        const curie = toCurie(term.value, options.prefixes);
        if (curie) node.curie = curie;
        const comment = index.comment(term.value);
        if (comment) node.comment = comment;
        const source = index.primaryLocation(term.value);
        if (source) node.source = source;
      }
      nodes.set(id, node);
    }
    return id;
  };

  for (const q of quads) {
    // rdf:first/rdf:rest are list plumbing; showing them buries the actual data.
    if (q.predicate.value === RDF_FIRST || q.predicate.value === RDF_REST) continue;
    const source = addTerm(q.subject);
    const target = addTerm(q.object);
    edges.push({
      id: `${source}|${q.predicate.value}|${target}|${edges.length}`,
      source,
      target,
      label: toCurie(q.predicate.value, options.prefixes) ?? localName(q.predicate.value),
      kind: q.predicate.value === RDF_TYPE ? 'type' : 'predicate',
    });
  }

  return { view: 'triples', nodes: [...nodes.values()], edges, sources: [] };
}

function labelForTerm(term: RdfTerm, index: WorkspaceIndex): string {
  if (term.termType === 'Literal') {
    const text = term.value.length > 60 ? `${term.value.slice(0, 57)}…` : term.value;
    return term.language ? `"${text}"@${term.language}` : `"${text}"`;
  }
  if (term.termType === 'BlankNode') return `_:${term.value}`;
  return index.label(term.value) ?? localName(term.value);
}

function kindForTerm(term: RdfTerm): NodeKind {
  if (term.termType === 'Literal') return 'literal';
  if (term.termType === 'BlankNode') return 'blank';
  return 'resource';
}

/**
 * Caps the graph at `maxNodes`, keeping the highest-degree nodes.
 *
 * The result reports what it dropped: silently truncating would read as a
 * complete picture of the ontology, which is worse than showing nothing.
 */
function truncate(model: GraphModel, maxNodes: number): GraphModel {
  if (model.nodes.length <= maxNodes) return model;

  const degree = new Map<string, number>();
  for (const e of model.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const kept = [...model.nodes]
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, maxNodes);
  const keptIds = new Set(kept.map((n) => n.id));

  return {
    ...model,
    nodes: kept,
    edges: model.edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target)),
    truncated: { shown: kept.length, total: model.nodes.length },
  };
}
