import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from '../../src/server/core/document.js';
import { detectFormat } from '../../src/server/core/formats.js';
import { WorkspaceIndex } from '../../src/server/core/workspaceIndex.js';
import { buildGraphModel } from '../../src/server/core/graphModel.js';
import { allDiagnostics } from '../../src/server/features/diagnostics.js';

function load(relative: string) {
  const path = resolve(process.cwd(), 'test/fixtures', relative);
  const text = readFileSync(path, 'utf8');
  const uri = `file:///fixtures/${relative}`;
  return { uri, text, format: detectFormat(uri, undefined, text) };
}

describe('fixtures', () => {
  it('parses the example Turtle ontology cleanly', async () => {
    const { uri, text, format } = load('turtle/ontology.ttl');
    expect(format).toBe('turtle');
    const doc = await parseDocument(uri, text, format);
    const errors = allDiagnostics(doc).filter((d) => d.severity === 1);
    expect(errors).toEqual([]);
    expect(doc.quads.length).toBeGreaterThan(20);
  });

  it('reports every error in the broken fixture, not just the first', async () => {
    const { uri, text, format } = load('turtle/broken.ttl');
    const doc = await parseDocument(uri, text, format);
    const errors = allDiagnostics(doc).filter((d) => d.severity === 1);
    expect(errors.length).toBeGreaterThanOrEqual(3);

    // Errors are spread across the file rather than clustered on one line.
    const lines = new Set(errors.map((e) => e.range.start.line));
    expect(lines.size).toBeGreaterThanOrEqual(3);

    // And the valid statements still parsed.
    expect(doc.quads.some((q) => q.subject.value.endsWith('Good'))).toBe(true);
    expect(doc.quads.some((q) => q.subject.value.endsWith('Fourth'))).toBe(true);
  });

  it('detects a .owl file that is really Turtle', async () => {
    const { uri, text, format } = load('rdfxml/turtle-disguised-as.owl');
    expect(format).toBe('turtle');
    const doc = await parseDocument(uri, text, format);
    expect(allDiagnostics(doc).filter((d) => d.severity === 1)).toEqual([]);
    expect(doc.quads.some((q) => q.subject.value.endsWith('Car'))).toBe(true);
  });

  it('renders equivalent graphs from the Turtle and RDF/XML ontologies', async () => {
    const ttl = load('turtle/ontology.ttl');
    const owl = load('rdfxml/ontology.owl');
    expect(owl.format).toBe('rdfxml');

    const ttlDoc = await parseDocument(ttl.uri, ttl.text, ttl.format);
    const owlDoc = await parseDocument(owl.uri, owl.text, owl.format);
    expect(allDiagnostics(owlDoc).filter((d) => d.severity === 1)).toEqual([]);

    const graphOf = async (doc: typeof ttlDoc) => {
      const index = new WorkspaceIndex();
      index.upsert(doc);
      return buildGraphModel(doc.quads, index, [doc.uri], {
        view: 'ontology',
        maxNodes: 2000,
        showIndividuals: false,
        prefixes: doc.prefixes,
      });
    };

    const a = await graphOf(ttlDoc);
    const b = await graphOf(owlDoc);

    // The RDF/XML file is a subset (no individuals or restrictions), but every
    // class and property relationship it does express must match.
    const classes = (g: typeof a) =>
      g.nodes.filter((n) => n.kind === 'class').map((n) => n.id).sort();
    expect(classes(b)).toEqual(
      expect.arrayContaining([
        'http://example.org/Agent',
        'http://example.org/Person',
        'http://example.org/Organization',
      ])
    );
    expect(classes(a)).toEqual(expect.arrayContaining(classes(b)));

    const subClassEdges = (g: typeof a) =>
      g.edges.filter((e) => e.kind === 'subClassOf').map((e) => `${e.source}->${e.target}`).sort();
    expect(subClassEdges(a)).toEqual(expect.arrayContaining(subClassEdges(b)));
  });
});

describe('performance budget', () => {
  /** A synthetic ontology roughly the size of a real mid-sized vocabulary. */
  function largeOntology(classes: number): string {
    const lines = [
      '@prefix ex: <http://example.org/> .',
      '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
      '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
      '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    ];
    for (let i = 0; i < classes; i++) {
      lines.push(
        `ex:C${i} a owl:Class ;`,
        `    rdfs:label "Class ${i}" ;`,
        `    rdfs:comment "Description of class ${i}." ;`,
        `    rdfs:subClassOf ex:C${Math.max(0, i - 1)} .`,
        `ex:p${i} a owl:ObjectProperty ; rdfs:domain ex:C${i} ; rdfs:range ex:C${Math.max(0, i - 1)} .`
      );
    }
    return lines.join('\n');
  }

  it('parses and indexes ~5k triples in under 500 ms', async () => {
    const text = largeOntology(700);
    const started = performance.now();
    const doc = await parseDocument('file:///big.ttl', text, 'turtle');
    const index = new WorkspaceIndex();
    index.upsert(doc);
    const elapsed = performance.now() - started;

    expect(doc.quads.length).toBeGreaterThan(4500);
    expect(elapsed).toBeLessThan(500);
  });

  it('builds a graph model for a large ontology in under 500 ms', async () => {
    const doc = await parseDocument('file:///big.ttl', largeOntology(700), 'turtle');
    const index = new WorkspaceIndex();
    index.upsert(doc);

    const started = performance.now();
    const model = buildGraphModel(doc.quads, index, [doc.uri], {
      view: 'ontology',
      maxNodes: 2000,
      showIndividuals: false,
      prefixes: doc.prefixes,
    });
    const elapsed = performance.now() - started;

    expect(model.nodes.length).toBeGreaterThan(500);
    expect(elapsed).toBeLessThan(500);
  });
});
