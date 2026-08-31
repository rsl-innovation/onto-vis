import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from '../../src/server/core/document.js';
import { detectFormat } from '../../src/server/core/formats.js';
import { WorkspaceIndex } from '../../src/server/core/workspaceIndex.js';
import { buildGraphModel } from '../../src/server/core/graphModel.js';
import { allDiagnostics } from '../../src/server/features/diagnostics.js';

const RETAIL = 'http://example.org/retail#';

async function loadWorkspace() {
  const index = new WorkspaceIndex();
  const files = ['retail.ttl', 'vendors.owl', 'instances.ttl'];
  const docs = [];
  for (const name of files) {
    const path = resolve(process.cwd(), 'test/fixtures/retail', name);
    const text = readFileSync(path, 'utf8');
    const uri = `file:///fixtures/retail/${name}`;
    const doc = await parseDocument(uri, text, detectFormat(uri, undefined, text));
    index.upsert(doc);
    docs.push(doc);
  }
  return { index, docs };
}

describe('retail fixture', () => {
  it('all three files parse without errors', async () => {
    const { docs } = await loadWorkspace();
    for (const doc of docs) {
      const errors = allDiagnostics(doc).filter((d) => d.severity === 1);
      expect(errors, `${doc.uri}: ${JSON.stringify(errors)}`).toEqual([]);
    }
  });

  it('CROSS-FORMAT: the RDF/XML vendor half links into the Turtle half', async () => {
    const { index } = await loadWorkspace();

    // Vendor is declared in vendors.owl but subclasses Organization from retail.ttl.
    expect(index.kind(`${RETAIL}Vendor`)).toBe('class');
    expect(index.info(`${RETAIL}Vendor`).superClasses.has(`${RETAIL}Organization`)).toBe(true);

    // Organization is defined in the .ttl and referenced from the .owl.
    const orgRefs = index.references(`${RETAIL}Organization`);
    expect(orgRefs.some((r) => r.uri.endsWith('retail.ttl'))).toBe(true);
    expect(orgRefs.some((r) => r.uri.endsWith('vendors.owl'))).toBe(true);

    // soldBy is declared in the .owl with a domain from the .ttl.
    expect(index.info(`${RETAIL}soldBy`).domains.has(`${RETAIL}Product`)).toBe(true);
  });

  it('instances reference schema terms from both files', async () => {
    const { index } = await loadWorkspace();
    // The sample vendor is typed with a class defined in RDF/XML.
    expect(index.info(`${RETAIL}vendor-soundwave`).types.has(`${RETAIL}Vendor`)).toBe(true);
    // …and carries a property defined in Turtle.
    const refs = index.references(`${RETAIL}partyName`);
    expect(refs.some((r) => r.uri.endsWith('instances.ttl'))).toBe(true);
    expect(refs.some((r) => r.uri.endsWith('retail.ttl'))).toBe(true);
  });

  it('builds a substantial but readable ontology graph', async () => {
    const { index } = await loadWorkspace();
    const model = buildGraphModel(index.allQuads(), index, [], {
      view: 'ontology',
      maxNodes: 2000,
      showIndividuals: false,
      prefixes: { retail: RETAIL, xsd: 'http://www.w3.org/2001/XMLSchema#' },
    });

    const classes = model.nodes.filter((n) => n.kind === 'class');
    expect(classes.length).toBeGreaterThanOrEqual(18);
    expect(classes.length).toBeLessThan(40); // rich, but still legible

    // Hierarchy, property edges and restrictions are all represented.
    expect(model.edges.filter((e) => e.kind === 'subClassOf').length).toBeGreaterThanOrEqual(6);
    expect(model.edges.filter((e) => e.kind === 'domainRange').length).toBeGreaterThanOrEqual(12);
    expect(model.edges.some((e) => e.kind === 'restriction')).toBe(true);
    expect(model.edges.some((e) => e.kind === 'disjoint')).toBe(true);

    // Datatype properties fold into their class as attribute rows.
    const sku = model.nodes.find((n) => n.id === `${RETAIL}SKU`)!;
    expect(sku.attributes?.map((a) => a.label)).toEqual(
      expect.arrayContaining(['sku code', 'list price', 'weight kg'])
    );

    // No stray blank nodes leak into the ontology view.
    expect(model.nodes.some((n) => n.kind === 'blank')).toBe(false);
  });

  it('shows individuals only when asked', async () => {
    const { index } = await loadWorkspace();
    const opts = {
      view: 'ontology' as const,
      maxNodes: 2000,
      prefixes: { retail: RETAIL },
    };
    const without = buildGraphModel(index.allQuads(), index, [], {
      ...opts,
      showIndividuals: false,
    });
    const with_ = buildGraphModel(index.allQuads(), index, [], { ...opts, showIndividuals: true });

    expect(without.nodes.some((n) => n.id === `${RETAIL}cust-1001`)).toBe(false);
    expect(with_.nodes.some((n) => n.id === `${RETAIL}cust-1001`)).toBe(true);
    expect(with_.nodes.length).toBeGreaterThan(without.nodes.length);
  });
});
