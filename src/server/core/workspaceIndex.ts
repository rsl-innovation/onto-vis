import { rangeContains } from './text.js';
import { lookupVocabTerm, RDF, RDFS, OWL } from './vocab.js';
import type { TermKind } from './vocab.js';
import type {
  Location,
  ParsedDocument,
  Position,
  Range,
  RdfQuad,
  TermOccurrence,
} from './types.js';

const RDF_TYPE = `${RDF}type`;
const RDFS_LABEL = `${RDFS}label`;
const RDFS_COMMENT = `${RDFS}comment`;
const RDFS_SUBCLASS = `${RDFS}subClassOf`;
const RDFS_DOMAIN = `${RDFS}domain`;
const RDFS_RANGE = `${RDFS}range`;
const SKOS_PREF_LABEL = 'http://www.w3.org/2004/02/skos/core#prefLabel';
const DCTERMS_TITLE = 'http://purl.org/dc/terms/title';

/** Predicates that supply a human-readable name, in order of preference. */
const LABEL_PREDICATES = [RDFS_LABEL, SKOS_PREF_LABEL, DCTERMS_TITLE];
/** Predicates that supply a description, in order of preference. */
const COMMENT_PREDICATES = [
  RDFS_COMMENT,
  'http://www.w3.org/2004/02/skos/core#definition',
  'http://purl.org/dc/terms/description',
];

export interface TermInfo {
  types: Set<string>;
  labels: Array<{ value: string; language?: string }>;
  comments: string[];
  superClasses: Set<string>;
  domains: Set<string>;
  ranges: Set<string>;
}

function emptyInfo(): TermInfo {
  return {
    types: new Set(),
    labels: [],
    comments: [],
    superClasses: new Set(),
    domains: new Set(),
    ranges: new Set(),
  };
}

interface DocEntry {
  definitions: Range[];
  references: Range[];
}

/**
 * A workspace-wide index of every RDF term, keyed by resolved absolute IRI.
 *
 * Because the key is the resolved IRI rather than anything textual, cross-file
 * and cross-format navigation fall out for free: a class defined in an `.owl`
 * file and used in a `.ttl` file is the same entry.
 *
 * Updates are per-document, so editing one file never costs a full rebuild.
 */
export class WorkspaceIndex {
  private readonly docs = new Map<string, ParsedDocument>();
  private readonly byIri = new Map<string, Map<string, DocEntry>>();
  private readonly irisByDoc = new Map<string, Set<string>>();
  private readonly termsByDoc = new Map<string, Map<string, TermInfo>>();

  get size(): number {
    return this.docs.size;
  }

  documents(): ParsedDocument[] {
    return [...this.docs.values()];
  }

  document(uri: string): ParsedDocument | undefined {
    return this.docs.get(uri);
  }

  has(uri: string): boolean {
    return this.docs.has(uri);
  }

  /** Adds or replaces a document, invalidating only that document's contributions. */
  upsert(doc: ParsedDocument): void {
    this.remove(doc.uri);
    this.docs.set(doc.uri, doc);

    const iris = new Set<string>();
    for (const occ of doc.occurrences) {
      if (!occ.iri || occ.iri.startsWith('_:')) continue; // blank nodes are file-scoped
      iris.add(occ.iri);
      let perDoc = this.byIri.get(occ.iri);
      if (!perDoc) {
        perDoc = new Map();
        this.byIri.set(occ.iri, perDoc);
      }
      let entry = perDoc.get(doc.uri);
      if (!entry) {
        entry = { definitions: [], references: [] };
        perDoc.set(doc.uri, entry);
      }
      entry.references.push(occ.range);
      if (occ.isDefinition) entry.definitions.push(occ.range);
    }
    this.irisByDoc.set(doc.uri, iris);
    this.termsByDoc.set(doc.uri, deriveTerms(doc.quads));
  }

  remove(uri: string): void {
    const iris = this.irisByDoc.get(uri);
    if (iris) {
      for (const iri of iris) {
        const perDoc = this.byIri.get(iri);
        if (!perDoc) continue;
        perDoc.delete(uri);
        if (perDoc.size === 0) this.byIri.delete(iri);
      }
    }
    this.irisByDoc.delete(uri);
    this.termsByDoc.delete(uri);
    this.docs.delete(uri);
  }

  clear(): void {
    this.docs.clear();
    this.byIri.clear();
    this.irisByDoc.clear();
    this.termsByDoc.clear();
  }

  /** Every place the term is written, across all files and formats. */
  references(iri: string): Location[] {
    const perDoc = this.byIri.get(iri);
    if (!perDoc) return [];
    const out: Location[] = [];
    for (const [uri, entry] of perDoc) {
      for (const range of entry.references) out.push({ uri, range });
    }
    return out;
  }

  /**
   * Where the term is described.
   *
   * Falls back to every reference when nothing declares it — better to offer the
   * uses than to leave go-to-definition silently doing nothing.
   */
  definitions(iri: string): Location[] {
    const perDoc = this.byIri.get(iri);
    if (!perDoc) return [];
    const out: Location[] = [];
    for (const [uri, entry] of perDoc) {
      for (const range of entry.definitions) out.push({ uri, range });
    }
    return out.length > 0 ? out : this.references(iri);
  }

  /** The innermost occurrence at a position, or undefined if the cursor is not on a term. */
  occurrenceAt(uri: string, position: Position): TermOccurrence | undefined {
    const doc = this.docs.get(uri);
    if (!doc) return undefined;
    let best: TermOccurrence | undefined;
    let bestWidth = Number.POSITIVE_INFINITY;
    for (const occ of doc.occurrences) {
      if (!rangeContains(occ.range, position)) continue;
      const width = rangeWidth(occ.range);
      if (width < bestWidth) {
        best = occ;
        bestWidth = width;
      }
    }
    return best;
  }

