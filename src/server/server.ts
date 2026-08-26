import {
  createConnection,
  DidChangeConfigurationNotification,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { parseDocument } from './core/document.js';
import { detectFormat, isRdfFile } from './core/formats.js';
import { WorkspaceIndex } from './core/workspaceIndex.js';
import { buildGraphModel } from './core/graphModel.js';
import type { GraphView } from './core/graphModel.js';
import { allDiagnostics } from './features/diagnostics.js';
import { hover } from './features/hover.js';
import { complete } from './features/completion.js';
import { documentSymbols, workspaceSymbols } from './features/symbols.js';
import { semanticTokens, TOKEN_MODIFIERS, TOKEN_TYPES } from './features/semanticTokens.js';
import { formatTurtle, DEFAULT_FORMAT_OPTIONS } from './features/formatting.js';
import { tokenizeTurtle } from './formats/turtle/scan.js';
import {
  computeRename,
  findDefinitions,
  findReferences,
  prepareRename,
} from './features/navigation.js';
import { isTurtleFamily } from './core/types.js';
import type { ParsedDocument } from './core/types.js';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const index = new WorkspaceIndex();

interface Settings {
  workspace: { enabled: boolean; maxFiles: number; exclude: string[] };
  preview: { maxNodes: number; defaultView: GraphView; showIndividuals: boolean };
  format: { indent: number; alignPredicates: boolean };
}

let settings: Settings = {
  workspace: { enabled: true, maxFiles: 2000, exclude: ['**/node_modules/**', '**/.git/**'] },
  preview: { maxNodes: 2000, defaultView: 'ontology', showIndividuals: false },
  format: { indent: 4, alignPredicates: true },
};

let workspaceFolders: string[] = [];

connection.onInitialize((params) => {
  workspaceFolders = (params.workspaceFolders ?? [])
    .map((f) => URI.parse(f.uri).fsPath)
    .filter(Boolean);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      documentFormattingProvider: true,
      renameProvider: { prepareProvider: true },
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: [':', '@', '<', '"', '#', '/'],
      },
      semanticTokensProvider: {
        legend: { tokenTypes: [...TOKEN_TYPES], tokenModifiers: [...TOKEN_MODIFIERS] },
        full: true,
      },
    },
  };
});

connection.onInitialized(async () => {
  await connection.client.register(DidChangeConfigurationNotification.type, undefined);
  await refreshSettings();
  if (settings.workspace.enabled) await indexWorkspace();
});

connection.onDidChangeConfiguration(async () => {
  await refreshSettings();
  await revalidateOpenDocuments();
});

async function refreshSettings(): Promise<void> {
  try {
    const raw = await connection.workspace.getConfiguration('rdf');
    if (raw) settings = { ...settings, ...raw };
  } catch {
    // Client does not support configuration requests; defaults are fine.
  }
}

// --- document lifecycle ---------------------------------------------------

documents.onDidChangeContent(async (event) => {
  await analyse(event.document);
});

documents.onDidClose((event) => {
  // The on-disk copy still belongs in the index, so re-read it rather than drop it.
  void reindexFromDisk(event.document.uri);
});

async function analyse(doc: TextDocument): Promise<ParsedDocument | undefined> {
  const text = doc.getText();
  const format = detectFormat(doc.uri, doc.languageId, text);
  const parsed = await parseDocument(doc.uri, text, format);
  index.upsert(parsed);
  connection.sendDiagnostics({ uri: doc.uri, diagnostics: allDiagnostics(parsed) as never[] });
  return parsed;
}

async function revalidateOpenDocuments(): Promise<void> {
  for (const doc of documents.all()) await analyse(doc);
}

async function reindexFromDisk(uri: string): Promise<void> {
  try {
    const fsPath = URI.parse(uri).fsPath;
    const text = await fs.readFile(fsPath, 'utf8');
    const format = detectFormat(uri, undefined, text);
    index.upsert(await parseDocument(uri, text, format));
  } catch {
    index.remove(uri);
  }
}

