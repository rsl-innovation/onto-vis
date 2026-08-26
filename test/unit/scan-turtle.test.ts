import { describe, expect, it } from 'vitest';
import { scanTurtle, tokenizeTurtle } from '../../src/server/formats/turtle/scan.js';
import { LineMap } from '../../src/server/core/text.js';

const BASE = 'http://example.org/doc';

/** Slices the document using an occurrence's reported range. */
function sliceRange(text: string, range: { start: any; end: any }): string {
  const lines = new LineMap(text);
  return text.slice(lines.offsetAt(range.start), lines.offsetAt(range.end));
}

describe('tokenizeTurtle', () => {
  it('reports exact offsets on indented lines', () => {
    //                     0123456789...
    const text = 'ex:A a owl:Class ;\n    rdfs:label "hi" .\n';
    const tokens = tokenizeTurtle(text).filter((t) => t.type !== 'comment');
    for (const t of tokens) {
      expect(text.slice(t.start, t.end)).toBe(t.text);
    }
    const label = tokens.find((t) => t.value === 'label');
    expect(label).toBeDefined();
    // The indented token must report its real column, not a whitespace-stripped one.
    expect(text.slice(label!.start, label!.end)).toBe('rdfs:label');
  });

  it('does not swallow the statement-terminating dot into a local name', () => {
    const tokens = tokenizeTurtle('ex:A ex:b ex:C.\n');
    const last = tokens.filter((t) => t.type === 'pname').pop()!;
    expect(last.text).toBe('ex:C');
    const dot = tokens.find((t) => t.type === 'punct' && t.text === '.');
    expect(dot).toBeDefined();
  });

  it('handles all four string forms and keeps # inside them out of comments', () => {
    const text = [
      'ex:A ex:p "short # not a comment" ;',
      "    ex:q 'single' ;",
      '    ex:r """triple\nwith # hash""" ;',
      "    ex:s '''also triple''' .",
      '# a real comment',
    ].join('\n');
    const tokens = tokenizeTurtle(text);
    const strings = tokens.filter((t) => t.type === 'string');
    expect(strings).toHaveLength(4);
    const comments = tokens.filter((t) => t.type === 'comment');
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe('# a real comment');
  });

  it('treats # inside an IRI as part of the IRI', () => {
    const tokens = tokenizeTurtle('<http://ex.org/v#Thing> a ex:C .');
    const iri = tokens.find((t) => t.type === 'iriref')!;
    expect(iri.value).toBe('http://ex.org/v#Thing');
    expect(tokens.filter((t) => t.type === 'comment')).toHaveLength(0);
  });
});

describe('scanTurtle', () => {
  const doc = [
    '@prefix ex: <http://example.org/> .',
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
    '',
    'ex:Person a owl:Class ;',
    '    rdfs:label "Person"@en ;',
    '        rdfs:subClassOf ex:Agent, <#Thing> .',
    '',
    'ex:Agent a owl:Class .',
  ].join('\n');

  it('reports an undefined prefix for owl: but still scans the rest', () => {
    const r = scanTurtle(doc, BASE);
    const undef = r.diagnostics.filter((d) => d.code === 'undefined-prefix');
    expect(undef.length).toBeGreaterThan(0);
    expect(undef[0].message).toContain('owl:');
    expect(r.occurrences.length).toBeGreaterThan(0);
  });

  it('INVARIANT: every occurrence range slices back to the term as written', () => {
    const text = [
      '@prefix ex: <http://example.org/> .',
      '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
      '@base <http://example.org/base/> .',
      'ex:Person a owl:Class ;',
      '    ex:label "x" ;',
      '        ex:subClassOf ex:Agent, <#Thing> .',
      '<relative> ex:age "42"^^ex:integer .',
    ].join('\n');
    const r = scanTurtle(text, BASE);
    expect(r.occurrences.length).toBeGreaterThan(5);

    for (const occ of r.occurrences) {
      const written = sliceRange(text, occ.range);
      expect(written.length).toBeGreaterThan(0);
      // Whatever the spelling, the sliced text must be the token that produced the IRI.
      if (occ.spelling === 'curie') {
        expect(written).toMatch(/^[A-Za-z]*:/);
        const local = written.slice(written.indexOf(':') + 1);
        expect(occ.iri.endsWith(local)).toBe(true);
      } else if (occ.spelling === 'absolute' || occ.spelling === 'relative') {
        expect(written.startsWith('<')).toBe(true);
        expect(written.endsWith('>')).toBe(true);
      } else if (occ.spelling === 'keyword') {
        expect(written).toBe('a');
      }
    }
  });

  it('assigns roles from triple position, including inside nested blank nodes', () => {
    const text = [
      '@prefix ex: <http://example.org/> .',
      'ex:A ex:knows [ ex:name "n" ] .',
    ].join('\n');
    const r = scanTurtle(text, BASE);
    const byIri = (suffix: string) => r.occurrences.find((o) => o.iri.endsWith(suffix))!;
    expect(byIri('A').role).toBe('subject');
    expect(byIri('knows').role).toBe('predicate');
    // Inside `[ ... ]` the first term is a predicate of the anonymous node.
    expect(byIri('name').role).toBe('predicate');
  });

  it('marks only top-level subjects as definitions', () => {
    const text = ['@prefix ex: <http://example.org/> .', 'ex:A ex:p ex:B .'].join('\n');
    const r = scanTurtle(text, BASE);
    expect(r.occurrences.find((o) => o.iri.endsWith('A'))!.isDefinition).toBe(true);
    expect(r.occurrences.find((o) => o.iri.endsWith('B'))!.isDefinition).toBe(false);
  });

  it('resolves relative IRIs against @base and records the spelling', () => {
    const text = ['@base <http://example.org/base/> .', '<#Thing> a <Other> .'].join('\n');
    const r = scanTurtle(text, BASE);
    const thing = r.occurrences.find((o) => o.iri.includes('#Thing'))!;
    expect(thing.iri).toBe('http://example.org/base/#Thing');
    expect(thing.spelling).toBe('relative');
    const other = r.occurrences.find((o) => o.iri.endsWith('/Other'))!;
    expect(other.iri).toBe('http://example.org/base/Other');
  });

  it('records prefix declarations with a renameable range', () => {
    const text = '@prefix ex: <http://example.org/> .\nex:A a ex:B .';
    const r = scanTurtle(text, BASE);
    expect(r.prefixes.ex).toBe('http://example.org/');
    const decl = r.prefixDeclarations.find((d) => d.prefix === 'ex')!;
    expect(sliceRange(text, decl.range)).toBe('ex:');
    expect(sliceRange(text, decl.fullRange)).toBe('@prefix ex: <http://example.org/> .');
  });

  it('maps `a` to rdf:type as a predicate', () => {
    const text = '@prefix ex: <http://example.org/> .\nex:A a ex:B .';
    const r = scanTurtle(text, BASE);
    const t = r.occurrences.find((o) => o.iri.endsWith('22-rdf-syntax-ns#type'))!;
    expect(t.role).toBe('predicate');
    expect(sliceRange(text, t.range)).toBe('a');
  });
});
