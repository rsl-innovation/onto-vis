import { localName, splitIri } from '../core/text.js';
import {
  WELL_KNOWN_PREFIXES,
  conventionalPrefixFor,
  lookupVocabTerm,
  vocabTermsInNamespace,
} from '../core/vocab.js';
import type { TermKind } from '../core/vocab.js';
import type { WorkspaceIndex } from '../core/workspaceIndex.js';
import type { ParsedDocument, Position, Range } from '../core/types.js';
import { isTurtleFamily } from '../core/types.js';

/** Mirrors LSP's CompletionItemKind. */
const ItemKind = {
  Class: 7,
  Property: 10,
  Field: 5,
  Module: 9,
  Keyword: 14,
  Constant: 21,
  TypeParameter: 25,
} as const;

const KIND_TO_ITEM: Record<TermKind, number> = {
  class: ItemKind.Class,
  objectProperty: ItemKind.Property,
  datatypeProperty: ItemKind.Field,
  annotationProperty: ItemKind.Field,
  property: ItemKind.Property,
  individual: ItemKind.Constant,
  datatype: ItemKind.TypeParameter,
  ontology: ItemKind.Module,
  unknown: ItemKind.Constant,
};

export interface CompletionItem {
  label: string;
  kind: number;
  detail?: string;
  documentation?: string;
  sortText?: string;
  textEdit?: { range: Range; newText: string };
  additionalTextEdits?: Array<{ range: Range; newText: string }>;
}

const TURTLE_KEYWORDS = [
  { label: '@prefix', detail: 'Declare a namespace prefix' },
  { label: '@base', detail: 'Set the base IRI for relative references' },
  { label: 'a', detail: 'Abbreviation for rdf:type' },
  { label: 'true', detail: 'Boolean literal' },
  { label: 'false', detail: 'Boolean literal' },
];

export function complete(
  index: WorkspaceIndex,
  doc: ParsedDocument,
  text: string,
  position: Position
): CompletionItem[] {
  const line = lineAt(text, position.line);
  const before = line.slice(0, position.character);

  return isTurtleFamily(doc.format)
    ? completeTurtle(index, doc, before, position)
    : completeRdfXml(index, doc, before, position);
}