/** Walks the workspace once at startup so cross-file navigation works immediately. */
async function indexWorkspace(): Promise<void> {
  let count = 0;
  for (const folder of workspaceFolders) {
    for await (const file of walk(folder)) {
      if (count >= settings.workspace.maxFiles) {
        connection.console.warn(
          `RDF: stopped indexing at ${settings.workspace.maxFiles} files (rdf.workspace.maxFiles).`
        );
        return;
      }
      if (!isRdfFile(file)) continue;
      const uri = URI.file(file).toString();
      if (index.has(uri)) continue;
      try {
        const text = await fs.readFile(file, 'utf8');
        index.upsert(await parseDocument(uri, text, detectFormat(uri, undefined, text)));
        count++;
      } catch {
        // Unreadable file; skip it rather than failing the whole index.
      }
    }
  }
  connection.console.log(`RDF: indexed ${count} file(s).`);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.vscode-test', 'coverage']);

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

// --- feature handlers -----------------------------------------------------

/** Ensures the index reflects the current buffer before answering a request. */
async function current(uri: string): Promise<ParsedDocument | undefined> {
  const open = documents.get(uri);
  if (open && !index.has(uri)) return analyse(open);
  return index.document(uri);
}

connection.onHover(async (params) => {
  await current(params.textDocument.uri);
  const result = hover(index, params.textDocument.uri, params.position);
  if (!result) return null;
  return {
    contents: { kind: 'markdown' as const, value: result.markdown },
    range: result.range,
  };
});

connection.onDefinition(async (params) => {
  await current(params.textDocument.uri);
  return findDefinitions(index, params.textDocument.uri, params.position) as never;
});

connection.onReferences(async (params) => {
  await current(params.textDocument.uri);
  return findReferences(
    index,
    params.textDocument.uri,
    params.position,
    params.context?.includeDeclaration ?? true
  ) as never;
});

connection.onDocumentSymbol(async (params) => {
  const doc = await current(params.textDocument.uri);
  if (!doc) return [];
  return documentSymbols(index, doc) as never;
});

connection.onWorkspaceSymbol((params) => workspaceSymbols(index, params.query) as never);

connection.onCompletion(async (params) => {
  const doc = await current(params.textDocument.uri);
  const open = documents.get(params.textDocument.uri);
  if (!doc || !open) return [];
  return complete(index, doc, open.getText(), params.position) as never;
});

connection.languages.semanticTokens.on(async (params) => {
  const doc = await current(params.textDocument.uri);
  if (!doc) return { data: [] };
  return { data: semanticTokens(index, doc) };
});

connection.onPrepareRename(async (params) => {
  await current(params.textDocument.uri);
  const result = prepareRename(index, params.textDocument.uri, params.position, textOf);
  if ('error' in result) throw new Error(result.error);
  return { range: result.range, placeholder: result.placeholder };
});

connection.onRenameRequest(async (params) => {
  await current(params.textDocument.uri);
  // Every affected file must be readable before we touch any of them.
  await loadReferencedDocuments(params.textDocument.uri, params.position);

  const result = computeRename(
    index,
    params.textDocument.uri,
    params.position,
    params.newName,
    textOf
  );
  if (!result.ok) throw new Error(result.reason);

  const changes: Record<string, unknown[]> = {};
  for (const [uri, edits] of result.edits) changes[uri] = edits;
  return { changes } as never;
});

connection.onDocumentFormatting(async (params) => {
  const doc = await current(params.textDocument.uri);
  const open = documents.get(params.textDocument.uri);
  if (!doc || !open) return [];
  if (!isTurtleFamily(doc.format)) return []; // XML formatting belongs to XML tooling

  const text = open.getText();
  const formatted = formatTurtle(tokenizeTurtle(text), {
    ...DEFAULT_FORMAT_OPTIONS,
    indent: params.options?.tabSize ?? settings.format.indent,
  });
  if (formatted === undefined || formatted === text) return [];

  const lastLine = text.split(/\r\n|\r|\n/).length;
  return [
    {
      range: { start: { line: 0, character: 0 }, end: { line: lastLine, character: 0 } },
      newText: formatted,
    },
  ] as never;
});

// --- custom requests ------------------------------------------------------

interface GraphRequest {
  uri: string;
  view?: GraphView;
  scope?: 'file' | 'workspace';
  showIndividuals?: boolean;
}

connection.onRequest('rdf/graph', async (params: GraphRequest) => {
  const doc = await current(params.uri);
  if (!doc) return null;

  const useWorkspace = params.scope === 'workspace';
  const quads = useWorkspace ? index.allQuads() : doc.quads;
  const sources = useWorkspace ? index.documents().map((d) => d.uri) : [doc.uri];

  const prefixes: Record<string, string> = { ...doc.prefixes };
  if (useWorkspace) {
    for (const other of index.documents()) Object.assign(prefixes, other.prefixes, doc.prefixes);
  }

  return buildGraphModel(quads, index, sources, {
    view: params.view ?? settings.preview.defaultView,
    maxNodes: settings.preview.maxNodes,
    showIndividuals: params.showIndividuals ?? settings.preview.showIndividuals,
    prefixes,
  });
});

connection.onRequest('rdf/reindex', async () => {
  index.clear();
  await indexWorkspace();
  await revalidateOpenDocuments();
  return { files: index.size };
});

/** Locates the term's range in whichever file the cursor is in. */
connection.onRequest('rdf/locate', async (params: { uri: string; iri: string }) => {
  await current(params.uri);
  return index.primaryLocation(params.iri) ?? null;
});

/** The IRI under a cursor position, used to sync the preview's selection. */
connection.onRequest(
  'rdf/termAt',
  async (params: { uri: string; position: { line: number; character: number } }) => {
    await current(params.uri);
    const occ = index.occurrenceAt(params.uri, params.position);
    return occ ? { iri: occ.iri, range: occ.range } : null;
  }
);

// --- helpers --------------------------------------------------------------

const diskCache = new Map<string, string>();

function textOf(uri: string): string | undefined {
  return documents.get(uri)?.getText() ?? diskCache.get(uri);
}

/**
 * Reads every file a rename would touch into memory first.
 *
 * Rename refuses outright if any file is unavailable, so loading them up front
 * turns "half the workspace renamed" into "nothing renamed".
 */
async function loadReferencedDocuments(uri: string, position: { line: number; character: number }) {
  const occ = index.occurrenceAt(uri, position);
  if (!occ) return;
  for (const location of index.references(occ.iri)) {
    if (documents.get(location.uri) || diskCache.has(location.uri)) continue;
    try {
      const text = await fs.readFile(URI.parse(location.uri).fsPath, 'utf8');
      diskCache.set(location.uri, text);
    } catch {
      // Leave it missing; computeRename will refuse rather than partially apply.
    }
  }
}

documents.onDidSave((event) => diskCache.delete(event.document.uri));
documents.onDidClose((event) => diskCache.delete(event.document.uri));

documents.listen(connection);
connection.listen();
