import { localName } from '../core/text.js';
import type { WorkspaceIndex } from '../core/workspaceIndex.js';
import type { ParsedDocument, Range } from '../core/types.js';
import type { TermKind } from '../core/vocab.js';

/** Matches LSP's SymbolKind numbering. */
export const SymbolKind = {
  Class: 5,
  Property: 7,
  Field: 8,
  Constant: 14,
  Namespace: 3,
  Variable: 13,
} as const;

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface WorkspaceSymbol {
  name: string;
  containerName?: string;
  kind: number;
  location: { uri: string; range: Range };
}

const GROUPS: Array<{ title: string; kinds: TermKind[]; symbolKind: number }> = [
  { title: 'Classes', kinds: ['class'], symbolKind: SymbolKind.Class },
  { title: 'Object Properties', kinds: ['objectProperty'], symbolKind: SymbolKind.Property },
  { title: 'Datatype Properties', kinds: ['datatypeProperty'], symbolKind: SymbolKind.Field },
  { title: 'Annotation Properties', kinds: ['annotationProperty'], symbolKind: SymbolKind.Field },
  { title: 'Individuals', kinds: ['individual'], symbolKind: SymbolKind.Constant },
  { title: 'Other', kinds: ['property', 'datatype', 'ontology', 'unknown'], symbolKind: SymbolKind.Variable },
];

/**
 * The outline for one document, grouped by what each term *is* rather than by
 * where it appears — an ontology's shape is its classes and properties, not its
 * statement order.
 */
export function documentSymbols(index: WorkspaceIndex, doc: ParsedDocument): DocumentSymbol[] {
  const defined = new Map<string, Range>();
  for (const occ of doc.occurrences) {
    if (!occ.isDefinition || occ.iri.startsWith('_:')) continue;
    if (!defined.has(occ.iri)) defined.set(occ.iri, occ.range);
  }

  const buckets = new Map<string, DocumentSymbol[]>();
  for (const [iri, range] of defined) {
    const kind = index.kind(iri);
    const group = GROUPS.find((g) => g.kinds.includes(kind)) ?? GROUPS[GROUPS.length - 1];
    const symbol: DocumentSymbol = {
      name: index.label(iri) ?? localName(iri),
      kind: group.symbolKind,
      range,
      selectionRange: range,
    };
    const detail = index.comment(iri);
    if (detail) symbol.detail = firstSentence(detail);
    const list = buckets.get(group.title);
    if (list) list.push(symbol);
    else buckets.set(group.title, [symbol]);
  }

  const out: DocumentSymbol[] = [];

  if (doc.prefixDeclarations.length > 0) {
    out.push({
      name: 'Prefixes',
      kind: SymbolKind.Namespace,
      range: doc.prefixDeclarations[0].fullRange,
      selectionRange: doc.prefixDeclarations[0].range,
      children: doc.prefixDeclarations.map((d) => ({
        name: `${d.prefix}:`,
        detail: d.namespace,
        kind: SymbolKind.Namespace,
        range: d.fullRange,
        selectionRange: d.range,
      })),
    });
  }

  for (const group of GROUPS) {
    const children = buckets.get(group.title);
    if (!children || children.length === 0) continue;
    children.sort((a, b) => a.name.localeCompare(b.name));
    out.push({
      name: group.title,
      detail: `${children.length}`,
      kind: group.symbolKind,
      range: children[0].range,
      selectionRange: children[0].selectionRange,
      children,
    });
  }

  return out;
}

/** Fuzzy-ish search over every indexed term, for Ctrl+T. */
export function workspaceSymbols(index: WorkspaceIndex, query: string, limit = 200): WorkspaceSymbol[] {
  const needle = query.trim().toLowerCase();
  const out: WorkspaceSymbol[] = [];

  for (const iri of index.iris()) {
    const local = localName(iri);
    const label = index.label(iri);
    const haystack = `${local} ${label ?? ''}`.toLowerCase();
    if (needle && !haystack.includes(needle)) continue;

    const location = index.primaryLocation(iri);
    if (!location) continue;

    const kind = index.kind(iri);
    const group = GROUPS.find((g) => g.kinds.includes(kind)) ?? GROUPS[GROUPS.length - 1];
    out.push({
      name: label ?? local,
      containerName: location.uri.split('/').pop(),
      kind: group.symbolKind,
      location,
    });
    if (out.length >= limit) break;
  }

  return out;
}

function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const stop = clean.indexOf('. ');
  const cut = stop > 0 ? clean.slice(0, stop + 1) : clean;
  return cut.length > 100 ? `${cut.slice(0, 97)}…` : cut;
}
