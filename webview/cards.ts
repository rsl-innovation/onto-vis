/**
 * Node rendering.
 *
 * Class nodes are drawn as UML-style cards: a header band with the class name,
 * a rule, then aligned attribute rows with their datatypes. Cytoscape paints
 * labels as plain canvas text, which cannot give us a header band, a separator,
 * or a right-aligned second column — so each card is generated as an SVG and
 * handed to Cytoscape as the node's background image.
 *
 * Everything else (literals, blank nodes, bare resources) stays a simple pill:
 * a card implies structure those terms do not have.
 */

export interface Theme {
  surface: string;
  surfaceRaised: string;
  border: string;
  borderStrong: string;
  foreground: string;
  muted: string;
  accent: string;
  class: string;
  objectProperty: string;
  datatypeProperty: string;
  individual: string;
  literal: string;
  blank: string;
}

export interface CardNode {
  id: string;
  label: string;
  kind: string;
  curie?: string;
  attributes?: Array<{ label: string; datatype: string; iri: string }>;
}

export interface Card {
  uri: string;
  width: number;
  height: number;
}

/** One family, matching the host's UI font, so the diagram reads as part of VS Code. */
const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Helvetica Neue", Arial, sans-serif';

const HEADER_FONT = `600 13px ${FONT_STACK}`;
const ROW_FONT = `400 11.5px ${FONT_STACK}`;
const TYPE_FONT = `400 11.5px ${FONT_STACK}`;
const PILL_FONT = `500 12px ${FONT_STACK}`;

const PAD_X = 12;
const HEADER_H = 30;
const ROW_H = 19;
const ROWS_PAD = 7;
const RADIUS = 6;
const MIN_W = 148;
const MAX_W = 288;
const COL_GAP = 18;
const MAX_ROWS = 6;

const measureCtx = (() => {
  const canvas = document.createElement('canvas');
  return canvas.getContext('2d')!;
})();

