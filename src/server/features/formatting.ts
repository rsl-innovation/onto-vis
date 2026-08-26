import type { TurtleToken } from '../formats/turtle/scan.js';

export interface FormatOptions {
  indent: number;
  sortPrefixes: boolean;
  /** Aligns namespaces into a column in the prefix block. */
  alignPrefixes: boolean;
}

export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
  indent: 4,
  sortPrefixes: true,
  alignPrefixes: true,
};

/** An atom is a single term; the others are Turtle's two nesting constructs. */
type Term =
  | { kind: 'atom'; text: string }
  | { kind: 'bnode'; groups: PredicateGroup[] }
  | { kind: 'list'; items: Term[] };

interface PredicateGroup {
  predicate: Term;
  objects: Term[];
  /** Comments written on the same line as this group, preserved verbatim. */
  trailing: string[];
}

interface Statement {
  subject: Term;
  groups: PredicateGroup[];
  leading: string[];
}

/**
 * Pretty-prints a Turtle-family document.
 *
 * Deliberately token-driven rather than a re-serialisation through `N3.Writer`:
 * the writer discards comments entirely and reorders statements, which loses
 * authoring intent. Working from the token stream keeps every comment.
 *
 * Returns `undefined` when the document cannot be formatted with confidence —
 * a syntax error, an unbalanced bracket, an unexpected token. Declining to format
 * is always better than rewriting a file into something the user did not mean.
 */
export function formatTurtle(
  tokens: TurtleToken[],
  options: FormatOptions = DEFAULT_FORMAT_OPTIONS
): string | undefined {
  if (tokens.some((t) => t.type === 'unknown')) return undefined;

  const parser = new StatementParser(tokens);
  const parsed = parser.parse();
  if (!parsed) return undefined;

  const { prefixes, bases, statements, trailingComments } = parsed;
  const out: string[] = [];

  // --- prefix block -------------------------------------------------------
  if (prefixes.length > 0) {
    const ordered = options.sortPrefixes
      ? [...prefixes].sort((a, b) => a.label.localeCompare(b.label))
      : prefixes;
    const width = options.alignPrefixes
      ? Math.max(...ordered.map((p) => p.label.length))
      : 0;
    for (const p of ordered) {
      out.push(`@prefix ${p.label.padEnd(width)} <${p.iri}> .`);
    }
  }
  for (const b of bases) out.push(`@base <${b}> .`);
  if (out.length > 0) out.push('');

  // --- statements ---------------------------------------------------------
  const pad = ' '.repeat(Math.max(1, options.indent));
  for (const statement of statements) {
    for (const comment of statement.leading) out.push(comment);
    out.push(...renderStatement(statement, pad));
    out.push('');
  }

  for (const comment of trailingComments) out.push(comment);

  // Collapse runs of blank lines and guarantee a single trailing newline.
  const text = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');
  return `${text}\n`;
}

function renderStatement(statement: Statement, pad: string): string[] {
  const lines: string[] = [];
  const subject = renderTerm(statement.subject);

  if (statement.groups.length === 0) return [`${subject} .`];

  statement.groups.forEach((group, i) => {
    const predicate = renderTerm(group.predicate);
    const objects = group.objects.map(renderTerm);
    const isLast = i === statement.groups.length - 1;
    const terminator = isLast ? ' .' : ' ;';

    const head = i === 0 ? `${subject} ${predicate}` : `${pad}${predicate}`;
    const inline = `${head} ${objects.join(', ')}${terminator}`;

    // Keep a group on one line unless it would be unwieldy, in which case give
    // each object its own line under the predicate.
    if (inline.length <= 100 || objects.length === 1) {
      lines.push(inline + renderComments(group.trailing));
    } else {
      lines.push(`${head} ${objects[0]},`);
      const objectPad = pad + pad;
      objects.slice(1).forEach((o, j) => {
        const last = j === objects.length - 2;
        lines.push(`${objectPad}${o}${last ? terminator : ','}`);
      });
      if (group.trailing.length > 0) lines[lines.length - 1] += renderComments(group.trailing);
    }
  });

  return lines;
}

function renderComments(comments: string[]): string {
  return comments.length === 0 ? '' : `  ${comments.join(' ')}`;
}

function renderTerm(term: Term): string {
  if (term.kind === 'atom') return term.text;
  if (term.kind === 'list') {
    return term.items.length === 0 ? '()' : `( ${term.items.map(renderTerm).join(' ')} )`;
  }
  if (term.groups.length === 0) return '[]';
  const inner = term.groups
    .map((g) => `${renderTerm(g.predicate)} ${g.objects.map(renderTerm).join(', ')}`)
    .join(' ; ');
  return `[ ${inner} ]`;
}

interface ParseResult {
  prefixes: Array<{ label: string; iri: string }>;
  bases: string[];
  statements: Statement[];
  trailingComments: string[];
}

/** Rebuilds a small AST from the token stream, keeping comments attached. */
class StatementParser {
  private i = 0;
  private readonly tokens: TurtleToken[];

  constructor(tokens: TurtleToken[]) {
    this.tokens = tokens;
  }

