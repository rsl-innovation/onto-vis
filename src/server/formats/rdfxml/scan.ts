import { SaxesParser } from 'saxes';
import { LineMap, resolveIri } from '../../core/text.js';
import type {
  Diagnostic,
  PrefixDeclaration,
  Range,
  Spelling,
  TermOccurrence,
  TermRole,
} from '../../core/types.js';

const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDF_DESCRIPTION = `${RDF_NS}Description`;
const RDF_RDF = `${RDF_NS}RDF`;
const RDF_TYPE = `${RDF_NS}type`;

/** RDF attributes that carry an IRI rather than a literal. */
const IRI_ATTRS = new Set(['about', 'resource', 'ID', 'datatype', 'type', 'nodeID']);
/** RDF attributes that are structural rather than IRI-bearing. */
const STRUCTURAL_ATTRS = new Set(['parseType', 'li', 'about', 'resource', 'ID', 'datatype', 'nodeID']);

export interface RdfXmlScanResult {
  occurrences: TermOccurrence[];
  prefixDeclarations: PrefixDeclaration[];
  prefixes: Record<string, string>;
  base: string;
  diagnostics: Diagnostic[];
}

interface PendingAttr {
  name: string;
  prefix: string;
  local: string;
  uri: string;
  value: string;
  valueRange: Range;
  nameRange: Range;
}

interface PendingElement {
  name: string;
  nameRange: Range;
  attrs: PendingAttr[];
}

/**
 * Scans RDF/XML for source ranges.
 *
 * Mirrors the Turtle scanner: it produces `TermOccurrence`s only, leaving quads to
 * `rdfxml-streaming-parser`. saxes supplies correct namespace resolution and
 * document structure; positions are recovered from the raw text by scanning for
 * delimiters, because saxes' reported offsets are not consistent enough to index
 * with directly.
 */
