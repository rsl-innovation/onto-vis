/**
 * Shared contracts for every RDF format the extension understands.
 *
 * The central idea: each format contributes two independent passes — a *scanner*
 * that yields source ranges, and a *parser* that yields quads. They are joined on
 * the resolved absolute IRI. Every downstream feature (definition, references,
 * rename, hover, semantic tokens, graph preview) is written once against
 * `ParsedDocument` and is therefore format-agnostic.
 */

/** Zero-based, LSP-compatible. Structurally identical to `vscode-languageserver`'s Position. */
export interface Position {
  line: number;
  character: number;
}

/** Zero-based, end-exclusive. Structurally identical to LSP's Range. */
export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export type RdfFormat = 'turtle' | 'ntriples' | 'nquads' | 'trig' | 'n3' | 'rdfxml';

/** The Turtle-family formats, all handled by the same scanner and by N3.Parser. */
export const TURTLE_FAMILY: readonly RdfFormat[] = ['turtle', 'ntriples', 'nquads', 'trig', 'n3'];

export function isTurtleFamily(format: RdfFormat): boolean {
  return TURTLE_FAMILY.includes(format);
}

/**
 * How an occurrence is spelled in the source text.
 *
 * One IRI has many possible spellings, so rename can never be a blind text
 * replacement — it must re-render each occurrence in its own form. Getting this
 * wrong corrupts files, which is the single worst failure mode in this extension.
 */
export type Spelling =
  /** `:Person` or `ex:Person` — a prefixed name (Turtle). */
  | 'curie'
  /** `<http://example.org/Person>` — an absolute IRI in angle brackets (Turtle). */
  | 'absolute'
  /** `<#Person>` or `<Person>` — resolved against @base (Turtle). */
  | 'relative'
  /** `<owl:Class>` / `<rdfs:subClassOf>` — an element or attribute QName (RDF/XML). */
  | 'qname'
  /** `rdf:about="…"` / `rdf:resource="…"` — an IRI-bearing attribute value (RDF/XML). */
  | 'attrIri'
  /** `rdf:ID="Person"` — shorthand meaning base + "#Person" (RDF/XML). */
  | 'rdfID'
  /** `_:b1` — a blank node label; scoped to its file, never renamed across files. */
  | 'blankLabel'
  /** The bare `a` keyword standing for rdf:type. Never rewritten by rename. */
  | 'keyword';

/** Where a term sits in the triple that contains it. */
export type TermRole = 'subject' | 'predicate' | 'object' | 'datatype' | 'graph';

/**
 * One textual mention of an RDF term, with the exact source range that produced it.
 * This is the unit every navigation feature operates on.
 */
export interface TermOccurrence {
  /** Resolved absolute IRI — the join key between scanner and parser. */
  iri: string;
  /** Exact source range of the term as written. */
  range: Range;
  /**
   * For prefixed names, the range of just the local part (`Person` in `ex:Person`).
   * Rename edits this rather than the whole token when the prefix is unchanged.
   */
  localRange?: Range;
  role: TermRole;
  spelling: Spelling;
  /** True when this mention defines the term (subject of a typing/defining statement). */
  isDefinition: boolean;
}

/** A prefix declaration (`@prefix ex: <…>` or `xmlns:ex="…"`). */
export interface PrefixDeclaration {
  prefix: string;
  namespace: string;
  /** Range of the prefix label itself, for rename. */
  range: Range;
  /** Range of the whole declaration, for "remove unused prefix" quick fixes. */
  fullRange: Range;
}

export type DiagnosticSeverity = 1 | 2 | 3 | 4; // Error | Warning | Information | Hint

export interface Diagnostic {
  range: Range;
  message: string;
  severity: DiagnosticSeverity;
  /** Stable identifier so quick fixes can key off it. */
  code?: string;
  source?: string;
}

/** The result of scanning + parsing a single document. */
export interface ParsedDocument {
  uri: string;
  format: RdfFormat;
  /** Quads from the format's parser. Empty when the document failed to parse at all. */
  quads: RdfQuad[];
  prefixes: Record<string, string>;
  prefixDeclarations: PrefixDeclaration[];
  /** Effective base IRI (`@base`, `xml:base`, or the document URI). */
  base: string;
  occurrences: TermOccurrence[];
  diagnostics: Diagnostic[];
}

/**
 * A minimal structural view of an RDF/JS quad — enough for the graph model and
 * the index, without coupling every consumer to N3's concrete classes.
 */
export interface RdfTerm {
  termType: 'NamedNode' | 'BlankNode' | 'Literal' | 'Variable' | 'DefaultGraph';
  value: string;
  /** Literals only. */
  datatype?: string;
  /** Literals only. */
  language?: string;
}

export interface RdfQuad {
  subject: RdfTerm;
  predicate: RdfTerm;
  object: RdfTerm;
  graph?: RdfTerm;
}
