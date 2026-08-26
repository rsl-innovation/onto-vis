import { splitIri } from '../core/text.js';
import type { WorkspaceIndex } from '../core/workspaceIndex.js';
import type { Location, Position, Range, TermOccurrence } from '../core/types.js';

export interface TextEdit {
  range: Range;
  newText: string;
}

export type WorkspaceEdits = Map<string, TextEdit[]>;

export type RenameResult =
  | { ok: true; edits: WorkspaceEdits; count: number }
  | { ok: false; reason: string };

/** Reads the current text of a document, for occurrences we must re-render in place. */
export type TextProvider = (uri: string) => string | undefined;

export function findDefinitions(index: WorkspaceIndex, uri: string, position: Position): Location[] {
  const occ = index.occurrenceAt(uri, position);
  if (!occ) return [];
  return index.definitions(occ.iri);
}

export function findReferences(
  index: WorkspaceIndex,
  uri: string,
  position: Position,
  includeDeclaration: boolean
): Location[] {
  const occ = index.occurrenceAt(uri, position);
  if (!occ) return [];
  const all = index.references(occ.iri);
  if (includeDeclaration) return all;
  const defs = index.definitions(occ.iri);
  return all.filter((r) => !defs.some((d) => d.uri === r.uri && sameRange(d.range, r.range)));
}

/**
 * The span a rename should put in the edit box: the local name only.
 *
 * Renaming `ex:Person` should offer `Person`, not `ex:Person` — the prefix is a
 * separate concern with its own rename path.
 */
export function prepareRename(
  index: WorkspaceIndex,
  uri: string,
  position: Position,
  textOf: TextProvider
): { range: Range; placeholder: string } | { error: string } {
  const occ = index.occurrenceAt(uri, position);
  if (!occ) return { error: 'Place the cursor on a term to rename it.' };
  if (occ.spelling === 'keyword') {
    return { error: 'The `a` keyword is Turtle syntax for rdf:type and cannot be renamed.' };
  }
  if (occ.spelling === 'blankLabel') {
    return {
      error: 'Blank node labels are local to their file and are not renamed across the workspace.',
    };
  }
  const text = textOf(uri);
  if (text === undefined) return { error: 'The document is not available.' };

  const { local } = splitIri(occ.iri);
  if (!local) return { error: 'This term has no local name to rename.' };

  const range = editableRange(occ, text, local);
  if (!range) return { error: 'This term cannot be renamed safely from here.' };
  return { range, placeholder: local };
}

/**
 * Computes the edits for renaming a term across the workspace.
 *
 * The same IRI can be spelled many ways — `ex:Person`, `<http://ex/Person>`,
 * `<#Person>`, `rdf:about="#Person"`, `rdf:ID="Person"` — so each occurrence is
 * re-rendered in *its own* form rather than text-replaced. If even one occurrence
 * cannot be re-rendered safely the whole rename is refused: a partial rename
 * silently corrupts the ontology, which is far worse than doing nothing.
 */
export function computeRename(
  index: WorkspaceIndex,
  uri: string,
  position: Position,
  newName: string,
  textOf: TextProvider
): RenameResult {
  const occ = index.occurrenceAt(uri, position);
  if (!occ) return { ok: false, reason: 'Place the cursor on a term to rename it.' };

  const trimmed = newName.trim();
  if (!trimmed) return { ok: false, reason: 'The new name is empty.' };
  if (/[\s<>"{}|^`\\]/.test(trimmed)) {
    return { ok: false, reason: `\`${trimmed}\` contains characters that are not valid in an IRI.` };
  }

  const { local: oldLocal } = splitIri(occ.iri);
  if (!oldLocal) return { ok: false, reason: 'This term has no local name to rename.' };

  const edits: WorkspaceEdits = new Map();
  let count = 0;

  for (const location of index.references(occ.iri)) {
    const doc = index.document(location.uri);
    const text = textOf(location.uri);
    if (!doc || text === undefined) {
      return { ok: false, reason: `Cannot rename: ${location.uri} is not loaded.` };
    }
    const target = doc.occurrences.find(
      (o) => o.iri === occ.iri && sameRange(o.range, location.range)
    );
    if (!target) continue;

    const edit = renderRename(target, text, oldLocal, trimmed);
    if ('error' in edit) {
      return {
        ok: false,
        reason: `Cannot rename safely: ${edit.error} (${shortName(location.uri)}, line ${
          location.range.start.line + 1
        }).`,
      };
    }
    const list = edits.get(location.uri);
    if (list) list.push(edit.edit);
    else edits.set(location.uri, [edit.edit]);
    count++;
  }

  if (count === 0) return { ok: false, reason: 'No occurrences of this term were found.' };
  return { ok: true, edits, count };
}

/** The sub-range a rename actually edits, given how the occurrence is spelled. */
function editableRange(occ: TermOccurrence, text: string, local: string): Range | undefined {
  switch (occ.spelling) {
    case 'curie':
    case 'qname':
      return occ.localRange ?? localRangeFromColon(occ, text);
    case 'rdfID':
      return occ.range;
    case 'absolute':
    case 'relative':
    case 'attrIri': {
      const written = sliceRange(text, occ.range);
      const at = written.lastIndexOf(local);
      if (at < 0) return undefined;
      return shiftRange(occ.range, at, at + local.length);
    }
    default:
      return undefined;
  }
}

function renderRename(
  occ: TermOccurrence,
  text: string,
  oldLocal: string,
  newLocal: string
): { edit: TextEdit } | { error: string } {
  switch (occ.spelling) {
    case 'keyword':
      return { error: 'the `a` keyword cannot be rewritten' };
    case 'blankLabel':
      return { error: 'blank node labels are file-local' };
    case 'curie':
    case 'qname': {
      const range = occ.localRange ?? localRangeFromColon(occ, text);
      if (!range) return { error: 'the prefixed name could not be located' };
      return { edit: { range, newText: newLocal } };
    }
    case 'rdfID':
      return { edit: { range: occ.range, newText: newLocal } };
    case 'absolute':
    case 'relative':
    case 'attrIri': {
      const written = sliceRange(text, occ.range);
      const at = written.lastIndexOf(oldLocal);
      if (at < 0) return { error: `\`${written}\` does not end with \`${oldLocal}\`` };
      return {
        edit: { range: shiftRange(occ.range, at, at + oldLocal.length), newText: newLocal },
      };
    }
    default:
      return { error: 'unrecognised term spelling' };
  }
}

function localRangeFromColon(occ: TermOccurrence, text: string): Range | undefined {
  const written = sliceRange(text, occ.range);
  const colon = written.indexOf(':');
  if (colon < 0) return undefined;
  return shiftRange(occ.range, colon + 1, written.length);
}

/** Both offsets are relative to the start of `range`, which never spans lines here. */
function shiftRange(range: Range, from: number, to: number): Range {
  return {
    start: { line: range.start.line, character: range.start.character + from },
    end: { line: range.start.line, character: range.start.character + to },
  };
}

function sliceRange(text: string, range: Range): string {
  const lines = text.split(/\r\n|\r|\n/);
  const line = lines[range.start.line] ?? '';
  if (range.start.line !== range.end.line) return line.slice(range.start.character);
  return line.slice(range.start.character, range.end.character);
}

function sameRange(a: Range, b: Range): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}

function shortName(uri: string): string {
  return uri.split('/').pop() ?? uri;
}
