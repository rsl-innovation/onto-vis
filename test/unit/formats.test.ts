import { describe, expect, it } from 'vitest';
import { detectFormat, extensionOf, isRdfFile } from '../../src/server/core/formats.js';

describe('detectFormat', () => {
  it('maps unambiguous extensions directly', () => {
    expect(detectFormat('a.ttl', undefined, undefined)).toBe('turtle');
    expect(detectFormat('a.nt', undefined, undefined)).toBe('ntriples');
    expect(detectFormat('a.nq', undefined, undefined)).toBe('nquads');
    expect(detectFormat('a.trig', undefined, undefined)).toBe('trig');
  });

  it('sniffs .owl content instead of trusting the extension', () => {
    const xml = '<?xml version="1.0"?>\n<rdf:RDF xmlns:rdf="http://x#"></rdf:RDF>';
    const ttl = '@prefix ex: <http://example.org/> .\nex:A a ex:B .';
    expect(detectFormat('o.owl', undefined, xml)).toBe('rdfxml');
    // Protégé can save .owl as Turtle; the extension alone would get this wrong.
    expect(detectFormat('o.owl', undefined, ttl)).toBe('turtle');
  });

  it('does not mistake a leading IRI for an XML tag', () => {
    // N-Triples always starts with `<`, and Turtle may too.
    const nt = '<http://example.org/A> <http://example.org/b> <http://example.org/C> .';
    expect(detectFormat('a.owl', undefined, nt)).toBe('turtle');
    expect(detectFormat('a.rdf', undefined, nt)).toBe('turtle');
  });

  it('looks past a byte-order mark, blank lines and comments', () => {
    const ttl = '﻿\n# a leading comment\n\n@prefix ex: <http://e/> .';
    expect(detectFormat('x.owl', undefined, ttl)).toBe('turtle');
    const xml = '﻿\n<?xml version="1.0"?><rdf:RDF/>';
    expect(detectFormat('x.owl', undefined, xml)).toBe('rdfxml');
  });

  it('recognises RDF files by extension', () => {
    expect(isRdfFile('/a/b/c.ttl')).toBe(true);
    expect(isRdfFile('/a/b/c.owl')).toBe(true);
    expect(isRdfFile('/a/b/c.txt')).toBe(false);
    expect(extensionOf('file:///a/b.ttl?x=1')).toBe('ttl');
  });
});
