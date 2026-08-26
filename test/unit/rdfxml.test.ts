import { describe, expect, it } from 'vitest';
import { scanRdfXml } from '../../src/server/formats/rdfxml/scan.js';
import { parseDocument } from '../../src/server/core/document.js';
import { LineMap } from '../../src/server/core/text.js';

const URI = 'file:///ws/ontology.owl';

function slice(text: string, range: any): string {
  const lines = new LineMap(text);
  return text.slice(lines.offsetAt(range.start), lines.offsetAt(range.end));
}

const ONTOLOGY = [
  '<?xml version="1.0"?>',
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"',
  '         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"',
  '         xmlns:owl="http://www.w3.org/2002/07/owl#"',
  '         xml:base="http://example.org/">',
  '  <owl:Class rdf:about="#Person">',
  '    <rdfs:subClassOf rdf:resource="#Agent"/>',
  '    <rdfs:label>Person</rdfs:label>',
  '  </owl:Class>',
  '  <owl:Class rdf:ID="Agent"/>',
  '</rdf:RDF>',
].join('\n');

describe('scanRdfXml', () => {
  it('INVARIANT: every occurrence range slices back to the text that produced it', () => {
    const r = scanRdfXml(ONTOLOGY, URI);
    expect(r.occurrences.length).toBeGreaterThan(4);
    for (const occ of r.occurrences) {
      const written = slice(ONTOLOGY, occ.range);
      expect(written.length).toBeGreaterThan(0);
      if (occ.spelling === 'qname') {
        // An element or attribute name: must end with the term's local name.
        const local = written.includes(':') ? written.split(':')[1] : written;
        expect(occ.iri.endsWith(local)).toBe(true);
      } else if (occ.spelling === 'attrIri') {
        expect(written).not.toContain('"');
        expect(occ.iri.endsWith(written.replace(/^#/, ''))).toBe(true);
      } else if (occ.spelling === 'rdfID') {
        expect(occ.iri.endsWith(`#${written}`)).toBe(true);
      }
    }
  });

  it('resolves rdf:about, rdf:ID and rdf:resource against xml:base', () => {
    const r = scanRdfXml(ONTOLOGY, URI);
    const iris = r.occurrences.map((o) => o.iri);
    expect(iris).toContain('http://example.org/#Person');
    expect(iris).toContain('http://example.org/#Agent');
  });

  it('distinguishes rdf:ID from rdf:about so rename can re-render each correctly', () => {
    const r = scanRdfXml(ONTOLOGY, URI);
    const byId = r.occurrences.find((o) => o.spelling === 'rdfID')!;
    expect(byId.iri).toBe('http://example.org/#Agent');
    expect(slice(ONTOLOGY, byId.range)).toBe('Agent'); // no leading '#'
    const byAbout = r.occurrences.find((o) => o.spelling === 'attrIri' && o.role === 'subject')!;
    expect(slice(ONTOLOGY, byAbout.range)).toBe('#Person'); // '#' is part of the text
  });

  it('keeps ranges correct when an attribute value contains an entity', () => {
    const xml = [
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '  <rdf:Description rdf:about="http://e.org/a?x=1&amp;y=2"/>',
      '</rdf:RDF>',
    ].join('\n');
    const r = scanRdfXml(xml, URI);
    const occ = r.occurrences.find((o) => o.role === 'subject')!;
    // The range must cover the RAW source, not the shorter decoded value.
    expect(slice(xml, occ.range)).toBe('http://e.org/a?x=1&amp;y=2');
  });

  it('records element names as navigable predicates and classes', () => {
    const r = scanRdfXml(ONTOLOGY, URI);
    const subClassOf = r.occurrences.find((o) => o.iri.endsWith('subClassOf'))!;
    expect(subClassOf.role).toBe('predicate');
    expect(subClassOf.spelling).toBe('qname');
    expect(slice(ONTOLOGY, subClassOf.range)).toBe('rdfs:subClassOf');

    const owlClass = r.occurrences.find((o) => o.iri.endsWith('owl#Class'))!;
    expect(slice(ONTOLOGY, owlClass.range)).toBe('owl:Class');
  });

  it('collects xmlns declarations as prefixes', () => {
    const r = scanRdfXml(ONTOLOGY, URI);
    expect(r.prefixes.owl).toBe('http://www.w3.org/2002/07/owl#');
    expect(r.prefixes.rdfs).toBe('http://www.w3.org/2000/01/rdf-schema#');
  });
});

describe('cross-format equivalence', () => {
  it('produces the same quads from the same ontology in Turtle and RDF/XML', async () => {
    const ttl = [
      '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
      '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
      '@base <http://example.org/> .',
      '<#Person> a owl:Class ;',
      '    rdfs:subClassOf <#Agent> ;',
      '    rdfs:label "Person" .',
      '<#Agent> a owl:Class .',
    ].join('\n');

    const fromTtl = await parseDocument('file:///ws/o.ttl', ttl, 'turtle');
    const fromXml = await parseDocument(URI, ONTOLOGY, 'rdfxml');

    expect(fromTtl.diagnostics).toHaveLength(0);
    expect(fromXml.diagnostics).toHaveLength(0);

    const norm = (d: typeof fromTtl) =>
      d.quads
        .map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`)
        .sort();

    expect(norm(fromXml)).toEqual(norm(fromTtl));
  });
});
