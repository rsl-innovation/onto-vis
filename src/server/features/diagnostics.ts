import type { Diagnostic, ParsedDocument } from '../core/types.js';

const SEVERITY_HINT = 4;
const SEVERITY_WARNING = 2;

/**
 * Checks that need the whole document, layered on top of the per-token errors the
 * scanner and parser already produce.
 */
export function extraDiagnostics(doc: ParsedDocument): Diagnostic[] {
  const out: Diagnostic[] = [];

  const usedNamespaces = new Set<string>();
  for (const occ of doc.occurrences) {
    for (const [, ns] of Object.entries(doc.prefixes)) {
      if (occ.iri.startsWith(ns)) usedNamespaces.add(ns);
    }
  }

  const seen = new Map<string, number>();
  for (const decl of doc.prefixDeclarations) {
    // Duplicate declaration: the later one silently wins, which is easy to miss.
    const previous = seen.get(decl.prefix);
    if (previous !== undefined) {
      out.push({
        range: decl.range,
        message: `Prefix \`${decl.prefix}:\` is declared more than once. The last declaration wins.`,
        severity: SEVERITY_WARNING,
        code: 'duplicate-prefix',
        source: 'rdf',
      });
    }
    seen.set(decl.prefix, 1);

    if (!usedNamespaces.has(decl.namespace)) {
      out.push({
        range: decl.range,
        message: `Prefix \`${decl.prefix}:\` is declared but never used.`,
        severity: SEVERITY_HINT,
        code: 'unused-prefix',
        source: 'rdf',
      });
    }
  }

  return out;
}

/** Everything wrong with a document, in one list. */
export function allDiagnostics(doc: ParsedDocument): Diagnostic[] {
  return [...doc.diagnostics, ...extraDiagnostics(doc)];
}
