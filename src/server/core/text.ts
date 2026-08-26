import type { Position, Range } from './types.js';

/**
 * Maps absolute character offsets to line/character positions.
 *
 * Built once per document version. Lookup is a binary search over line starts,
 * so converting a whole token stream stays O(n log n) rather than O(n·length).
 */
export class LineMap {
  private readonly lineStarts: number[];

  constructor(private readonly text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10 /* \n */) {
        starts.push(i + 1);
      } else if (c === 13 /* \r */) {
        // Treat \r\n as one break; a lone \r also ends a line.
        if (text.charCodeAt(i + 1) === 10) i++;
        starts.push(i + 1);
      }
    }
    this.lineStarts = starts;
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }

  positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.lineStarts[mid] <= clamped) low = mid;
      else high = mid - 1;
    }
    return { line: low, character: clamped - this.lineStarts[low] };
  }

  offsetAt(position: Position): number {
    if (position.line < 0) return 0;
    if (position.line >= this.lineStarts.length) return this.text.length;
    const lineStart = this.lineStarts[position.line];
    const lineEnd =
      position.line + 1 < this.lineStarts.length ? this.lineStarts[position.line + 1] : this.text.length;
    return Math.min(lineStart + Math.max(0, position.character), lineEnd);
  }

  rangeAt(start: number, end: number): Range {
    return { start: this.positionAt(start), end: this.positionAt(end) };
  }
}

/** True when `range` contains `position` (end-exclusive, as LSP ranges are). */
export function rangeContains(range: Range, position: Position): boolean {
  const afterStart =
    position.line > range.start.line ||
    (position.line === range.start.line && position.character >= range.start.character);
  const beforeEnd =
    position.line < range.end.line ||
    (position.line === range.end.line && position.character <= range.end.character);
  return afterStart && beforeEnd;
}

const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function isAbsoluteIri(iri: string): boolean {
  return ABSOLUTE_IRI.test(iri);
}

/**
 * Resolves `ref` against `base` per RFC 3986.
 *
 * Delegates to WHATWG `URL`, which implements the same resolution rules, rather
 * than hand-rolling the algorithm. Returns `ref` unchanged when resolution is
 * impossible (no usable base, or a base that is not itself absolute).
 */
export function resolveIri(ref: string, base: string | undefined): string {
  if (isAbsoluteIri(ref)) return ref;
  if (!base || !isAbsoluteIri(base)) return ref;
  try {
    return new URL(ref, base).href;
  } catch {
    return ref;
  }
}

/** Splits an absolute IRI into namespace and local name at the last `#` or `/`. */
export function splitIri(iri: string): { namespace: string; local: string } {
  const hash = iri.lastIndexOf('#');
  if (hash >= 0) return { namespace: iri.slice(0, hash + 1), local: iri.slice(hash + 1) };
  const slash = iri.lastIndexOf('/');
  if (slash >= 0) return { namespace: iri.slice(0, slash + 1), local: iri.slice(slash + 1) };
  const colon = iri.lastIndexOf(':');
  if (colon >= 0) return { namespace: iri.slice(0, colon + 1), local: iri.slice(colon + 1) };
  return { namespace: '', local: iri };
}

/** The human-facing short name for a term: its local part, falling back to the full IRI. */
export function localName(iri: string): string {
  const { local } = splitIri(iri);
  return local || iri;
}
