import { Parser } from 'n3';
import type { LineMap } from '../../core/text.js';
import type { Diagnostic, RdfFormat, RdfQuad, RdfTerm } from '../../core/types.js';
import type { TurtleToken } from './scan.js';

/** How many recovery rounds before we stop; a badly broken file must not spin. */
const MAX_RECOVERY_ROUNDS = 50;

const N3_FORMAT: Record<string, string> = {
  turtle: 'text/turtle',
  ntriples: 'application/n-triples',
  nquads: 'application/n-quads',
  trig: 'application/trig',
  n3: 'text/n3',
};

export interface TurtleParseResult {
  quads: RdfQuad[];
  diagnostics: Diagnostic[];
}

/** Offsets of every `.` that actually terminates a statement (bracket depth 0). */
function statementTerminators(tokens: TurtleToken[]): number[] {
  const ends: number[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.type !== 'punct') continue;
    if (t.text === '[' || t.text === '(' || t.text === '{') depth++;
    else if (t.text === ']' || t.text === ')' || t.text === '}') depth = Math.max(0, depth - 1);
    else if (t.text === '.' && depth === 0) ends.push(t.end);
  }
  return ends;
}

/**
 * Replaces a span with spaces, preserving line breaks.
 *
 * This is what makes recovery cheap and exact: because every character count and
 * every newline survives, the re-parsed text has *identical* line numbering to
 * the original, so N3's reported line still points at the right place — and the
 * surviving `@prefix` declarations stay in scope for later statements.
 */
function blankOut(text: string, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; i++) {
    const c = text[i];
    out += c === '\n' || c === '\r' ? c : ' ';
  }
  return text.slice(0, start) + out + text.slice(end);
}

function toTerm(term: any): RdfTerm {
  const t: RdfTerm = { termType: term.termType, value: term.value };
  if (term.termType === 'Literal') {
    if (term.datatype?.value) t.datatype = term.datatype.value;
    if (term.language) t.language = term.language;
  }
  return t;
}

/** Pulls the offending text out of N3's `Unexpected "xyz" on line N.` message. */
function offendingText(message: string): string | undefined {
  return /"([^"]*)"/.exec(message)?.[1];
}

/**
 * Parses a Turtle-family document, recovering past syntax errors so that a single
 * mistake does not hide every later statement.
 *
 * N3.Parser aborts on the first error, so each round blanks out the offending
 * statement and re-parses. Quads are taken from the final successful round, which
 * contains every statement that was not itself broken.
 */
export function parseTurtle(
  text: string,
  tokens: TurtleToken[],
  lines: LineMap,
  baseIRI: string,
  format: RdfFormat
): TurtleParseResult {
  const diagnostics: Diagnostic[] = [];
  const terminators = statementTerminators(tokens);
  let working = text;
  let quads: RdfQuad[] = [];

  for (let round = 0; round <= MAX_RECOVERY_ROUNDS; round++) {
    try {
      const parser = new Parser({ baseIRI, format: N3_FORMAT[format] ?? 'text/turtle' } as any);
      quads = parser.parse(working).map((q: any) => ({
        subject: toTerm(q.subject),
        predicate: toTerm(q.predicate),
        object: toTerm(q.object),
        ...(q.graph && q.graph.termType !== 'DefaultGraph' ? { graph: toTerm(q.graph) } : {}),
      }));
      break;
    } catch (err: any) {
      const message: string = err?.message ?? 'Failed to parse document.';
      const errLine: number = err?.context?.line ?? 1; // 1-based, and reliable
      const lineIndex = Math.max(0, errLine - 1);

      // The scanner reports undefined prefixes with a tighter range; don't duplicate.
      if (!/Undefined prefix/i.test(message)) {
        diagnostics.push({
          range: errorRange(text, lines, lineIndex, tokens, message),
          message: message.replace(/\s*on line \d+\.?$/, '.'),
          severity: 1,
          code: 'syntax',
          source: 'rdf',
        });
      }

      if (round === MAX_RECOVERY_ROUNDS) {
        diagnostics.push({
          range: lines.rangeAt(0, 0),
          message: `Stopped after ${MAX_RECOVERY_ROUNDS} syntax errors. Fix the errors above and re-check.`,
          severity: 2,
          code: 'too-many-errors',
          source: 'rdf',
        });
        break;
      }

      // Blank out the statement containing the error, then try again.
      const errOffset = lines.offsetAt({ line: lineIndex, character: 0 });
      const end = terminators.find((t) => t > errOffset) ?? working.length;
      let start = 0;
      for (const t of terminators) {
        if (t <= errOffset) start = t;
        else break;
      }
      if (end <= start) break; // no forward progress possible
      const next = blankOut(working, start, end);
      if (next === working) break;
      working = next;
    }
  }

  return { quads, diagnostics };
}

/**
 * Narrows an error to the offending token where possible.
 *
 * N3 gives us a reliable line but unreliable columns, so we locate the token on
 * that line by matching the text quoted in its message, and fall back to the
 * line's trimmed extent.
 */
function errorRange(
  text: string,
  lines: LineMap,
  lineIndex: number,
  tokens: TurtleToken[],
  message: string
) {
  const lineStart = lines.offsetAt({ line: lineIndex, character: 0 });
  const lineEnd = lines.offsetAt({ line: lineIndex + 1, character: 0 });
  const wanted = offendingText(message);

  if (wanted) {
    const onLine = tokens.filter((t) => t.start >= lineStart && t.start < lineEnd);
    const hit = onLine.find((t) => t.text === wanted) ?? onLine.find((t) => t.text.includes(wanted));
    if (hit) return lines.rangeAt(hit.start, hit.end);

    // No token matched (N3 may quote a construct our tokenizer split differently),
    // so fall back to locating the quoted text directly on the line.
    const at = text.indexOf(wanted, lineStart);
    if (at >= 0 && at < lineEnd) return lines.rangeAt(at, at + wanted.length);
  }

  const raw = text.slice(lineStart, lineEnd);
  const lead = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  const from = lineStart + lead;
  const to = Math.max(from + 1, lineEnd - trailing);
  return lines.rangeAt(from, to);
}
