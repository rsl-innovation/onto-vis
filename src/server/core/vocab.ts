/**
 * Built-in vocabulary knowledge.
 *
 * Used for hover documentation and completion of terms the user has not defined
 * themselves. This is deliberately a curated set of the terms people actually
 * write when authoring ontologies, not a mechanical dump of every vocabulary.
 */

export type TermKind =
  | 'class'
  | 'objectProperty'
  | 'datatypeProperty'
  | 'annotationProperty'
  | 'property'
  | 'individual'
  | 'datatype'
  | 'ontology'
  | 'unknown';

export interface VocabTerm {
  iri: string;
  kind: TermKind;
  /** One-line description shown in hover and completion detail. */
  comment: string;
}

export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
export const OWL = 'http://www.w3.org/2002/07/owl#';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const SKOS = 'http://www.w3.org/2004/02/skos/core#';
export const DCTERMS = 'http://purl.org/dc/terms/';
export const FOAF = 'http://xmlns.com/foaf/0.1/';
export const SH = 'http://www.w3.org/ns/shacl#';

/** Prefixes offered by completion, and auto-inserted when a term is accepted. */
export const WELL_KNOWN_PREFIXES: Record<string, string> = {
  rdf: RDF,
  rdfs: RDFS,
  owl: OWL,
  xsd: XSD,
  skos: SKOS,
  dcterms: DCTERMS,
  dc: 'http://purl.org/dc/elements/1.1/',
  foaf: FOAF,
  sh: SH,
  vann: 'http://purl.org/vocab/vann/',
  prov: 'http://www.w3.org/ns/prov#',
  time: 'http://www.w3.org/2006/time#',
  geo: 'http://www.w3.org/2003/01/geo/wgs84_pos#',
  schema: 'https://schema.org/',
  void: 'http://rdfs.org/ns/void#',
};

function terms(ns: string, entries: Array<[string, TermKind, string]>): VocabTerm[] {
  return entries.map(([local, kind, comment]) => ({ iri: ns + local, kind, comment }));
}

