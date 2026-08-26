import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';

import { PreviewPanel, isRdfDocument } from './preview/previewPanel.js';

const RDF_LANGUAGES = ['turtle', 'ntriples', 'nquads', 'trig', 'n3', 'rdfxml'];

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6019'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: RDF_LANGUAGES.map((language) => ({ scheme: 'file', language })),
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{ttl,turtle,nt,nq,trig,n3,rdf,rdfs,owl}'),
    },
    outputChannelName: 'RDF Language Server',
  };

  client = new LanguageClient('rdf', 'RDF Language Server', serverOptions, clientOptions);
  await client.start();
  context.subscriptions.push({ dispose: () => void client?.stop() });

  const activeRdfUri = (): string | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (editor && isRdfDocument(editor.document)) return editor.document.uri.toString();
    // Fall back to any visible RDF editor, so the command still works when focus
    // is already in the preview panel.
    const visible = vscode.window.visibleTextEditors.find((e) => isRdfDocument(e.document));
    return visible?.document.uri.toString();
  };

  const showPreview = (column: vscode.ViewColumn) => () => {
    const uri = activeRdfUri();
    if (!uri) {
      vscode.window.showInformationMessage('Open a Turtle, RDF/XML or OWL file to preview its graph.');
      return;
    }
    PreviewPanel.show(context, client!, uri, column);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('rdf.showPreview', showPreview(vscode.ViewColumn.Active)),
    vscode.commands.registerCommand('rdf.showPreviewToSide', showPreview(vscode.ViewColumn.Beside)),
    vscode.commands.registerCommand('rdf.reindexWorkspace', async () => {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Re-indexing RDF files…' },
        () => client!.sendRequest<{ files: number }>('rdf/reindex', {})
      );
      vscode.window.showInformationMessage(`RDF: indexed ${result.files} file(s).`);
    })
  );

  // Restore the preview after a window reload.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(PreviewPanel.viewType, {
      async deserializeWebviewPanel(panel, state) {
        PreviewPanel.revive(panel, context, client!, state);
      },
    })
  );
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}