function widthOf(text: string, font: string): number {
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** Trims to fit, with an ellipsis, so a long label never overruns its card. */
function ellipsize(text: string, font: string, max: number): string {
  if (widthOf(text, font) <= max) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (widthOf(`${text.slice(0, mid)}…`, font) <= max) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low)}…`;
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Restriction rows read as constraints, not fields, so they are set apart. */
function isRestrictionRow(attr: { datatype: string }): boolean {
  return attr.datatype === '';
}

/**
 * Builds a node's artwork.
 *
 * There is deliberately no "selected" variant: Cytoscape will not repaint a node
 * whose background image is swapped in place, so selection is expressed through
 * style properties instead and the artwork for a node never changes.
 */
export function buildCard(node: CardNode, theme: Theme): Card {
  if (node.kind === 'literal' || node.kind === 'blank' || node.kind === 'resource') {
    return buildPill(node, theme);
  }
  return buildClassCard(node, theme);
}

function accentFor(kind: string, theme: Theme): string {
  switch (kind) {
    case 'individual':
      return theme.individual;
    case 'objectProperty':
      return theme.objectProperty;
    case 'datatypeProperty':
      return theme.datatypeProperty;
    default:
      return theme.class;
  }
}

function buildClassCard(node: CardNode, theme: Theme): Card {
  const attrs = node.attributes ?? [];
  const shown = attrs.slice(0, MAX_ROWS);
  const overflow = attrs.length - shown.length;

  // --- size from content, then clamp and ellipsize to fit --------------------
  const headerRaw = node.label || node.curie || node.id;
  let width = Math.max(MIN_W, widthOf(headerRaw, HEADER_FONT) + PAD_X * 2 + 14);
  for (const a of shown) {
    const w =
      widthOf(a.label, ROW_FONT) + widthOf(a.datatype, TYPE_FONT) + PAD_X * 2 + COL_GAP;
    width = Math.max(width, w);
  }
  if (overflow > 0) {
    width = Math.max(width, widthOf(`${overflow} more…`, ROW_FONT) + PAD_X * 2);
  }
  width = Math.min(MAX_W, Math.ceil(width));

  const rowCount = shown.length + (overflow > 0 ? 1 : 0);
  const bodyH = rowCount > 0 ? rowCount * ROW_H + ROWS_PAD * 2 : 0;
  const height = HEADER_H + bodyH;

  const accent = accentFor(node.kind, theme);
  const border = theme.border;
  const borderWidth = 1;
  const inset = borderWidth / 2;

  const header = ellipsize(headerRaw, HEADER_FONT, width - PAD_X * 2 - 12);

  const parts: string[] = [];

  // Card body.
  parts.push(
    `<rect x="${inset}" y="${inset}" width="${width - borderWidth}" height="${
      height - borderWidth
    }" rx="${RADIUS}" fill="${theme.surface}" stroke="${border}" stroke-width="${borderWidth}"/>`
  );

  // Header band: clipped to the card's top corners so the radius stays true.
  parts.push(
    `<clipPath id="h"><rect x="${inset}" y="${inset}" width="${width - borderWidth}" height="${
      height - borderWidth
    }" rx="${RADIUS}"/></clipPath>`,
    `<g clip-path="url(#h)">`,
    `<rect x="0" y="0" width="${width}" height="${HEADER_H}" fill="${accent}" fill-opacity="0.15"/>`,
    `</g>`
  );

  if (rowCount > 0) {
    parts.push(
      `<line x1="${inset}" y1="${HEADER_H}" x2="${width - inset}" y2="${HEADER_H}" stroke="${
        theme.border
      }" stroke-width="1"/>`
    );
  }

  // Kind dot: the only colour in the header, doubling as the legend key.
  parts.push(
    `<circle cx="${PAD_X + 3}" cy="${HEADER_H / 2}" r="3.5" fill="${accent}"/>`,
    `<text x="${PAD_X + 13}" y="${HEADER_H / 2}" fill="${theme.foreground}" font-family="${esc(
      FONT_STACK
    )}" font-size="13" font-weight="600" dominant-baseline="central">${esc(header)}</text>`
  );

  // Attribute rows: name left, datatype right.
  shown.forEach((attr, i) => {
    const y = HEADER_H + ROWS_PAD + i * ROW_H + ROW_H / 2;
    const restriction = isRestrictionRow(attr);
    const typeW = restriction ? 0 : widthOf(attr.datatype, TYPE_FONT);
    const nameMax = width - PAD_X * 2 - typeW - (restriction ? 0 : COL_GAP);
    const name = ellipsize(attr.label, ROW_FONT, nameMax);

    parts.push(
      `<text x="${PAD_X}" y="${y}" fill="${
        restriction ? theme.muted : theme.foreground
      }" font-family="${esc(FONT_STACK)}" font-size="11.5"${
        restriction ? ' font-style="italic"' : ''
      } dominant-baseline="central">${esc(name)}</text>`
    );
    if (!restriction) {
      parts.push(
        `<text x="${width - PAD_X}" y="${y}" fill="${theme.muted}" font-family="${esc(
          FONT_STACK
        )}" font-size="11.5" text-anchor="end" dominant-baseline="central">${esc(
          attr.datatype
        )}</text>`
      );
    }
  });

  if (overflow > 0) {
    const y = HEADER_H + ROWS_PAD + shown.length * ROW_H + ROW_H / 2;
    parts.push(
      `<text x="${PAD_X}" y="${y}" fill="${theme.muted}" font-family="${esc(
        FONT_STACK
      )}" font-size="11.5" dominant-baseline="central">${overflow} more…</text>`
    );
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join(
    ''
  )}</svg>`;

  return { uri: toDataUri(svg), width, height };
}

/** Literals, blank nodes and bare resources: a pill, not a card. */
function buildPill(node: CardNode, theme: Theme): Card {
  const text = ellipsize(node.label || node.id, PILL_FONT, MAX_W - PAD_X * 2);
  const width = Math.max(72, Math.ceil(widthOf(text, PILL_FONT) + PAD_X * 2 + 8));
  const height = 30;

  const fill =
    node.kind === 'literal' ? theme.literal : node.kind === 'blank' ? theme.blank : theme.class;
  const border = fill;
  const borderWidth = 1;
  const inset = borderWidth / 2;
  const dashed = node.kind === 'blank' ? ' stroke-dasharray="3 3"' : '';
  const italic = node.kind === 'literal' ? ' font-style="italic"' : '';

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect x="${inset}" y="${inset}" width="${width - borderWidth}" height="${
      height - borderWidth
    }" rx="${height / 2}" fill="${fill}" fill-opacity="0.13" stroke="${border}" stroke-width="${borderWidth}"${dashed}/>` +
    `<text x="${width / 2}" y="${height / 2}" fill="${theme.foreground}" font-family="${esc(
      FONT_STACK
    )}" font-size="12" font-weight="500"${italic} text-anchor="middle" dominant-baseline="central">${esc(
      text
    )}</text>` +
    `</svg>`;

  return { uri: toDataUri(svg), width, height };
}
