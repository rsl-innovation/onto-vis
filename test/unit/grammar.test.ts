import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as oniguruma from 'vscode-oniguruma';
import * as vsctm from 'vscode-textmate';

/**
 * Tokenizes with the same engine VS Code uses, so these assertions reflect what a
 * user actually sees rather than what the JSON looks like.
 */
let grammar: vsctm.IGrammar;

beforeAll(async () => {
  const wasm = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer as ArrayBuffer);

  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
      createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scopeName) => {
      if (scopeName !== 'source.turtle') return null;
      const path = resolve(process.cwd(), 'syntaxes/turtle.tmLanguage.json');
      return vsctm.parseRawGrammar(readFileSync(path, 'utf8'), path);
    },
  });

  const loaded = await registry.loadGrammar('source.turtle');
  if (!loaded) throw new Error('turtle grammar failed to load');
  grammar = loaded;
});

/** All scopes applied at a character offset on a single line. */
function scopesAt(line: string, character: number): string[] {
  const result = grammar.tokenizeLine(line, vsctm.INITIAL);
  const token = result.tokens.find((t) => character >= t.startIndex && character < t.endIndex);
  return token?.scopes ?? [];
}

function hasScope(line: string, character: number, prefix: string): boolean {
  return scopesAt(line, character).some((s) => s.startsWith(prefix));
}

describe('turtle TextMate grammar', () => {
  it('loads without error', () => {
    expect(grammar).toBeDefined();
  });

  it('scopes @prefix as a directive keyword', () => {
    const line = '@prefix ex: <http://example.org/> .';
    expect(hasScope(line, 2, 'keyword.control.directive.prefix')).toBe(true);
  });

  it('scopes the SPARQL-style PREFIX keyword too', () => {
    const line = 'PREFIX ex: <http://example.org/>';
    expect(hasScope(line, 2, 'keyword.control.directive.prefix')).toBe(true);
  });

  it('does not mistake base: for a BASE directive', () => {
    const line = 'base:Thing a base:Other .';
    expect(hasScope(line, 1, 'keyword.control.directive')).toBe(false);
    expect(hasScope(line, 1, 'entity.name.namespace')).toBe(true);
  });

  it('scopes IRIs as strings and keeps # inside them out of comments', () => {
    const line = '<http://example.org/v#Thing> a ex:C .';
    expect(hasScope(line, 5, 'string.quoted.other.iri')).toBe(true);
    // The '#' is at index 21 and must NOT start a comment.
    expect(hasScope(line, 21, 'comment')).toBe(false);
    expect(hasScope(line, 21, 'string.quoted.other.iri')).toBe(true);
  });

  it('keeps # inside a string literal out of comments', () => {
    const line = 'ex:A ex:p "value # not a comment" .';
    expect(hasScope(line, 18, 'comment')).toBe(false);
    expect(hasScope(line, 18, 'string.quoted.double')).toBe(true);
  });

  it('scopes a real comment', () => {
    const line = '# this is a comment';
    expect(hasScope(line, 4, 'comment.line.number-sign')).toBe(true);
  });

  it('scopes the `a` keyword but not the `a` inside a name', () => {
    const line = 'ex:A a ex:B .';
    expect(hasScope(line, 5, 'keyword.other.rdf-type')).toBe(true);

    const named = 'ex:apple a ex:B .';
    expect(hasScope(named, 3, 'keyword.other.rdf-type')).toBe(false);
  });

  it('gives well-known vocabularies their own scope', () => {
    const line = 'ex:A rdfs:label "x" .';
    expect(hasScope(line, 6, 'support.type.vocabulary')).toBe(true);

    const custom = 'ex:A myns:label "x" .';
    expect(hasScope(custom, 6, 'support.type.vocabulary')).toBe(false);
    expect(hasScope(custom, 6, 'entity.name.namespace')).toBe(true);
  });

  it('scopes language tags and datatype markers', () => {
    const lang = 'ex:A ex:p "hi"@en .';
    expect(hasScope(lang, 15, 'constant.language')).toBe(true);

    const typed = 'ex:A ex:p "42"^^xsd:integer .';
    expect(hasScope(typed, 14, 'keyword.operator.datatype')).toBe(true);
  });

  it('scopes numbers and booleans', () => {
    expect(hasScope('ex:A ex:p 42 .', 10, 'constant.numeric')).toBe(true);
    expect(hasScope('ex:A ex:p 2.5 .', 10, 'constant.numeric')).toBe(true);
    expect(hasScope('ex:A ex:p true .', 10, 'constant.language.boolean')).toBe(true);
  });

  it('scopes blank nodes', () => {
    expect(hasScope('_:b1 ex:p ex:o .', 2, 'variable.other.blank-node')).toBe(true);
  });

  it('handles a triple-quoted string spanning lines without leaking scope', () => {
    const first = grammar.tokenizeLine('ex:A ex:p """line one', vsctm.INITIAL);
    const second = grammar.tokenizeLine('still string # not comment"""', first.ruleStack);
    const token = second.tokens.find((t) => 13 >= t.startIndex && 13 < t.endIndex);
    expect(token?.scopes.some((s) => s.startsWith('string.quoted.triple'))).toBe(true);

    // After the closing delimiter, normal scoping resumes.
    const third = grammar.tokenizeLine('# a real comment', second.ruleStack);
    expect(third.tokens[0].scopes.some((s) => s.startsWith('comment'))).toBe(true);
  });
});
