import { LineMap, isAbsoluteIri, resolveIri } from '../../core/text.js';
import type {
  Diagnostic,
  PrefixDeclaration,
  Range,
  Spelling,
  TermOccurrence,
  TermRole,
} from '../../core/types.js';

export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

export type TurtleTokenType =
  | 'directive'       // @prefix / @base / PREFIX / BASE
  | 'iriref'          // <...>
  | 'pname'           // ex:Person, :Person, ex:
  | 'blank'           // _:b1
  | 'string'
  | 'langtag'         // @en
  | 'datatypeMarker'  // ^^
  | 'number'
  | 'word'            // a / true / false / anything bare
  | 'punct'
  | 'comment'
  | 'unknown';

export interface TurtleToken {
  type: TurtleTokenType;
  /** Raw source text, exactly as written. */
  text: string;
  /** Absolute character offsets into the document; `end` is exclusive. */
  start: number;
  end: number;
  /** Prefixed names only: the prefix label (`''` for the default prefix `:x`). */
  prefix?: string;
  /** Prefixed names: the local part. IRI refs: the text between the angle brackets. */
  value?: string;
  /** Prefixed names: absolute offsets of just the local part. */
  localStart?: number;
  localEnd?: number;
}

/**
 * One regex, applied stickily, in priority order.
 *
 * Ordering notes that matter:
 *  - long strings before short ones, so `"""` is never read as an empty `""`;
 *  - `sparqlDirective` carries a `(?![-A-Za-z0-9_:])` guard so `base:x` stays a
 *    prefixed name rather than a BASE directive;
 *  - `pname` before `word`, so `a:b` is a prefixed name while bare `a` is not.
 */
const TOKEN_RE = new RegExp(
  [
    '(?<ws>[ \\t\\r\\n]+)',
    '(?<comment>#[^\\n\\r]*)',
    '(?<longString>"""(?:[^"\\\\]|\\\\[\\s\\S]|"(?!""))*"""' +
      "|'''(?:[^'\\\\]|\\\\[\\s\\S]|'(?!''))*''')",
    '(?<shortString>"(?:[^"\\\\\\n\\r]|\\\\[\\s\\S])*"' + "|'(?:[^'\\\\\\n\\r]|\\\\[\\s\\S])*')",
    '(?<iriref><(?:[^<>"{}|^`\\\\\\x00-\\x20]|\\\\u[0-9A-Fa-f]{4}|\\\\U[0-9A-Fa-f]{8})*>)',
    '(?<atDirective>@(?:prefix|base)(?![-A-Za-z0-9_]))',
    '(?<sparqlDirective>(?:[Pp][Rr][Ee][Ff][Ii][Xx]|[Bb][Aa][Ss][Ee])(?![-A-Za-z0-9_:]))',
    '(?<langtag>@[a-zA-Z]+(?:-[a-zA-Z0-9]+)*)',
    '(?<blank>_:[A-Za-z0-9_\\u00C0-\\uFFFF][-A-Za-z0-9_.\\u00C0-\\uFFFF]*)',
    '(?<datatypeMarker>\\^\\^)',
    '(?<pname>(?:[A-Za-z\\u00C0-\\uFFFF][-A-Za-z0-9_.\\u00C0-\\uFFFF]*)?:' +
      "(?:%[0-9A-Fa-f]{2}|\\\\[-_~.!$&'()*+,;=/?#@%]|[-A-Za-z0-9_.%\\u00C0-\\uFFFF:])*)",
    '(?<number>[+-]?(?:[0-9]+\\.[0-9]*[eE][+-]?[0-9]+|\\.[0-9]+[eE][+-]?[0-9]+' +
      '|[0-9]+[eE][+-]?[0-9]+|[0-9]*\\.[0-9]+|[0-9]+))',
    '(?<word>[A-Za-z_][-A-Za-z0-9_]*)',
    '(?<punct>[.;,\\[\\](){}])',
    '(?<unterminatedString>["\'])',
    '(?<unterminatedIri><)',
    '(?<any>[\\s\\S])',
  ].join('|'),
  'y'
);

/** Turtle ends a statement with `.`, so trailing dots are never part of a name. */
function trimTrailingDots(text: string, end: number): { text: string; end: number } {
  let e = end;
  let t = text;
  while (t.length > 0 && t.endsWith('.')) {
    t = t.slice(0, -1);
    e -= 1;
  }
  return { text: t, end: e };
}

