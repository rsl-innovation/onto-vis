import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../../src/server/formats/turtle/parse.js';
import { scanTurtle, tokenizeTurtle } from '../../src/server/formats/turtle/scan.js';
import { LineMap } from '../../src/server/core/text.js';

const BASE = 'http://example.org/doc';

function run(text: string) {
  const tokens = tokenizeTurtle(text);
  const lines = new LineMap(text);
  return parseTurtle(text, tokens, lines, BASE, 'turtle');
}

describe('parseTurtle', () => {
  it('parses a clean document into quads', () => {
    const text = ['@prefix ex: <http://example.org/> .', 'ex:A a ex:B ;', '    ex:p "v" .'].join('\n');
    const r = run(text);
    expect(r.diagnostics).toHaveLength(0);
    expect(r.quads).toHaveLength(2);
    expect(r.quads[0].subject.value).toBe('http://example.org/A');
  });

  it('RECOVERY: reports several syntax errors in one pass, not just the first', () => {
    const text = [
      '@prefix ex: <http://example.org/> .',
      'ex:A a ex:B .',
      'ex:BROKEN !!! bad .',
      'ex:C ex:d ex:E .',
      'ex:F ex:g @@@ .',
      'ex:H ex:i ex:J .',
    ].join('\n');
    const r = run(text);

    const syntax = r.diagnostics.filter((d) => d.code === 'syntax');
    expect(syntax.length).toBeGreaterThanOrEqual(2);

    // And the statements that were fine still produced quads.
    const subjects = r.quads.map((q) => q.subject.value);
    expect(subjects).toContain('http://example.org/A');
    expect(subjects).toContain('http://example.org/C');
    expect(subjects).toContain('http://example.org/H');
  });

  it('anchors a syntax error on the offending token, not the whole line', () => {
    const text = ['@prefix ex: <http://example.org/> .', 'ex:A !!! ex:B .'].join('\n');
    const r = run(text);
    const d = r.diagnostics.find((x) => x.code === 'syntax')!;
    expect(d).toBeDefined();
    expect(d.range.start.line).toBe(1);
    // The range must be tight around `!!!`, not span the entire statement.
    const width = d.range.end.character - d.range.start.character;
    expect(width).toBeLessThanOrEqual(4);
  });

  it('keeps prefixes in scope for statements after a broken one', () => {
    const text = [
      '@prefix ex: <http://example.org/> .',
      'ex:BAD !!! .',
      'ex:Good a ex:Thing .',
    ].join('\n');
    const r = run(text);
    // ex: still resolved for the later statement despite the earlier failure.
    expect(r.quads.some((q) => q.subject.value === 'http://example.org/Good')).toBe(true);
  });

  it('does not duplicate the undefined-prefix error the scanner already reports', () => {
    const text = 'ex:A a ex:B .';
    const parsed = run(text);
    const scanned = scanTurtle(text, BASE);
    expect(parsed.diagnostics.some((d) => /Undefined prefix/i.test(d.message))).toBe(false);
    expect(scanned.diagnostics.some((d) => d.code === 'undefined-prefix')).toBe(true);
  });

  it('terminates instead of spinning on a pathologically broken file', () => {
    const text = '@prefix ex: <http://example.org/> .\n' + 'ex:A !!! .\n'.repeat(200);
    const started = Date.now();
    const r = run(text);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.diagnostics.some((d) => d.code === 'too-many-errors')).toBe(true);
  });

  it('captures literals with datatype and language', () => {
    const text = [
      '@prefix ex: <http://example.org/> .',
      '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
      'ex:A ex:label "hi"@en ; ex:age "42"^^xsd:integer .',
    ].join('\n');
    const r = run(text);
    const lang = r.quads.find((q) => q.object.language === 'en');
    const typed = r.quads.find((q) => q.object.datatype?.endsWith('integer'));
    expect(lang?.object.value).toBe('hi');
    expect(typed?.object.value).toBe('42');
  });
});
