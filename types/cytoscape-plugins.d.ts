/**
 * Neither layout plugin ships type declarations. Both are used only through
 * `cytoscape.use()`, so a minimal shape is enough.
 */
declare module 'cytoscape-fcose' {
  import type { Ext } from 'cytoscape';
  const extension: Ext;
  export default extension;
}

declare module 'cytoscape-elk' {
  import type { Ext } from 'cytoscape';
  const extension: Ext;
  export default extension;
}
