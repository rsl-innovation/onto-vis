import { describe, expect, it } from 'vitest';
import { computeRename, prepareRename, findDefinitions, findReferences } from '../../src/server/features/navigation.js';
import { WorkspaceIndex } from '../../src/server/core/workspaceIndex.js';
import { parseDocument } from '../../src/server/core/document.js';
import type { TextEdit } from '../../src/server/features/navigation.js';

/** Applies edits to text so we can assert on the resulting document, not the edit objects. */
function applyEdits(text: string, edits: TextEdit[]): string {
  const lines = text.split('\n');
  // Apply right-to-left, bottom-up, so earlier edits keep their offsets.
  const sorted = [...edits].sort(
    (a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character
  );
  for (const e of sorted) {
    const line = lines[e.range.start.line];
    lines[e.range.start.line] =
      line.slice(0, e.range.start.character) + e.newText + line.slice(e.range.end.character);
  }
  return lines.join('\n');
}

/** Every way the same class can be written, in one Turtle file. */
const TTL = [
  '@prefix ex: <http://example.org/> .',
  '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
  '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
  '@base <http://example.org/> .',
  '',
  'ex:Person a owl:Class .',
  'ex:Employee rdfs:subClassOf <http://example.org/Person> .',
  'ex:Manager rdfs:subClassOf <Person> .',
].join('\n');

const OWL_XML = [
  '<?xml version="1.0"?>',
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"',
  '         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"',
  '         xmlns:owl="http://www.w3.org/2002/07/owl#"',
  '         xml:base="http://example.org/">',
  '  <owl:Class rdf:about="Person"/>',
  '  <owl:Class rdf:about="#Contractor">',
  '    <rdfs:subClassOf rdf:resource="Person"/>',
  '  </owl:Class>',
  '</rdf:RDF>',
].join('\n');

async function setup() {
  const texts = new Map([
    ['file:///ws/o.ttl', TTL],
    ['file:///ws/o.owl', OWL_XML],
  ]);
  const index = new WorkspaceIndex();
  index.upsert(await parseDocument('file:///ws/o.ttl', TTL, 'turtle'));
  index.upsert(await parseDocument('file:///ws/o.owl', OWL_XML, 'rdfxml'));
  return { index, textOf: (u: string) => texts.get(u), texts };
}

describe('rename', () => {
  it('re-renders each spelling in its own form rather than replacing text', async () => {
    const { index, textOf } = await setup();
    // Cursor on `ex:Person` (line 5, the curie).
    const r = computeRename(index, 'file:///ws/o.ttl', { line: 5, character: 4 }, 'Human', textOf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const ttl = applyEdits(TTL, r.edits.get('file:///ws/o.ttl')!);
    // The curie keeps its prefix…
    expect(ttl).toContain('ex:Human a owl:Class .');
    // …the absolute IRI keeps its full form…
    expect(ttl).toContain('<http://example.org/Human>');
    // …and the relative IRI stays relative.
    expect(ttl).toContain('<Human>');
    expect(ttl).not.toContain('Person');
  });

  it('CROSS-FORMAT: renames through RDF/XML attributes from a Turtle cursor', async () => {
    const { index, textOf } = await setup();
    const r = computeRename(index, 'file:///ws/o.ttl', { line: 5, character: 4 }, 'Human', textOf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const xml = applyEdits(OWL_XML, r.edits.get('file:///ws/o.owl')!);
    expect(xml).toContain('rdf:about="Human"');
    expect(xml).toContain('rdf:resource="Human"');
    // The unrelated class is untouched.
    expect(xml).toContain('rdf:about="#Contractor"');
  });

  it('renames an rdf:ID declaration together with its #-prefixed references', async () => {
    // rdf:ID="Agent" denotes base + "#Agent", so references must be written
    // `#Agent` - a bare `Agent` would be a different IRI entirely.
    const xml = [
      '<?xml version="1.0"?>',
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"',
      '         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"',
      '         xmlns:owl="http://www.w3.org/2002/07/owl#"',
      '         xml:base="http://example.org/">',
      '  <owl:Class rdf:ID="Agent"/>',
      '  <owl:Class rdf:about="#Person">',
      '    <rdfs:subClassOf rdf:resource="#Agent"/>',
      '  </owl:Class>',
      '</rdf:RDF>',
    ].join('\n');
    const uri = 'file:///ws/ids.owl';
    const index = new WorkspaceIndex();
    index.upsert(await parseDocument(uri, xml, 'rdfxml'));
    const textOf = () => xml;

    // Cursor inside rdf:ID="Agent" on line 5.
    const r = computeRename(index, uri, { line: 5, character: 22 }, 'Actor', textOf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const out = applyEdits(xml, r.edits.get(uri)!);
    expect(out).toContain('rdf:ID="Actor"');        // no '#' added
    expect(out).toContain('rdf:resource="#Actor"'); // '#' preserved
    expect(out).toContain('rdf:about="#Person"');   // untouched
  });

  it('edits every file the term appears in', async () => {
    const { index, textOf } = await setup();
    const r = computeRename(index, 'file:///ws/o.ttl', { line: 5, character: 4 }, 'Human', textOf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.edits.keys()].sort()).toEqual(['file:///ws/o.owl', 'file:///ws/o.ttl']);
    expect(r.count).toBe(5);
  });

  it('REFUSES rather than half-renaming when a document is not loaded', async () => {
    const { index } = await setup();
    // Only the Turtle file's text is available; the .owl file is not.
    const partial = (u: string) => (u.endsWith('.ttl') ? TTL : undefined);
    const r = computeRename(index, 'file:///ws/o.ttl', { line: 5, character: 4 }, 'Human', partial);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/not loaded/);
  });

  it('refuses to rename the `a` keyword', async () => {
    const { index, textOf } = await setup();
    // Line 5 `ex:Person a owl:Class .` - character 11 is the `a`.
    const p = prepareRename(index, 'file:///ws/o.ttl', { line: 5, character: 11 }, textOf);
    expect('error' in p).toBe(true);
    if ('error' in p) expect(p.error).toMatch(/rdf:type/);
  });

  it('rejects a new name containing characters invalid in an IRI', async () => {
    const { index, textOf } = await setup();
    const r = computeRename(index, 'file:///ws/o.ttl', { line: 5, character: 4 }, 'Not A Name', textOf);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not valid in an IRI/);
  });

  it('offers only the local name in the rename box', async () => {
    const { index, textOf } = await setup();
    const p = prepareRename(index, 'file:///ws/o.ttl', { line: 5, character: 4 }, textOf);
    expect('error' in p).toBe(false);
    if ('error' in p) return;
    expect(p.placeholder).toBe('Person');
    // The edited span excludes the `ex:` prefix.
    expect(p.range.start.character).toBe(3);
    expect(p.range.end.character).toBe(9);
  });
});

describe('definition and references', () => {
  it('jumps from a Turtle use into the RDF/XML definition', async () => {
    const { index } = await setup();
    // Line 6 references <http://example.org/Person>, defined via rdf:ID in the .owl.
    const defs = findDefinitions(index, 'file:///ws/o.ttl', { line: 6, character: 40 });
    expect(defs.some((d) => d.uri.endsWith('o.owl'))).toBe(true);
  });

  it('lists references across both files', async () => {
    const { index } = await setup();
    const refs = findReferences(index, 'file:///ws/o.ttl', { line: 5, character: 4 }, true);
    expect(refs.filter((r) => r.uri.endsWith('.ttl')).length).toBe(3);
    expect(refs.filter((r) => r.uri.endsWith('.owl')).length).toBe(2);
  });
});