export function scanRdfXml(text: string, documentBase: string): RdfXmlScanResult {
  const lines = new LineMap(text);
  const occurrences: TermOccurrence[] = [];
  const prefixDeclarations: PrefixDeclaration[] = [];
  const prefixes: Record<string, string> = {};
  const diagnostics: Diagnostic[] = [];

  /** xml:base is scoped to the element it appears on and its descendants. */
  const baseStack: string[] = [documentBase];
  /**
   * Namespace bindings in scope, innermost last.
   *
   * saxes resolves namespaces for *element* names but leaves `uri` undefined on
   * the `attribute` event, so attribute prefixes must be resolved here. Note that
   * an unprefixed attribute is in no namespace at all — the default xmlns never
   * applies to attributes.
   */
  const nsStack: Array<Record<string, string>> = [
    { xml: 'http://www.w3.org/XML/1998/namespace' },
  ];
  let documentBaseOut = documentBase;
  let stripeOffset: number | null = null;
  let depth = 0;
  let pending: PendingElement | null = null;

  const parser = new SaxesParser({ xmlns: true, position: true } as any);

  /**
   * Finds an attribute's value range by scanning back from the parser position to
   * the closing quote and then to its opener.
   *
   * Never derive this from `value.length`: entity references such as `&amp;` make
   * the raw source longer than the decoded value, which silently shifts the range.
   */
  const attrRanges = (pos: number, name: string): { value: Range; name: Range } | null => {
    let end = Math.min(pos, text.length - 1);
    while (end > 0 && text[end] !== '"' && text[end] !== "'") end--;
    const quote = text[end];
    if (quote !== '"' && quote !== "'") return null;
    let start = end - 1;
    while (start > 0 && text[start] !== quote) start--;
    if (text[start] !== quote) return null;

    // Walk back over `=` and surrounding whitespace to find the attribute name.
    let ne = start - 1;
    while (ne > 0 && /\s/.test(text[ne])) ne--;
    if (text[ne] === '=') ne--;
    while (ne > 0 && /\s/.test(text[ne])) ne--;
    const nameEnd = ne + 1;
    const nameStart = nameEnd - name.length;
    const nameRange =
      nameStart >= 0 && text.slice(nameStart, nameEnd) === name
        ? lines.rangeAt(nameStart, nameEnd)
        : lines.rangeAt(start + 1, end);

    return { value: lines.rangeAt(start + 1, end), name: nameRange };
  };

  /** Element names are located by scanning back to `<`, then verified against the text. */
  const elementNameRange = (pos: number, name: string): Range => {
    let lt = Math.min(pos, text.length - 1);
    while (lt > 0 && text[lt] !== '<') lt--;
    const nameStart = lt + 1;
    const nameEnd = nameStart + name.length;
    if (text.slice(nameStart, nameEnd) === name) return lines.rangeAt(nameStart, nameEnd);
    return lines.rangeAt(nameStart, Math.min(nameEnd, text.length));
  };

  const record = (
    iri: string,
    range: Range,
    role: TermRole,
    spelling: Spelling,
    isDefinition: boolean
  ) => {
    if (!iri) return;
    occurrences.push({ iri, range, role, spelling, isDefinition });
  };

  parser.on('opentagstart', (tag: any) => {
    pending = { name: tag.name, nameRange: elementNameRange(parser.position, tag.name), attrs: [] };
  });

  parser.on('attribute', (attr: any) => {
    if (!pending) return;
    const ranges = attrRanges(parser.position, attr.name);
    if (!ranges) return;
    pending.attrs.push({
      name: attr.name,
      prefix: attr.prefix ?? '',
      local: attr.local ?? attr.name,
      uri: attr.uri ?? '',
      value: attr.value,
      valueRange: ranges.value,
      nameRange: ranges.name,
    });
  });

  parser.on('opentag', (tag: any) => {
    const el = pending;
    pending = null;
    if (!el) return;

    // --- namespace declarations and xml:base, applied before anything else ---
    let elementBase = baseStack[baseStack.length - 1];
    const scope: Record<string, string> = { ...nsStack[nsStack.length - 1] };
    for (const a of el.attrs) {
      if (a.prefix === 'xmlns' || a.name === 'xmlns') {
        const label = a.prefix === 'xmlns' ? a.local : '';
        prefixes[label] = a.value;
        scope[label] = a.value;
        prefixDeclarations.push({
          prefix: label,
          namespace: a.value,
          range: a.nameRange,
          fullRange: a.nameRange,
        });
      } else if (a.name === 'xml:base') {
        elementBase = resolveIri(a.value, elementBase);
        if (depth === 0) documentBaseOut = elementBase;
      }
    }
    baseStack.push(elementBase);
    nsStack.push(scope);

    // Attributes carry no resolved namespace from saxes; resolve them here.
    for (const a of el.attrs) {
      a.uri = a.prefix ? (scope[a.prefix] ?? '') : '';
    }

    const elementIri = tag.uri ? `${tag.uri}${tag.local}` : '';

    // --- element striping: node element, then property element, alternating ---
    if (stripeOffset === null) stripeOffset = elementIri === RDF_RDF ? 1 : 0;
    const isNodeElement = (depth - stripeOffset) % 2 === 0 && depth >= stripeOffset;

    if (elementIri === RDF_RDF) {
      depth++;
      return;
    }

    if (tag.prefix && !tag.uri.startsWith('http') && tag.uri === tag.prefix) {
      diagnostics.push({
        range: el.nameRange,
        message: `Unbound namespace prefix \`${tag.prefix}:\`. Declare it with xmlns:${tag.prefix}="…".`,
        severity: 1,
        code: 'unbound-prefix',
        source: 'rdf',
      });
    }

    if (isNodeElement) {
      // A node element names the subject's class, unless it is rdf:Description.
      if (elementIri && elementIri !== RDF_DESCRIPTION) {
        record(elementIri, el.nameRange, 'object', 'qname', false);
      }
    } else if (elementIri) {
      record(elementIri, el.nameRange, 'predicate', 'qname', false);
    }

    // --- IRI-bearing attributes -------------------------------------------
    for (const a of el.attrs) {
      if (a.prefix === 'xmlns' || a.name === 'xmlns' || a.name === 'xml:base') continue;

      const isRdfAttr = a.uri === RDF_NS;
      if (isRdfAttr && IRI_ATTRS.has(a.local)) {
        switch (a.local) {
          case 'about':
            record(resolveIri(a.value, elementBase), a.valueRange, 'subject', 'attrIri', true);
            break;
          case 'ID':
            record(resolveIri(`#${a.value}`, elementBase), a.valueRange, 'subject', 'rdfID', true);
            break;
          case 'resource':
            record(resolveIri(a.value, elementBase), a.valueRange, 'object', 'attrIri', false);
            break;
          case 'datatype':
            record(resolveIri(a.value, elementBase), a.valueRange, 'datatype', 'attrIri', false);
            break;
          case 'type':
            record(resolveIri(a.value, elementBase), a.valueRange, 'object', 'attrIri', false);
            break;
          case 'nodeID':
            record(`_:${a.value}`, a.valueRange, isNodeElement ? 'subject' : 'object', 'blankLabel', false);
            break;
          default:
            break;
        }
        continue;
      }

      // A namespaced non-RDF attribute is a property with a literal value, so its
      // *name* is a predicate IRI worth navigating.
      if (a.uri && a.uri !== RDF_NS && !STRUCTURAL_ATTRS.has(a.local)) {
        record(`${a.uri}${a.local}`, a.nameRange, 'predicate', 'qname', false);
      }
    }

    depth++;
  });

  parser.on('closetag', () => {
    depth = Math.max(0, depth - 1);
    if (baseStack.length > 1) baseStack.pop();
    if (nsStack.length > 1) nsStack.pop();
  });

  parser.on('error', (err: any) => {
    diagnostics.push({
      range: xmlErrorRange(err?.message ?? '', lines),
      message: stripPositionPrefix(err?.message ?? 'Malformed XML.'),
      severity: 1,
      code: 'xml-syntax',
      source: 'rdf',
    });
  });

  try {
    parser.write(text).close();
  } catch (err: any) {
    diagnostics.push({
      range: lines.rangeAt(0, 0),
      message: stripPositionPrefix(err?.message ?? 'Failed to scan document.'),
      severity: 1,
      code: 'xml-syntax',
      source: 'rdf',
    });
  }

  if (prefixes.rdf === undefined) prefixes.rdf = RDF_NS;

  return {
    occurrences,
    prefixDeclarations,
    prefixes,
    base: documentBaseOut,
    diagnostics,
  };
}

/** saxes prefixes messages with `line:column:`; turn that into a range. */
function xmlErrorRange(message: string, lines: LineMap): Range {
  const m = /^(\d+):(\d+):/.exec(message);
  if (!m) return lines.rangeAt(0, 0);
  const line = Math.max(0, Number(m[1]) - 1);
  const col = Math.max(0, Number(m[2]) - 1);
  return { start: { line, character: col }, end: { line, character: col + 1 } };
}

function stripPositionPrefix(message: string): string {
  return message.replace(/^\d+:\d+:\s*/, '').trim();
}

export { RDF_TYPE, RDF_NS };