/** Tokenizes Turtle-family syntax into tokens carrying exact absolute offsets. */
export function tokenizeTurtle(text: string): TurtleToken[] {
  const tokens: TurtleToken[] = [];
  TOKEN_RE.lastIndex = 0;
  let pos = 0;

  while (pos < text.length) {
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(text);
    if (!m) break;
    const g = m.groups!;
    const start = pos;
    let end = pos + m[0].length;
    pos = end;

    if (g.ws !== undefined) continue;

    if (g.comment !== undefined) {
      tokens.push({ type: 'comment', text: m[0], start, end });
      continue;
    }
    if (g.longString !== undefined || g.shortString !== undefined) {
      tokens.push({ type: 'string', text: m[0], start, end });
      continue;
    }
    if (g.iriref !== undefined) {
      tokens.push({ type: 'iriref', text: m[0], start, end, value: m[0].slice(1, -1) });
      continue;
    }
    if (g.atDirective !== undefined || g.sparqlDirective !== undefined) {
      tokens.push({ type: 'directive', text: m[0], start, end });
      continue;
    }
    if (g.langtag !== undefined) {
      tokens.push({ type: 'langtag', text: m[0], start, end, value: m[0].slice(1) });
      continue;
    }
    if (g.blank !== undefined) {
      const trimmed = trimTrailingDots(m[0], end);
      pos = trimmed.end;
      tokens.push({
        type: 'blank',
        text: trimmed.text,
        start,
        end: trimmed.end,
        value: trimmed.text.slice(2),
      });
      continue;
    }
    if (g.datatypeMarker !== undefined) {
      tokens.push({ type: 'datatypeMarker', text: m[0], start, end });
      continue;
    }
    if (g.pname !== undefined) {
      const trimmed = trimTrailingDots(m[0], end);
      pos = trimmed.end;
      end = trimmed.end;
      const colon = trimmed.text.indexOf(':');
      tokens.push({
        type: 'pname',
        text: trimmed.text,
        start,
        end,
        prefix: trimmed.text.slice(0, colon),
        value: trimmed.text.slice(colon + 1),
        localStart: start + colon + 1,
        localEnd: end,
      });
      continue;
    }
    if (g.number !== undefined) {
      tokens.push({ type: 'number', text: m[0], start, end });
      continue;
    }
    if (g.word !== undefined) {
      tokens.push({ type: 'word', text: m[0], start, end });
      continue;
    }
    if (g.punct !== undefined) {
      tokens.push({ type: 'punct', text: m[0], start, end });
      continue;
    }
    // Unterminated string / IRI: consume to end of line so one broken construct
    // does not cascade into every following token.
    if (g.unterminatedString !== undefined || g.unterminatedIri !== undefined) {
      let lineEnd = text.indexOf('\n', start);
      if (lineEnd < 0) lineEnd = text.length;
      pos = lineEnd;
      tokens.push({
        type: 'unknown',
        text: text.slice(start, lineEnd),
        start,
        end: lineEnd,
      });
      continue;
    }
    tokens.push({ type: 'unknown', text: m[0], start, end });
  }

  return coalesceUnknown(tokens);
}

/**
 * Merges runs of adjacent `unknown` tokens.
 *
 * The catch-all branch consumes one character at a time, so garbage like `!!!`
 * would otherwise arrive as three tokens — too small to match the offending text
 * N3 quotes in its error messages, and too noisy to underline usefully.
 */
function coalesceUnknown(tokens: TurtleToken[]): TurtleToken[] {
  const out: TurtleToken[] = [];
  for (const tok of tokens) {
    const prev = out[out.length - 1];
    if (tok.type === 'unknown' && prev?.type === 'unknown' && prev.end === tok.start) {
      prev.end = tok.end;
      prev.text += tok.text;
      continue;
    }
    out.push({ ...tok });
  }
  return out;
}

export interface TurtleScanResult {
  tokens: TurtleToken[];
  occurrences: TermOccurrence[];
  prefixDeclarations: PrefixDeclaration[];
  prefixes: Record<string, string>;
  base: string;
  diagnostics: Diagnostic[];
}

type FrameKind = 'top' | 'bnode' | 'collection';
type SlotState = 'subject' | 'predicate' | 'object';

