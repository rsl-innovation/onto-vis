/**
 * `cytoscape-fcose` ships no type declarations. Both layout plugins are used
 * only through `cytoscape.use()`, so a minimal shape is enough.
 */
declare module 'cytoscape-fcose' {
  import type { Ext } from 'cytoscape';
  const extension: Ext;
  export default extension;
}
