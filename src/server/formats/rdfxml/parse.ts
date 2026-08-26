import { RdfXmlParser } from 'rdfxml-streaming-parser';
import type { LineMap } from '../../core/text.js';
import type { Diagnostic, Range, RdfQuad, RdfTerm } from '../../core/types.js';

export interface RdfXmlParseResult {
  quads: RdfQuad[];
  diagnostics: Diagnostic[];
}

function toTerm(term: any): RdfTerm {
  const t: RdfTerm = { termType: term.termType, value: term.value };
  if (term.termType === 'Literal') {
    if (term.datatype?.value) t.datatype = term.datatype.value;
    if (term.language) t.language = term.language;
  }
  return t;
}

/** The parser prefixes messages with `line:column:` when it knows the location. */
function errorRange(message: string, lines: LineMap): Range {
  const m = /^(\d+):(\d+):/.exec(message);
  if (!m) return lines.rangeAt(0, 0);
  const line = Math.max(0, Number(m[1]) - 1);
  const character = Math.max(0, Number(m[2]) - 1);
  return { start: { line, character }, end: { line, character: character + 1 } };
}

/**
 * Parses RDF/XML into quads.
 *
 * The underlying parser is a Node stream, so this is asynchronous — unlike the
 * Turtle path. It keeps every quad emitted before an error, so a malformed tail
 * does not discard the whole document.
 */
export function parseRdfXml(
  text: string,
  lines: LineMap,
  baseIRI: string
): Promise<RdfXmlParseResult> {
  return new Promise((resolve) => {
    const quads: RdfQuad[] = [];
    const diagnostics: Diagnostic[] = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ quads, diagnostics });
    };

    let parser: any;
    try {
      parser = new RdfXmlParser({ baseIRI });
    } catch (err: any) {
      diagnostics.push({
        range: lines.rangeAt(0, 0),
        message: err?.message ?? 'Failed to create RDF/XML parser.',
        severity: 1,
        code: 'xml-syntax',
        source: 'rdf',
      });
      return finish();
    }

    parser.on('data', (q: any) => {
      quads.push({
        subject: toTerm(q.subject),
        predicate: toTerm(q.predicate),
        object: toTerm(q.object),
        ...(q.graph && q.graph.termType !== 'DefaultGraph' ? { graph: toTerm(q.graph) } : {}),
      });
    });

    parser.on('error', (err: any) => {
      const message: string = err?.message ?? 'Malformed RDF/XML.';
      // The scanner already reports unbound prefixes with a tighter range.
      if (!/unbound namespace prefix/i.test(message)) {
        diagnostics.push({
          range: errorRange(message, lines),
          message: message.replace(/^\d+:\d+:\s*/, '').trim(),
          severity: 1,
          code: 'rdfxml-syntax',
          source: 'rdf',
        });
      }
      finish();
    });

    parser.on('end', finish);

    try {
      parser.write(text);
      parser.end();
    } catch (err: any) {
      diagnostics.push({
        range: lines.rangeAt(0, 0),
        message: (err?.message ?? 'Malformed RDF/XML.').replace(/^\d+:\d+:\s*/, '').trim(),
        severity: 1,
        code: 'rdfxml-syntax',
        source: 'rdf',
      });
      finish();
    }
  });
}