function completeTurtle(
  index: WorkspaceIndex,
  doc: ParsedDocument,
  before: string,
  position: Position
): CompletionItem[] {
  // Case 1: the cursor is inside a prefixed name, e.g. `rdfs:sub|`.
  const pname = /(^|[\s;,.[(])([A-Za-z][-\w.]*)?:([-\w.%]*)$/.exec(before);
  if (pname) {
    const prefix = pname[2] ?? '';
    const partial = pname[3] ?? '';
    const start = position.character - partial.length;
    const replace: Range = {
      start: { line: position.line, character: start },
      end: { line: position.line, character: position.character },
    };
    return completeTermsForPrefix(index, doc, prefix, replace);
  }

  // Case 2: a bare word — offer prefixes and keywords.
  const word = /(^|[\s;,.[(])([A-Za-z@][-\w.]*)?$/.exec(before);
  if (word) {
    const partial = word[2] ?? '';
    const replace: Range = {
      start: { line: position.line, character: position.character - partial.length },
      end: { line: position.line, character: position.character },
    };
    const items: CompletionItem[] = [];

    for (const [prefix, ns] of declaredAndWellKnown(doc)) {
      items.push({
        label: `${prefix}:`,
        kind: ItemKind.Module,
        detail: ns,
        sortText: doc.prefixes[prefix] ? `0${prefix}` : `1${prefix}`,
        textEdit: { range: replace, newText: `${prefix}:` },
        ...(doc.prefixes[prefix] ? {} : { additionalTextEdits: [prefixInsertion(doc, prefix, ns)] }),
      });
    }

    for (const kw of TURTLE_KEYWORDS) {
      items.push({
        label: kw.label,
        kind: ItemKind.Keyword,
        detail: kw.detail,
        sortText: `2${kw.label}`,
        textEdit: { range: replace, newText: kw.label },
      });
    }
    return items;
  }

  return [];
}

/** Terms available under a prefix, whether or not the prefix is declared yet. */
function completeTermsForPrefix(
  index: WorkspaceIndex,
  doc: ParsedDocument,
  prefix: string,
  replace: Range
): CompletionItem[] {
  const declared = doc.prefixes[prefix];
  const namespace = declared ?? WELL_KNOWN_PREFIXES[prefix];
  if (!namespace) return [];

  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  // Terms the workspace itself defines come first — they are what the user is
  // most likely reaching for in their own ontology.
  for (const iri of index.iris()) {
    if (!iri.startsWith(namespace)) continue;
    const local = iri.slice(namespace.length);
    if (!local || local.includes('/') || seen.has(local)) continue;
    seen.add(local);
    const item: CompletionItem = {
      label: local,
      kind: KIND_TO_ITEM[index.kind(iri)],
      detail: index.label(iri) ?? iri,
      sortText: `0${local}`,
      textEdit: { range: replace, newText: local },
    };
    const doc_ = index.comment(iri);
    if (doc_) item.documentation = doc_;
    items.push(item);
  }

  for (const term of vocabTermsInNamespace(namespace)) {
    const local = localName(term.iri);
    if (seen.has(local)) continue;
    seen.add(local);
    items.push({
      label: local,
      kind: KIND_TO_ITEM[term.kind],
      detail: term.iri,
      documentation: term.comment,
      sortText: `1${local}`,
      textEdit: { range: replace, newText: local },
    });
  }

  // Completing a term from an undeclared vocabulary should also declare it,
  // rather than leaving behind an undefined-prefix error.
  if (!declared) {
    const insertion = prefixInsertion(doc, prefix, namespace);
    for (const item of items) item.additionalTextEdits = [insertion];
  }

  return items;
}

function completeRdfXml(
  index: WorkspaceIndex,
  doc: ParsedDocument,
  before: string,
  position: Position
): CompletionItem[] {
  // Inside an IRI-bearing attribute value: offer terms from the workspace.
  const attr = /\b(rdf:(?:about|resource|datatype|type))\s*=\s*(["'])([^"']*)$/.exec(before);
  if (attr) {
    const partial = attr[3];
    const replace: Range = {
      start: { line: position.line, character: position.character - partial.length },
      end: { line: position.line, character: position.character },
    };
    const items: CompletionItem[] = [];
    for (const iri of index.iris()) {
      const local = localName(iri);
      if (!local) continue;
      const item: CompletionItem = {
        label: `#${local}`,
        kind: KIND_TO_ITEM[index.kind(iri)],
        detail: iri,
        textEdit: { range: replace, newText: `#${local}` },
      };
      const comment = index.comment(iri);
      if (comment) item.documentation = comment;
      items.push(item);
      if (items.length >= 300) break;
    }
    return items;
  }

  // Element QNames: `<owl:Cl|` or `<rdfs:|`.
  const element = /<\/?([A-Za-z][-\w.]*)?:?([-\w.]*)$/.exec(before);
  if (element) {
    const prefix = element[1];
    const partial = element[2] ?? '';
    const start = position.character - partial.length;
    const replace: Range = {
      start: { line: position.line, character: start },
      end: { line: position.line, character: position.character },
    };
    if (prefix && doc.prefixes[prefix]) {
      const namespace = doc.prefixes[prefix];
      return vocabTermsInNamespace(namespace).map((t) => ({
        label: localName(t.iri),
        kind: KIND_TO_ITEM[t.kind],
        detail: t.iri,
        documentation: t.comment,
        textEdit: { range: replace, newText: localName(t.iri) },
      }));
    }
    return Object.entries(doc.prefixes).map(([p, ns]) => ({
      label: `${p}:`,
      kind: ItemKind.Module,
      detail: ns,
      textEdit: { range: replace, newText: `${p}:` },
    }));
  }

  return [];
}

/** Declared prefixes first, then well-known ones the document has not declared. */
function declaredAndWellKnown(doc: ParsedDocument): Array<[string, string]> {
  const out = new Map<string, string>(Object.entries(doc.prefixes));
  for (const [prefix, ns] of Object.entries(WELL_KNOWN_PREFIXES)) {
    if (!out.has(prefix)) out.set(prefix, ns);
  }
  return [...out.entries()];
}

/**
 * A text edit adding a `@prefix` line, placed after the existing prefix block so
 * declarations stay together.
 */
function prefixInsertion(
  doc: ParsedDocument,
  prefix: string,
  namespace: string
): { range: Range; newText: string } {
  const label = conventionalPrefixFor(namespace) ?? prefix;
  const last = doc.prefixDeclarations[doc.prefixDeclarations.length - 1];
  const line = last ? last.fullRange.end.line + 1 : 0;
  const at: Range = {
    start: { line, character: 0 },
    end: { line, character: 0 },
  };
  return { range: at, newText: `@prefix ${label}: <${namespace}> .\n` };
}

export function documentationFor(iri: string): string | undefined {
  return lookupVocabTerm(iri)?.comment ?? splitIri(iri).local;
}

function lineAt(text: string, line: number): string {
  return text.split(/\r\n|\r|\n/)[line] ?? '';
}