const VOCAB: VocabTerm[] = [
  ...terms(RDF, [
    ['type', 'property', 'States that the subject is an instance of a class. Abbreviated `a` in Turtle.'],
    ['Property', 'class', 'The class of RDF properties.'],
    ['Statement', 'class', 'The class of RDF statements, used for reification.'],
    ['List', 'class', 'The class of RDF lists.'],
    ['first', 'property', 'The first item in an RDF list.'],
    ['rest', 'property', 'The rest of an RDF list after the first item.'],
    ['nil', 'individual', 'The empty RDF list.'],
    ['value', 'property', 'Idiomatic property used for structured values.'],
    ['langString', 'datatype', 'The datatype of language-tagged string literals.'],
    ['HTML', 'datatype', 'The datatype of HTML literal values.'],
    ['JSON', 'datatype', 'The datatype of JSON literal values.'],
  ]),
  ...terms(RDFS, [
    ['Class', 'class', 'The class of classes.'],
    ['Resource', 'class', 'The class resource, everything.'],
    ['Literal', 'class', 'The class of literal values, such as strings and integers.'],
    ['Datatype', 'class', 'The class of RDF datatypes.'],
    ['subClassOf', 'objectProperty', 'States that all instances of the subject class are also instances of the object class.'],
    ['subPropertyOf', 'objectProperty', 'States that the subject property is a specialisation of the object property.'],
    ['domain', 'objectProperty', 'States that any resource with this property is an instance of the given class.'],
    ['range', 'objectProperty', 'States that the values of this property are instances of the given class.'],
    ['label', 'annotationProperty', 'A human-readable name for the subject.'],
    ['comment', 'annotationProperty', 'A human-readable description of the subject.'],
    ['seeAlso', 'annotationProperty', 'Further information about the subject.'],
    ['isDefinedBy', 'annotationProperty', 'The resource that defines the subject.'],
    ['member', 'objectProperty', 'A member of the subject container.'],
  ]),
  ...terms(OWL, [
    ['Ontology', 'class', 'The class of ontologies. Carries version and import metadata.'],
    ['Class', 'class', 'The class of OWL classes.'],
    ['ObjectProperty', 'class', 'A property that relates individuals to other individuals.'],
    ['DatatypeProperty', 'class', 'A property that relates individuals to literal values.'],
    ['AnnotationProperty', 'class', 'A property used for annotations, carrying no logical meaning.'],
    ['NamedIndividual', 'class', 'An individual with an IRI, as opposed to an anonymous one.'],
    ['Restriction', 'class', 'An anonymous class defined by a constraint on a property.'],
    ['Thing', 'class', 'The class of all individuals.'],
    ['Nothing', 'class', 'The empty class.'],
    ['imports', 'objectProperty', 'Imports another ontology, bringing in all of its axioms.'],
    ['versionIRI', 'objectProperty', 'The IRI identifying this specific version of the ontology.'],
    ['versionInfo', 'annotationProperty', 'A string describing this version of the ontology.'],
    ['deprecated', 'annotationProperty', 'Marks the subject as deprecated.'],
    ['equivalentClass', 'objectProperty', 'States that two classes have exactly the same instances.'],
    ['equivalentProperty', 'objectProperty', 'States that two properties relate the same things.'],
    ['disjointWith', 'objectProperty', 'States that two classes share no instances.'],
    ['sameAs', 'objectProperty', 'States that two IRIs refer to the same individual.'],
    ['differentFrom', 'objectProperty', 'States that two IRIs refer to different individuals.'],
    ['inverseOf', 'objectProperty', 'States that one property is the inverse of another.'],
    ['onProperty', 'objectProperty', 'The property a restriction constrains.'],
    ['someValuesFrom', 'objectProperty', 'Existential restriction: at least one value from the given class.'],
    ['allValuesFrom', 'objectProperty', 'Universal restriction: all values from the given class.'],
    ['hasValue', 'objectProperty', 'Restriction to a specific value.'],
    ['cardinality', 'datatypeProperty', 'Exact number of values the property must have.'],
    ['minCardinality', 'datatypeProperty', 'Minimum number of values the property must have.'],
    ['maxCardinality', 'datatypeProperty', 'Maximum number of values the property may have.'],
    ['intersectionOf', 'objectProperty', 'A class formed by intersecting the listed classes.'],
    ['unionOf', 'objectProperty', 'A class formed by uniting the listed classes.'],
    ['complementOf', 'objectProperty', 'A class containing everything not in the given class.'],
    ['TransitiveProperty', 'class', 'A property where a relates b and b relates c implies a relates c.'],
    ['SymmetricProperty', 'class', 'A property that holds in both directions.'],
    ['FunctionalProperty', 'class', 'A property with at most one value per subject.'],
    ['InverseFunctionalProperty', 'class', 'A property whose value uniquely identifies its subject.'],
  ]),
  ...terms(XSD, [
    ['string', 'datatype', 'A character string.'],
    ['boolean', 'datatype', 'true or false.'],
    ['integer', 'datatype', 'A whole number of any size.'],
    ['int', 'datatype', 'A 32-bit signed integer.'],
    ['long', 'datatype', 'A 64-bit signed integer.'],
    ['decimal', 'datatype', 'An exact decimal number.'],
    ['float', 'datatype', 'A 32-bit floating-point number.'],
    ['double', 'datatype', 'A 64-bit floating-point number.'],
    ['date', 'datatype', 'A calendar date, such as 2026-08-26.'],
    ['dateTime', 'datatype', 'A date and time, such as 2026-08-26T10:30:00.'],
    ['time', 'datatype', 'A time of day.'],
    ['duration', 'datatype', 'A length of time.'],
    ['anyURI', 'datatype', 'A URI reference.'],
    ['nonNegativeInteger', 'datatype', 'An integer of zero or greater.'],
    ['positiveInteger', 'datatype', 'An integer greater than zero.'],
  ]),
  ...terms(SKOS, [
    ['Concept', 'class', 'An idea or notion; a unit of thought.'],
    ['ConceptScheme', 'class', 'A set of concepts, such as a thesaurus or taxonomy.'],
    ['prefLabel', 'annotationProperty', 'The preferred label for a concept in a given language.'],
    ['altLabel', 'annotationProperty', 'An alternative label for a concept.'],
    ['definition', 'annotationProperty', 'A complete explanation of the concept.'],
    ['broader', 'objectProperty', 'A concept that is more general than this one.'],
    ['narrower', 'objectProperty', 'A concept that is more specific than this one.'],
    ['related', 'objectProperty', 'An associatively related concept.'],
    ['inScheme', 'objectProperty', 'The concept scheme this concept belongs to.'],
  ]),
  ...terms(DCTERMS, [
    ['title', 'annotationProperty', 'A name given to the resource.'],
    ['description', 'annotationProperty', 'An account of the resource.'],
    ['creator', 'objectProperty', 'An entity responsible for making the resource.'],
    ['created', 'datatypeProperty', 'Date of creation of the resource.'],
    ['modified', 'datatypeProperty', 'Date on which the resource was changed.'],
    ['license', 'objectProperty', 'A legal document giving official permission to do something with the resource.'],
    ['publisher', 'objectProperty', 'An entity responsible for making the resource available.'],
  ]),
];

const BY_IRI = new Map<string, VocabTerm>(VOCAB.map((t) => [t.iri, t]));

const BY_NAMESPACE = new Map<string, VocabTerm[]>();
for (const t of VOCAB) {
  const ns = t.iri.slice(0, Math.max(t.iri.lastIndexOf('#'), t.iri.lastIndexOf('/')) + 1);
  const list = BY_NAMESPACE.get(ns);
  if (list) list.push(t);
  else BY_NAMESPACE.set(ns, [t]);
}

export function lookupVocabTerm(iri: string): VocabTerm | undefined {
  return BY_IRI.get(iri);
}

export function vocabTermsInNamespace(namespace: string): VocabTerm[] {
  return BY_NAMESPACE.get(namespace) ?? [];
}

/** The conventional prefix for a namespace, used when suggesting a missing `@prefix`. */
export function conventionalPrefixFor(namespace: string): string | undefined {
  for (const [prefix, ns] of Object.entries(WELL_KNOWN_PREFIXES)) {
    if (ns === namespace) return prefix;
  }
  return undefined;
}