  /** Merges what every document says about a term. */
  info(iri: string): TermInfo {
    const merged = emptyInfo();
    const perDoc = this.byIri.get(iri);
    const sources = perDoc ? [...perDoc.keys()] : [...this.termsByDoc.keys()];
    for (const uri of sources) {
      const info = this.termsByDoc.get(uri)?.get(iri);
      if (!info) continue;
      for (const t of info.types) merged.types.add(t);
      for (const s of info.superClasses) merged.superClasses.add(s);
      for (const d of info.domains) merged.domains.add(d);
      for (const r of info.ranges) merged.ranges.add(r);
      merged.labels.push(...info.labels);
      merged.comments.push(...info.comments);
    }
    return merged;
  }

  /**
   * Classifies a term, preferring what the workspace actually asserts and falling
   * back to built-in vocabulary knowledge for terms the user has not defined.
   */
  kind(iri: string): TermKind {
    const info = this.info(iri);
    const k = kindFromTypes(info.types);
    if (k !== 'unknown') return k;
    // Structural inference: things used as a superclass or a domain are classes.
    if (info.superClasses.size > 0) return 'class';
    if (this.isUsedAsClass(iri)) return 'class';
    return lookupVocabTerm(iri)?.kind ?? 'unknown';
  }

  private isUsedAsClass(iri: string): boolean {
    for (const doc of this.docs.values()) {
      for (const q of doc.quads) {
        if (q.object.termType !== 'NamedNode' || q.object.value !== iri) continue;
        if (
          q.predicate.value === RDFS_SUBCLASS ||
          q.predicate.value === RDFS_DOMAIN ||
          q.predicate.value === RDFS_RANGE ||
          q.predicate.value === RDF_TYPE
        ) {
          return q.predicate.value !== RDF_TYPE;
        }
      }
    }
    return false;
  }

  /** Preferred human-readable name, honouring a language preference. */
  label(iri: string, preferredLanguage = 'en'): string | undefined {
    const { labels } = this.info(iri);
    if (labels.length === 0) return undefined;
    return (
      labels.find((l) => l.language === preferredLanguage)?.value ??
      labels.find((l) => !l.language)?.value ??
      labels[0].value
    );
  }

  comment(iri: string): string | undefined {
    const { comments } = this.info(iri);
    if (comments.length > 0) return comments[0];
    return lookupVocabTerm(iri)?.comment;
  }

  /** Every indexed IRI. Used by workspace symbol search. */
  iris(): IterableIterator<string> {
    return this.byIri.keys();
  }

  /** All quads across the workspace, for the merged graph view. */
  allQuads(): RdfQuad[] {
    const out: RdfQuad[] = [];
    for (const doc of this.docs.values()) out.push(...doc.quads);
    return out;
  }

  /** The first definition location for a term, used to make graph nodes clickable. */
  primaryLocation(iri: string): Location | undefined {
    return this.definitions(iri)[0];
  }
}

function rangeWidth(range: Range): number {
  if (range.start.line !== range.end.line) return Number.MAX_SAFE_INTEGER;
  return range.end.character - range.start.character;
}

function kindFromTypes(types: Set<string>): TermKind {
  if (types.has(`${OWL}Class`) || types.has(`${RDFS}Class`)) return 'class';
  if (types.has(`${OWL}ObjectProperty`)) return 'objectProperty';
  if (types.has(`${OWL}DatatypeProperty`)) return 'datatypeProperty';
  if (types.has(`${OWL}AnnotationProperty`)) return 'annotationProperty';
  if (types.has(`${RDFS}Datatype`)) return 'datatype';
  if (types.has(`${OWL}Ontology`)) return 'ontology';
  if (types.has(`${RDF}Property`)) return 'property';
  if (types.has(`${OWL}NamedIndividual`)) return 'individual';
  if (types.size > 0) return 'individual';
  return 'unknown';
}

/** Extracts per-term metadata from one document's quads. */
function deriveTerms(quads: RdfQuad[]): Map<string, TermInfo> {
  const map = new Map<string, TermInfo>();
  const get = (iri: string): TermInfo => {
    let info = map.get(iri);
    if (!info) {
      info = emptyInfo();
      map.set(iri, info);
    }
    return info;
  };

  for (const q of quads) {
    if (q.subject.termType !== 'NamedNode') continue;
    const subject = q.subject.value;
    const predicate = q.predicate.value;

    if (predicate === RDF_TYPE && q.object.termType === 'NamedNode') {
      get(subject).types.add(q.object.value);
      continue;
    }
    if (predicate === RDFS_SUBCLASS && q.object.termType === 'NamedNode') {
      get(subject).superClasses.add(q.object.value);
      continue;
    }
    if (predicate === RDFS_DOMAIN && q.object.termType === 'NamedNode') {
      get(subject).domains.add(q.object.value);
      continue;
    }
    if (predicate === RDFS_RANGE && q.object.termType === 'NamedNode') {
      get(subject).ranges.add(q.object.value);
      continue;
    }
    if (LABEL_PREDICATES.includes(predicate) && q.object.termType === 'Literal') {
      const label: { value: string; language?: string } = { value: q.object.value };
      if (q.object.language) label.language = q.object.language;
      get(subject).labels.push(label);
      continue;
    }
    if (COMMENT_PREDICATES.includes(predicate) && q.object.termType === 'Literal') {
      get(subject).comments.push(q.object.value);
    }
  }

  return map;
}
