import { describe, expect, it } from 'vitest';
import { buildGraphModel } from '../../src/server/core/graphModel.js';
import { WorkspaceIndex } from '../../src/server/core/workspaceIndex.js';
import { parseDocument } from '../../src/server/core/document.js';

const PREFIXES = {
  ex: 'http://example.org/',
  owl: 'http://www.w3.org/2002/07/owl#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
};

const ONTOLOGY = [
  '@prefix ex: <http://example.org/> .',
  '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
  '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
  '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
  '',
  'ex:Agent a owl:Class .',
  'ex:Person a owl:Class ; rdfs:subClassOf ex:Agent ; rdfs:label "Person" .',
  'ex:Organization a owl:Class ; rdfs:subClassOf ex:Agent .',
  '',
  'ex:worksFor a owl:ObjectProperty ;',
  '    rdfs:domain ex:Person ; rdfs:range ex:Organization .',
  'ex:name a owl:DatatypeProperty ;',
  '    rdfs:domain ex:Person ; rdfs:range xsd:string .',
  '',
  'ex:alice a ex:Person .',
].join('\n');

async function model(text: string, opts: Partial<Parameters<typeof buildGraphModel>[3]> = {}) {
  const doc = await parseDocument('file:///ws/o.ttl', text, 'turtle');
  const index = new WorkspaceIndex();
  index.upsert(doc);
  return buildGraphModel(doc.quads, index, [doc.uri], {
    view: 'ontology',
    maxNodes: 2000,
    showIndividuals: false,
    prefixes: PREFIXES,
    ...opts,
  });
}

describe('ontology view', () => {
  it('renders classes as nodes and subClassOf as edges', async () => {
    const g = await model(ONTOLOGY);
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain('http://example.org/Person');
    expect(ids).toContain('http://example.org/Agent');

    const sub = g.edges.filter((e) => e.kind === 'subClassOf');
    expect(sub).toHaveLength(2);
    expect(sub[0].label).toBe('subClassOf');
  });

  it('turns an object property into a domain to range edge', async () => {
    const g = await model(ONTOLOGY);
    const edge = g.edges.find((e) => e.kind === 'domainRange')!;
    expect(edge.source).toBe('http://example.org/Person');
    expect(edge.target).toBe('http://example.org/Organization');
    expect(edge.label).toBe('worksFor');
  });

  it('folds a datatype property into an attribute row on its domain class', async () => {
    const g = await model(ONTOLOGY);
    const person = g.nodes.find((n) => n.id === 'http://example.org/Person')!;
    expect(person.attributes).toBeDefined();
    expect(person.attributes![0]).toMatchObject({ label: 'name', datatype: 'string' });
    // It must not also appear as a standalone node.
    expect(g.nodes.some((n) => n.id === 'http://example.org/name')).toBe(false);
  });

  it('hides individuals by default and shows them on request', async () => {
    const without = await model(ONTOLOGY);
    expect(without.nodes.some((n) => n.id === 'http://example.org/alice')).toBe(false);

    const with_ = await model(ONTOLOGY, { showIndividuals: true });
    const alice = with_.nodes.find((n) => n.id === 'http://example.org/alice')!;
    expect(alice.kind).toBe('individual');
    expect(with_.edges.some((e) => e.kind === 'type' && e.source === alice.id)).toBe(true);
  });

  it('uses rdfs:label for the node label and exposes a curie', async () => {
    const g = await model(ONTOLOGY);
    const person = g.nodes.find((n) => n.id === 'http://example.org/Person')!;
    expect(person.label).toBe('Person');
    expect(person.curie).toBe('ex:Person');
  });

  it('renders an owl:Restriction as an annotated edge, not a blank node', async () => {
    const text = [
      '@prefix ex: <http://example.org/> .',
      '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
      '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
      'ex:Person a owl:Class ;',
      '    rdfs:subClassOf [ a owl:Restriction ;',
      '        owl:onProperty ex:hasParent ;',
      '        owl:allValuesFrom ex:Person ] .',
    ].join('\n');
    const g = await model(text);
    expect(g.nodes.some((n) => n.kind === 'blank')).toBe(false);
    const r = g.edges.find((e) => e.kind === 'restriction')!;
    expect(r.label).toBe('hasParent only');
    expect(r.source).toBe('http://example.org/Person');
    expect(r.target).toBe('http://example.org/Person');
  });

  it('extracts ontology header metadata', async () => {
    const text = [
      '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
      '<http://example.org/> a owl:Ontology ;',
      '    owl:versionInfo "1.2.0" ;',
      '    owl:imports <http://xmlns.com/foaf/0.1/> .',
    ].join('\n');
    const g = await model(text);
    expect(g.ontology?.versionInfo).toBe('1.2.0');
    expect(g.ontology?.imports).toContain('http://xmlns.com/foaf/0.1/');
  });
});

describe('triples view', () => {
  it('renders every subject and object as a node, literals included', async () => {
    const g = await model(ONTOLOGY, { view: 'triples' });
    expect(g.view).toBe('triples');
    expect(g.nodes.some((n) => n.kind === 'literal')).toBe(true);
    const literal = g.nodes.find((n) => n.kind === 'literal')!;
    expect(literal.label).toContain('Person');
  });

  it('keeps distinct literals with the same lexical form separate from IRIs', async () => {
    const g = await model(ONTOLOGY, { view: 'triples' });
    const person = g.nodes.find((n) => n.id === 'http://example.org/Person');
    const literal = g.nodes.find((n) => n.kind === 'literal' && n.label.includes('Person'));
    expect(person).toBeDefined();
    expect(literal).toBeDefined();
    expect(person!.id).not.toBe(literal!.id);
  });
});

describe('truncation', () => {
  it('reports what it dropped rather than silently showing a partial graph', async () => {
    const lines = ['@prefix ex: <http://example.org/> .', '@prefix owl: <http://www.w3.org/2002/07/owl#> .'];
    for (let i = 0; i < 50; i++) lines.push(`ex:C${i} a owl:Class .`);
    const g = await model(lines.join('\n'), { maxNodes: 10 });
    expect(g.nodes).toHaveLength(10);
    expect(g.truncated).toEqual({ shown: 10, total: 50 });
  });

  it('leaves truncated undefined when everything fits', async () => {
    const g = await model(ONTOLOGY);
    expect(g.truncated).toBeUndefined();
  });
});
