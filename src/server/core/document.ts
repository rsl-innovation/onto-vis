import { LineMap } from './text.js';
import { isTurtleFamily } from './types.js';
import type { ParsedDocument, RdfFormat } from './types.js';
import { scanTurtle } from '../formats/turtle/scan.js';
import { parseTurtle } from '../formats/turtle/parse.js';
import { scanRdfXml } from '../formats/rdfxml/scan.js';
import { parseRdfXml } from '../formats/rdfxml/parse.js';

/**
 * Scans and parses one document into the format-agnostic `ParsedDocument`.
 *
 * Each format contributes two independent passes joined on the resolved IRI: a
 * scanner for source ranges and a parser for quads. Everything downstream — the
 * index, every LSP feature, the graph preview — reads only the result of this
 * function and never touches a format-specific API.
 */
export async function parseDocument(
  uri: string,
  text: string,
  format: RdfFormat
): Promise<ParsedDocument> {
  const lines = new LineMap(text);
  const base = baseFromUri(uri);

  if (isTurtleFamily(format)) {
    const scanned = scanTurtle(text, base);
    const parsed = parseTurtle(text, scanned.tokens, lines, scanned.base || base, format);
    return {
      uri,
      format,
      quads: parsed.quads,
      prefixes: scanned.prefixes,
      prefixDeclarations: scanned.prefixDeclarations,
      base: scanned.base || base,
      occurrences: scanned.occurrences,
      diagnostics: [...scanned.diagnostics, ...parsed.diagnostics],
    };
  }

  const scanned = scanRdfXml(text, base);
  const parsed = await parseRdfXml(text, lines, scanned.base || base);
  return {
    uri,
    format,
    quads: parsed.quads,
    prefixes: scanned.prefixes,
    prefixDeclarations: scanned.prefixDeclarations,
    base: scanned.base || base,
    occurrences: scanned.occurrences,
    diagnostics: [...scanned.diagnostics, ...parsed.diagnostics],
  };
}

/** A document's own URI is its default base, per RDF's resolution rules. */
function baseFromUri(uri: string): string {
  try {
    const url = new URL(uri);
    return url.href;
  } catch {
    return uri;
  }
}

export { LineMap };
