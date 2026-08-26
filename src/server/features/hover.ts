import { localName, splitIri } from '../core/text.js';
import { lookupVocabTerm } from '../core/vocab.js';
import type { WorkspaceIndex } from '../core/workspaceIndex.js';
import type { Position, Range } from '../core/types.js';

export interface HoverResult {
  markdown: string;
  range: Range;
}

const KIND_LABELS: Record<string, string> = {
  class: 'Class',
  objectProperty: 'Object property',
  datatypeProperty: 'Datatype property',
  annotationProperty: 'Annotation property',
  property: 'Property',
  individual: 'Individual',
  datatype: 'Datatype',
  ontology: 'Ontology',
  unknown: 'Resource',
};

/**
 * Documentation for the term under the cursor.
 *
 * Prefers what the workspace itself asserts (rdfs:label, rdfs:comment) and falls
 * back to built-in vocabulary knowledge, so hovering `rdfs:subClassOf` is useful
 * even in a file that never defines it.
 */
export function hover(index: WorkspaceIndex, uri: string, position: Position): HoverResult | undefined {
  const occ = index.occurrenceAt(uri, position);
  if (!occ) return undefined;

  if (occ.iri.startsWith('_:')) {
    return {
      range: occ.range,
      markdown: `**Blank node** \`${occ.iri}\`\n\nAn anonymous resource, local to this file.`,
    };
  }

  const info = index.info(occ.iri);
  const kind = index.kind(occ.iri);
  const label = index.label(occ.iri);
  const comment = index.comment(occ.iri);
  const name = label ?? localName(occ.iri);

  const lines: string[] = [];
  lines.push(`**${name}** · _${KIND_LABELS[kind] ?? 'Resource'}_`);
  lines.push('');
  lines.push('```turtle');
  lines.push(`<${occ.iri}>`);
  lines.push('```');

  if (comment) {
    lines.push('');
    lines.push(comment);
  }

  const facts: string[] = [];
  if (info.superClasses.size > 0) {
    facts.push(`Subclass of ${[...info.superClasses].map(codeName).join(', ')}`);
  }
  if (info.domains.size > 0) facts.push(`Domain: ${[...info.domains].map(codeName).join(', ')}`);
  if (info.ranges.size > 0) facts.push(`Range: ${[...info.ranges].map(codeName).join(', ')}`);
  if (facts.length > 0) {
    lines.push('');
    for (const f of facts) lines.push(`- ${f}`);
  }

  const definitions = index.definitions(occ.iri);
  if (definitions.length > 0) {
    const files = [...new Set(definitions.map((d) => d.uri.split('/').pop()))];
    lines.push('');
    lines.push(
      `_Defined in ${files.slice(0, 3).map((f) => `\`${f}\``).join(', ')}${
        files.length > 3 ? ` and ${files.length - 3} more` : ''
      }_`
    );
  } else if (lookupVocabTerm(occ.iri)) {
    lines.push('');
    lines.push('_From a built-in vocabulary_');
  }

  return { markdown: lines.join('\n'), range: occ.range };
}

function codeName(iri: string): string {
  return `\`${localName(iri) || splitIri(iri).local || iri}\``;
}
