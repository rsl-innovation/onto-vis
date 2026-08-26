import type { RdfFormat } from './types.js';

const BY_LANGUAGE_ID: Record<string, RdfFormat> = {
  turtle: 'turtle',
  ntriples: 'ntriples',
  nquads: 'nquads',
  trig: 'trig',
  n3: 'n3',
  rdfxml: 'rdfxml',
};

const BY_EXTENSION: Record<string, RdfFormat> = {
  ttl: 'turtle',
  turtle: 'turtle',
  nt: 'ntriples',
  nq: 'nquads',
  trig: 'trig',
  n3: 'n3',
  rdf: 'rdfxml',
  rdfs: 'rdfxml',
  owl: 'rdfxml',
};

export const RDF_EXTENSIONS = Object.keys(BY_EXTENSION);

export function extensionOf(uriOrPath: string): string {
  const clean = uriOrPath.split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  return dot < 0 ? '' : clean.slice(dot + 1).toLowerCase();
}

export function isRdfFile(uriOrPath: string): boolean {
  return extensionOf(uriOrPath) in BY_EXTENSION;
}

/**
 * Decides which format a document is in.
 *
 * `.owl` is genuinely ambiguous — Protégé writes RDF/XML by default but can also
 * write Turtle — so the file's own content decides rather than its extension. The
 * first meaningful character is `<` for XML and almost never for Turtle, whose
 * documents open with a comment, a directive, or a term.
 */
export function detectFormat(
  uriOrPath: string,
  languageId: string | undefined,
  text: string | undefined
): RdfFormat {
  const ext = extensionOf(uriOrPath);

  if (ext === 'owl' || ext === 'rdf' || ext === 'rdfs') {
    if (text !== undefined) return sniffXmlOrTurtle(text);
    return 'rdfxml';
  }

  if (languageId && BY_LANGUAGE_ID[languageId]) return BY_LANGUAGE_ID[languageId];
  if (BY_EXTENSION[ext]) return BY_EXTENSION[ext];
  if (text !== undefined) return sniffXmlOrTurtle(text);
  return 'turtle';
}

function sniffXmlOrTurtle(text: string): RdfFormat {
  // Skip a byte-order mark, whitespace, and Turtle comments to reach real content.
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '#') {
      const nl = text.indexOf('\n', i);
      if (nl < 0) return 'turtle';
      i = nl + 1;
      continue;
    }
    break;
  }
  const rest = text.slice(i);
  // An XML element name is followed by whitespace, `>` or `/>`. A Turtle or
  // N-Triples document may also open with `<`, but only as an IRI — and
  // `<http://example.org/A>` has `:` after the name, never a tag delimiter.
  const XML_START = /^<(\?xml[\s?]|!DOCTYPE\s|!--|[A-Za-z_][-\w.]*(?::[A-Za-z_][-\w.]*)?(?:\s|\/?>))/;
  return XML_START.test(rest) ? 'rdfxml' : 'turtle';
}
