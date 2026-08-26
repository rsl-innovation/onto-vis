import { describe, expect, it } from 'vitest';
import { formatTurtle, DEFAULT_FORMAT_OPTIONS } from '../../src/server/features/formatting.js';
import { tokenizeTurtle } from '../../src/server/formats/turtle/scan.js';
import { parseDocument } from '../../src/server/core/document.js';

function fmt(text: string, options = DEFAULT_FORMAT_OPTIONS) {
  return formatTurtle(tokenizeTurtle(text), options);
}

describe('formatTurtle', () => {
  it('aligns and sorts the prefix block', () => {
    const out = fmt(
      [
        '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
        '@prefix ex: <http://example.org/> .',
        '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
        'ex:A a owl:Class .',
      ].join('\n')
    )!;
    const lines = out.split('\n');
    expect(lines[0]).toBe('@prefix ex:   <http://example.org/> .');
    expect(lines[1]).toBe('@prefix owl:  <http://www.w3.org/2002/07/owl#> .');
    expect(lines[2]).toBe('@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .');
  });

  it('indents predicate-object lists under the subject', () => {
    const out = fmt(
      '@prefix ex: <http://example.org/> .\nex:A a ex:B ; ex:p "v" ; ex:q "w" .'
    )!;
    expect(out).toContain('ex:A a ex:B ;\n    ex:p "v" ;\n    ex:q "w" .');
  });

  it('PRESERVES comments, which is why this is not an N3.Writer round-trip', () => {
    const src = [
      '# Header comment',
      '@prefix ex: <http://example.org/> .',
      '# About A',
      'ex:A a ex:B ; # trailing note',
      '    ex:p "v" .',
      '# Final word',
    ].join('\n');
    const out = fmt(src)!;
    expect(out).toContain('# Header comment');
    expect(out).toContain('# About A');
    expect(out).toContain('# trailing note');
    expect(out).toContain('# Final word');
  });

  it('keeps blank nodes and collections inline', () => {
    const out = fmt(
      [
        '@prefix ex: <http://example.org/> .',
        'ex:A ex:p [ ex:x "1" ; ex:y "2" ] ; ex:list ( 1 2 3 ) .',
      ].join('\n')
    )!;
    expect(out).toContain('[ ex:x "1" ; ex:y "2" ]');
    expect(out).toContain('( 1 2 3 )');
  });

  it('keeps literals with language tags and datatypes intact', () => {
    const out = fmt(
      [
        '@prefix ex: <http://example.org/> .',
        '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
        'ex:A ex:label "hi"@en ; ex:age "42"^^xsd:integer .',
      ].join('\n')
    )!;
    expect(out).toContain('"hi"@en');
    expect(out).toContain('"42"^^xsd:integer');
  });

  it('honours the configured indent', () => {
    const out = fmt('@prefix ex: <http://example.org/> .\nex:A a ex:B ; ex:p "v" .', {
      ...DEFAULT_FORMAT_OPTIONS,
      indent: 2,
    })!;
    expect(out).toContain('\n  ex:p "v" .');
  });

  it('REFUSES to format a file with a syntax error rather than rewriting it', () => {
    expect(fmt('@prefix ex: <http://example.org/> .\nex:A !!! .')).toBeUndefined();
  });

  it('refuses on an unbalanced bracket', () => {
    expect(fmt('@prefix ex: <http://example.org/> .\nex:A ex:p [ ex:x "1" .')).toBeUndefined();
  });

  it('SAFETY: formatting never changes the meaning of the document', async () => {
    const src = [
      '# comment',
      '@prefix ex: <http://example.org/> .',
      '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
      '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
      '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
      'ex:Person a owl:Class ; rdfs:label "Person"@en ; rdfs:subClassOf ex:Agent, ex:Thing .',
      'ex:Agent a owl:Class .',
      'ex:x ex:p [ ex:y "1" ] ; ex:items ( 1 2.5 true ) ; ex:n "42"^^xsd:integer .',
    ].join('\n');

    const formatted = fmt(src)!;
    expect(formatted).toBeDefined();

    const before = await parseDocument('file:///a.ttl', src, 'turtle');
    const after = await parseDocument('file:///a.ttl', formatted, 'turtle');
    expect(after.diagnostics).toHaveLength(0);

    // Blank node labels are regenerated, so compare structure with them masked.
    const norm = (d: typeof before) =>
      d.quads
        .map((q) =>
          [q.subject, q.predicate, q.object]
            .map((t) => (t.termType === 'BlankNode' ? '_:b' : t.value))
            .join(' ')
        )
        .sort();

    expect(norm(after)).toEqual(norm(before));
  });

  it('is idempotent', () => {
    const src = '@prefix ex: <http://example.org/> .\nex:A a ex:B ; ex:p "v" .';
    const once = fmt(src)!;
    expect(fmt(once)).toBe(once);
  });
});