  parse(): ParseResult | undefined {
    const prefixes: Array<{ label: string; iri: string }> = [];
    const bases: string[] = [];
    const statements: Statement[] = [];
    let pendingComments: string[] = [];

    while (this.i < this.tokens.length) {
      const tok = this.tokens[this.i];

      if (tok.type === 'comment') {
        pendingComments.push(tok.text.trim());
        this.i++;
        continue;
      }

      if (tok.type === 'directive') {
        const kind = tok.text.replace(/^@/, '').toLowerCase();
        this.i++;
        if (kind === 'prefix') {
          const name = this.next();
          const iri = this.next();
          if (name?.type !== 'pname' || iri?.type !== 'iriref') return undefined;
          prefixes.push({ label: `${name.prefix ?? ''}:`, iri: iri.value ?? '' });
        } else if (kind === 'base') {
          const iri = this.next();
          if (iri?.type !== 'iriref') return undefined;
          bases.push(iri.value ?? '');
        } else {
          return undefined;
        }
        this.consumeOptionalDot();
        continue;
      }

      const statement = this.parseStatement(pendingComments);
      if (!statement) return undefined;
      pendingComments = [];
      statements.push(statement);
    }

    return { prefixes, bases, statements, trailingComments: pendingComments };
  }

  private parseStatement(leading: string[]): Statement | undefined {
    const subject = this.parseTerm();
    if (!subject) return undefined;

    const groups: PredicateGroup[] = [];
    while (this.i < this.tokens.length) {
      const tok = this.tokens[this.i];
      if (tok.type === 'punct' && tok.text === '.') {
        this.i++;
        return { subject, groups, leading };
      }
      if (tok.type === 'punct' && tok.text === ';') {
        this.i++;
        continue;
      }
      if (tok.type === 'comment') {
        const target = groups[groups.length - 1];
        if (target) target.trailing.push(tok.text.trim());
        else leading.push(tok.text.trim());
        this.i++;
        continue;
      }
      const group = this.parsePredicateGroup();
      if (!group) return undefined;
      groups.push(group);
    }

    // A document may end without a final dot; accept what we have.
    return { subject, groups, leading };
  }

  private parsePredicateGroup(): PredicateGroup | undefined {
    const predicate = this.parseTerm();
    if (!predicate) return undefined;
    const objects: Term[] = [];
    const trailing: string[] = [];

    while (this.i < this.tokens.length) {
      const tok = this.tokens[this.i];
      if (tok.type === 'comment') {
        trailing.push(tok.text.trim());
        this.i++;
        continue;
      }
      if (tok.type === 'punct' && (tok.text === '.' || tok.text === ';')) break;
      if (tok.type === 'punct' && tok.text === ',') {
        this.i++;
        continue;
      }
      if (tok.type === 'punct' && (tok.text === ']' || tok.text === ')')) break;
      const object = this.parseTerm();
      if (!object) return undefined;
      objects.push(object);
    }

    if (objects.length === 0) return undefined;
    return { predicate, objects, trailing };
  }

  private parseTerm(): Term | undefined {
    const tok = this.tokens[this.i];
    if (!tok) return undefined;

    if (tok.type === 'punct' && tok.text === '[') {
      this.i++;
      const groups: PredicateGroup[] = [];
      while (this.i < this.tokens.length) {
        const t = this.tokens[this.i];
        if (t.type === 'punct' && t.text === ']') {
          this.i++;
          return { kind: 'bnode', groups };
        }
        if (t.type === 'punct' && t.text === ';') {
          this.i++;
          continue;
        }
        if (t.type === 'comment') {
          this.i++;
          continue;
        }
        const group = this.parsePredicateGroup();
        if (!group) return undefined;
        groups.push(group);
      }
      return undefined; // unbalanced
    }

    if (tok.type === 'punct' && tok.text === '(') {
      this.i++;
      const items: Term[] = [];
      while (this.i < this.tokens.length) {
        const t = this.tokens[this.i];
        if (t.type === 'punct' && t.text === ')') {
          this.i++;
          return { kind: 'list', items };
        }
        if (t.type === 'comment') {
          this.i++;
          continue;
        }
        const item = this.parseTerm();
        if (!item) return undefined;
        items.push(item);
      }
      return undefined; // unbalanced
    }

    if (
      tok.type === 'iriref' ||
      tok.type === 'pname' ||
      tok.type === 'blank' ||
      tok.type === 'number' ||
      tok.type === 'word'
    ) {
      this.i++;
      return { kind: 'atom', text: tok.text };
    }

    if (tok.type === 'string') {
      this.i++;
      let text = tok.text;
      const next = this.tokens[this.i];
      if (next?.type === 'langtag') {
        text += next.text;
        this.i++;
      } else if (next?.type === 'datatypeMarker') {
        const datatype = this.tokens[this.i + 1];
        if (!datatype) return undefined;
        text += `^^${datatype.text}`;
        this.i += 2;
      }
      return { kind: 'atom', text };
    }

    return undefined;
  }

  private next(): TurtleToken | undefined {
    while (this.tokens[this.i]?.type === 'comment') this.i++;
    return this.tokens[this.i++];
  }

  private consumeOptionalDot(): void {
    while (this.tokens[this.i]?.type === 'comment') this.i++;
    const tok = this.tokens[this.i];
    if (tok?.type === 'punct' && tok.text === '.') this.i++;
  }
}
