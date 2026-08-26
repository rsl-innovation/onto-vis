import type { WorkspaceIndex } from '../core/workspaceIndex.js';
import type { ParsedDocument } from '../core/types.js';
import type { TermKind } from '../core/vocab.js';
import { lookupVocabTerm } from '../core/vocab.js';

/**
 * The legend, in the exact order the encoded indices refer to.
 *
 * Semantic tokens are what let a term be coloured by *what it is* — class versus
 * property versus individual — which a TextMate grammar structurally cannot do,
 * since that requires resolving the IRI and looking it up.
 */
export const TOKEN_TYPES = [
  'ontologyClass',
  'objectProperty',
  'datatypeProperty',
  'annotationProperty',
  'individual',
  'prefixName',
  'type',
  'property',
  'variable',
] as const;

export const TOKEN_MODIFIERS = ['declaration', 'defaultLibrary', 'deprecated'] as const;

const TYPE_INDEX = new Map<string, number>(TOKEN_TYPES.map((t, i) => [t, i]));
const MOD_DECLARATION = 1 << TOKEN_MODIFIERS.indexOf('declaration');
const MOD_DEFAULT_LIBRARY = 1 << TOKEN_MODIFIERS.indexOf('defaultLibrary');

const KIND_TO_TOKEN: Record<TermKind, string | undefined> = {
  class: 'ontologyClass',
  objectProperty: 'objectProperty',
  datatypeProperty: 'datatypeProperty',
  annotationProperty: 'annotationProperty',
  individual: 'individual',
  property: 'property',
  datatype: 'type',
  ontology: 'variable',
  unknown: undefined,
};

interface RawToken {
  line: number;
  start: number;
  length: number;
  type: number;
  modifiers: number;
}

/**
 * Encodes semantic tokens in LSP's delta format:
 * `[deltaLine, deltaStartChar, length, tokenType, tokenModifiers]` per token.
 */
export function semanticTokens(index: WorkspaceIndex, doc: ParsedDocument): number[] {
  const raw: RawToken[] = [];

  for (const decl of doc.prefixDeclarations) {
    if (decl.range.start.line !== decl.range.end.line) continue;
    raw.push({
      line: decl.range.start.line,
      start: decl.range.start.character,
      length: decl.range.end.character - decl.range.start.character,
      type: TYPE_INDEX.get('prefixName')!,
      modifiers: MOD_DECLARATION,
    });
  }

  for (const occ of doc.occurrences) {
    // Multi-line terms cannot be expressed in the delta encoding.
    if (occ.range.start.line !== occ.range.end.line) continue;
    if (occ.iri.startsWith('_:')) continue;

    const tokenName = KIND_TO_TOKEN[index.kind(occ.iri)];
    if (!tokenName) continue;
    const type = TYPE_INDEX.get(tokenName);
    if (type === undefined) continue;

    let modifiers = 0;
    if (occ.isDefinition) modifiers |= MOD_DECLARATION;
    if (lookupVocabTerm(occ.iri)) modifiers |= MOD_DEFAULT_LIBRARY;

    raw.push({
      line: occ.range.start.line,
      start: occ.range.start.character,
      length: occ.range.end.character - occ.range.start.character,
      type,
      modifiers,
    });
  }

  raw.sort((a, b) => a.line - b.line || a.start - b.start);

  const data: number[] = [];
  let lastLine = 0;
  let lastStart = 0;
  for (const t of raw) {
    if (t.length <= 0) continue;
    const deltaLine = t.line - lastLine;
    const deltaStart = deltaLine === 0 ? t.start - lastStart : t.start;
    if (deltaStart < 0) continue; // overlapping tokens would corrupt the stream
    data.push(deltaLine, deltaStart, t.length, t.type, t.modifiers);
    lastLine = t.line;
    lastStart = t.start;
  }
  return data;
}
