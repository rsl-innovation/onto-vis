import { describe, expect, it } from 'vitest';
import { WorkspaceIndex } from '../../src/server/core/workspaceIndex.js';
import { parseDocument } from '../../src/server/core/document.js';

const CORE_OWL = [
  '<?xml version="1.0"?>',
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"',
  '         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"',
  '         xmlns:owl="http://www.w3.org/2002/07/owl#"',
  '         xml:base="http://example.org/">',
  '  <owl:Class rdf:about="#Person">',
  '    <rdfs:label xml:lang="en">Person</rdfs:label>',
  '    <rdfs:comment>A human being.</rdfs:comment>',
  '  </owl:Class>',
  '</rdf:RDF>',
].join('\n');

const PEOPLE_TTL = [
  '@prefix ex: <http://example.org/> .',
  '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
  '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
  '',
  'ex:Employee a owl:Class ;',
  '    rdfs:subClassOf <http://example.org/#Person> .',
  '',
  'ex:alice a <http://example.org/#Person> .',
].join('\n');

async function buildIndex() {
  const index = new WorkspaceIndex();
  index.upsert(await parseDocument('file:///ws/core.owl', CORE_OWL, 'rdfxml'));
  index.upsert(await parseDocument('file:///ws/people.ttl', PEOPLE_TTL, 'turtle'));
  return index;
}

describe('WorkspaceIndex', () => {
  it('CROSS-FORMAT: finds a class defined in .owl from its use in .ttl', async () => {
    const index = await buildIndex();
    const PERSON = 'http://example.org/#Person';

    const defs = index.definitions(PERSON);
    expect(defs.length).toBeGreaterThan(0);
    // The definition lives in the RDF/XML file, referenced from the Turtle file.
    expect(defs.some((d) => d.uri.endsWith('core.owl'))).toBe(true);

    const refs = index.references(PERSON);
    expect(refs.some((r) => r.uri.endsWith('people.ttl'))).toBe(true);
    expect(refs.some((r) => r.uri.endsWith('core.owl'))).toBe(true);
  });

  it('reads label and comment across formats', async () => {
    const index = await buildIndex();
    expect(index.label('http://example.org/#Person')).toBe('Person');
    expect(index.comment('http://example.org/#Person')).toBe('A human being.');
  });

  it('classifies terms from asserted types', async () => {
    const index = await buildIndex();
    expect(index.kind('http://example.org/#Person')).toBe('class');
    expect(index.kind('http://example.org/Employee')).toBe('class');
    expect(index.kind('http://example.org/alice')).toBe('individual');
  });

  it('falls back to built-in vocabulary for undefined terms', async () => {
    const index = await buildIndex();
    expect(index.kind('http://www.w3.org/2000/01/rdf-schema#subClassOf')).toBe('objectProperty');
    expect(index.comment('http://www.w3.org/2002/07/owl#imports')).toContain('Imports another ontology');
  });

  it('locates the term under the cursor', async () => {
    const index = await buildIndex();
    // Line 4 (0-based) is `ex:Employee a owl:Class ;`
    const occ = index.occurrenceAt('file:///ws/people.ttl', { line: 4, character: 3 });
    expect(occ?.iri).toBe('http://example.org/Employee');
    expect(occ?.role).toBe('subject');
    expect(occ?.isDefinition).toBe(true);
  });

  it('returns nothing when the cursor is not on a term', async () => {
    const index = await buildIndex();
    const occ = index.occurrenceAt('file:///ws/people.ttl', { line: 3, character: 0 });
    expect(occ).toBeUndefined();
  });

  it('invalidates only the edited document', async () => {
    const index = await buildIndex();
    const PERSON = 'http://example.org/#Person';
    expect(index.references(PERSON).some((r) => r.uri.endsWith('people.ttl'))).toBe(true);

    // Rewrite people.ttl so it no longer mentions Person.
    index.upsert(
      await parseDocument(
        'file:///ws/people.ttl',
        '@prefix ex: <http://example.org/> .\nex:Other a ex:Thing .',
        'turtle'
      )
    );

    const refs = index.references(PERSON);
    expect(refs.some((r) => r.uri.endsWith('people.ttl'))).toBe(false);
    // …but the .owl file's contribution survives untouched.
    expect(refs.some((r) => r.uri.endsWith('core.owl'))).toBe(true);
  });

  it('drops a document entirely on remove', async () => {
    const index = await buildIndex();
    index.remove('file:///ws/core.owl');
    expect(index.size).toBe(1);
    const refs = index.references('http://example.org/#Person');
    expect(refs.every((r) => r.uri.endsWith('people.ttl'))).toBe(true);
  });

  it('does not index blank nodes across files', async () => {
    const index = new WorkspaceIndex();
    index.upsert(
      await parseDocument('file:///ws/a.ttl', '@prefix ex: <http://e/> .\n_:b1 ex:p ex:o .', 'turtle')
    );
    expect([...index.iris()].some((i) => i.startsWith('_:'))).toBe(false);
  });
});