interface Frame {
  kind: FrameKind;
  state: SlotState;
}

/**
 * Walks the token stream and produces one `TermOccurrence` per textual mention of
 * a term, with its role in the triple and how it was spelled.
 *
 * Prefixes are applied progressively, matching Turtle's own rule that a prefix
 * must be declared before use — so a forward reference correctly reports as an
 * undefined prefix rather than silently resolving.
 */
export function scanTurtle(text: string, documentBase: string): TurtleScanResult {
  const tokens = tokenizeTurtle(text);
  const lines = new LineMap(text);
  const occurrences: TermOccurrence[] = [];
  const prefixDeclarations: PrefixDeclaration[] = [];
  const prefixes: Record<string, string> = {};
  const diagnostics: Diagnostic[] = [];
  let base = documentBase;

  const stack: Frame[] = [{ kind: 'top', state: 'subject' }];
  const frame = (): Frame => stack[stack.length - 1];

  const record = (
    iri: string,
    range: Range,
    role: TermRole,
    spelling: Spelling,
    isDefinition: boolean,
    localRange?: Range
  ) => {
    const occ: TermOccurrence = { iri, range, role, spelling, isDefinition };
    if (localRange) occ.localRange = localRange;
    occurrences.push(occ);
  };

  /** After a term fills its slot, move to the next expected slot. */
  const advance = () => {
    const f = frame();
    if (f.kind === 'collection') return;
    if (f.state === 'subject') f.state = 'predicate';
    else if (f.state === 'predicate') f.state = 'object';
  };

  const currentRole = (): TermRole => {
    const f = frame();
    if (f.kind === 'collection') return 'object';
    return f.state;
  };

  let i = 0;
  /** Non-comment tokens only; comments never affect parse state. */
  const significant = tokens.filter((t) => t.type !== 'comment');

  while (i < significant.length) {
    const tok = significant[i];

    // ---- Directives -------------------------------------------------------
    if (tok.type === 'directive') {
      const kind = tok.text.replace(/^@/, '').toLowerCase();
      if (kind === 'prefix') {
        const nameTok = significant[i + 1];
        const iriTok = significant[i + 2];
        if (nameTok?.type === 'pname' && iriTok?.type === 'iriref') {
          const label = nameTok.prefix ?? '';
          const namespace = resolveIri(iriTok.value ?? '', base);
          prefixes[label] = namespace;
          const terminator = significant[i + 3];
          const declEnd =
            terminator?.type === 'punct' && terminator.text === '.' ? terminator.end : iriTok.end;
          prefixDeclarations.push({
            prefix: label,
            namespace,
            range: lines.rangeAt(nameTok.start, nameTok.end),
            fullRange: lines.rangeAt(tok.start, declEnd),
          });
          i += 3;
          continue;
        }
        diagnostics.push({
          range: lines.rangeAt(tok.start, tok.end),
          message: 'Malformed prefix declaration. Expected `@prefix label: <namespace> .`',
          severity: 1,
          code: 'malformed-prefix',
          source: 'rdf',
        });
        i += 1;
        continue;
      }
      if (kind === 'base') {
        const iriTok = significant[i + 1];
        if (iriTok?.type === 'iriref') {
          base = resolveIri(iriTok.value ?? '', base);
          i += 2;
          continue;
        }
        diagnostics.push({
          range: lines.rangeAt(tok.start, tok.end),
          message: 'Malformed base declaration. Expected `@base <iri> .`',
          severity: 1,
          code: 'malformed-base',
          source: 'rdf',
        });
      }
      i += 1;
      continue;
    }

    // ---- Structure --------------------------------------------------------
    if (tok.type === 'punct') {
      switch (tok.text) {
        case '.':
          // Only a top-level dot terminates a statement.
          if (frame().kind === 'top') frame().state = 'subject';
          break;
        case ';':
          if (frame().kind !== 'collection') frame().state = 'predicate';
          break;
        case ',':
          if (frame().kind !== 'collection') frame().state = 'object';
          break;
        case '[':
          stack.push({ kind: 'bnode', state: 'predicate' });
          break;
        case '(':
          stack.push({ kind: 'collection', state: 'object' });
          break;
        case ']':
        case ')':
          if (stack.length > 1) stack.pop();
          // The bracketed group just filled a slot in the enclosing frame.
          advance();
          break;
        default:
          break;
      }
      i += 1;
      continue;
    }

    // ---- Datatype (`^^` followed by a term) -------------------------------
    if (tok.type === 'datatypeMarker') {
      const dt = significant[i + 1];
      if (dt?.type === 'pname') {
        const ns = prefixes[dt.prefix ?? ''];
        if (ns !== undefined) {
          record(
            ns + (dt.value ?? ''),
            lines.rangeAt(dt.start, dt.end),
            'datatype',
            'curie',
            false,
            lines.rangeAt(dt.localStart ?? dt.start, dt.localEnd ?? dt.end)
          );
        } else {
          diagnostics.push(undefinedPrefix(dt, lines));
        }
        i += 2;
        continue;
      }
      if (dt?.type === 'iriref') {
        const raw = dt.value ?? '';
        record(
          resolveIri(raw, base),
          lines.rangeAt(dt.start, dt.end),
          'datatype',
          isAbsoluteIri(raw) ? 'absolute' : 'relative',
          false
        );
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    // ---- Terms ------------------------------------------------------------
    if (tok.type === 'pname') {
      const label = tok.prefix ?? '';
      const ns = prefixes[label];
      if (ns === undefined) {
        diagnostics.push(undefinedPrefix(tok, lines));
      } else {
        const role = currentRole();
        record(
          ns + (tok.value ?? ''),
          lines.rangeAt(tok.start, tok.end),
          role,
          'curie',
          role === 'subject' && frame().kind === 'top',
          lines.rangeAt(tok.localStart ?? tok.start, tok.localEnd ?? tok.end)
        );
      }
      advance();
      i += 1;
      continue;
    }

    if (tok.type === 'iriref') {
      const raw = tok.value ?? '';
      const role = currentRole();
      record(
        resolveIri(raw, base),
        lines.rangeAt(tok.start, tok.end),
        role,
        isAbsoluteIri(raw) ? 'absolute' : 'relative',
        role === 'subject' && frame().kind === 'top'
      );
      advance();
      i += 1;
      continue;
    }

    if (tok.type === 'blank') {
      const role = currentRole();
      record(
        `_:${tok.value ?? ''}`,
        lines.rangeAt(tok.start, tok.end),
        role,
        'blankLabel',
        false
      );
      advance();
      i += 1;
      continue;
    }

    if (tok.type === 'word') {
      if (tok.text === 'a') {
        // `a` is the rdf:type abbreviation and only ever appears as a predicate.
        record(RDF_TYPE, lines.rangeAt(tok.start, tok.end), 'predicate', 'keyword', false);
        frame().state = 'object';
      } else if (tok.text === 'true' || tok.text === 'false') {
        advance();
      } else {
        diagnostics.push({
          range: lines.rangeAt(tok.start, tok.end),
          message: `Unexpected token \`${tok.text}\`. Bare words are not valid Turtle terms; did you mean a prefixed name?`,
          severity: 1,
          code: 'bare-word',
          source: 'rdf',
        });
        advance();
      }
      i += 1;
      continue;
    }

    if (tok.type === 'string' || tok.type === 'number') {
      // A langtag or ^^datatype may follow; both are handled on their own turn.
      if (significant[i + 1]?.type === 'langtag') i += 1;
      advance();
      i += 1;
      continue;
    }

    if (tok.type === 'unknown') {
      diagnostics.push({
        range: lines.rangeAt(tok.start, tok.end),
        message: 'Unterminated string or IRI.',
        severity: 1,
        code: 'unterminated',
        source: 'rdf',
      });
      i += 1;
      continue;
    }

    i += 1;
  }

  // Namespaces every Turtle document may use without declaring, per common practice.
  if (prefixes.xsd === undefined) prefixes.xsd = XSD;

  return { tokens, occurrences, prefixDeclarations, prefixes, base, diagnostics };
}

function undefinedPrefix(tok: TurtleToken, lines: LineMap): Diagnostic {
  const label = tok.prefix ?? '';
  return {
    range: lines.rangeAt(tok.start, tok.start + label.length + 1),
    message: `Undefined prefix \`${label}:\`. Add \`@prefix ${label}: <…> .\` before using it.`,
    severity: 1,
    code: 'undefined-prefix',
    source: 'rdf',
  };
}
