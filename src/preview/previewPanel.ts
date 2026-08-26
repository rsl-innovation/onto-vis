import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

export type GraphView = 'ontology' | 'triples';
export type GraphScope = 'file' | 'workspace';

interface PanelState {
  uri: string;
  view: GraphView;
  scope: GraphScope;
  showIndividuals: boolean;
}

/** Debounce for re-rendering as the user types. Long enough to not thrash, short enough to feel live. */
const REFRESH_DELAY_MS = 300;

/**
 * The ontology graph preview.
 *
 * A single panel is reused across documents, mirroring how Markdown preview
 * behaves. The panel never parses anything itself — it asks the language server,
 * which already holds the parsed workspace, so the graph can never disagree with
 * the squiggles in the editor.
 */
export class PreviewPanel {
  private static current: PreviewPanel | undefined;

  static readonly viewType = 'rdf.graphPreview';

  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private state: PanelState;
  private ready = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly client: LanguageClient,
    initial: PanelState
  ) {
    this.state = initial;
    this.panel.webview.html = this.html();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);

    // Live sync: re-render as the document changes, and follow the active editor.
    vscode.workspace.onDidChangeTextDocument(
      (e) => {
        if (e.document.uri.toString() === this.state.uri) this.scheduleRefresh();
      },
      null,
      this.disposables
    );

    vscode.window.onDidChangeActiveTextEditor(
      (editor) => {
        if (!editor || !isRdfDocument(editor.document)) return;
        const uri = editor.document.uri.toString();
        if (uri === this.state.uri) return;
        this.state = { ...this.state, uri };
        this.panel.title = `Graph: ${shortName(uri)}`;
        this.scheduleRefresh();
      },
      null,
      this.disposables
    );

    // Selection sync: moving the cursor highlights the matching node.
    vscode.window.onDidChangeTextEditorSelection(
      (e) => {
        if (e.textEditor.document.uri.toString() !== this.state.uri) return;
        void this.highlightAtCursor(e.textEditor);
      },
      null,
      this.disposables
    );
  }

  static show(
    context: vscode.ExtensionContext,
    client: LanguageClient,
    uri: string,
    column: vscode.ViewColumn
  ): void {
    if (PreviewPanel.current) {
      PreviewPanel.current.panel.reveal(column, true);
      PreviewPanel.current.state = { ...PreviewPanel.current.state, uri };
      PreviewPanel.current.panel.title = `Graph: ${shortName(uri)}`;
      void PreviewPanel.current.refresh();
      return;
    }

    const config = vscode.workspace.getConfiguration('rdf');
    const panel = vscode.window.createWebviewPanel(
      PreviewPanel.viewType,
      `Graph: ${shortName(uri)}`,
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      }
    );

    PreviewPanel.current = new PreviewPanel(panel, context, client, {
      uri,
      view: config.get<GraphView>('preview.defaultView', 'ontology'),
      scope: 'file',
      showIndividuals: config.get<boolean>('preview.showIndividuals', false),
    });
  }

  /** Restores the panel after a window reload. Serialized state is untrusted. */
  static revive(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    client: LanguageClient,
    state: unknown
  ): void {
    const saved = (typeof state === 'object' && state !== null ? state : {}) as Partial<PanelState>;
    const uri =
      typeof saved.uri === 'string' && saved.uri
        ? saved.uri
        : (vscode.window.activeTextEditor?.document.uri.toString() ?? '');
    PreviewPanel.current = new PreviewPanel(panel, context, client, {
      uri,
      view: saved.view === 'triples' ? 'triples' : 'ontology',
      scope: saved.scope === 'workspace' ? 'workspace' : 'file',
      showIndividuals: saved.showIndividuals === true,
    });
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), REFRESH_DELAY_MS);
  }

  private async refresh(): Promise<void> {
    if (!this.ready || !this.state.uri) return;
    try {
      const model = await this.client.sendRequest('rdf/graph', {
        uri: this.state.uri,
        view: this.state.view,
        scope: this.state.scope,
        showIndividuals: this.state.showIndividuals,
      });
      if (!model) return;
      await this.panel.webview.postMessage({ type: 'graph', model, state: this.state });
    } catch (err) {
      await this.panel.webview.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Asks the server which term the cursor sits on, then highlights that node. */
  private async highlightAtCursor(editor: vscode.TextEditor): Promise<void> {
    if (!this.ready) return;
    try {
      const term = await this.client.sendRequest<{ iri: string } | null>('rdf/termAt', {
        uri: editor.document.uri.toString(),
        position: {
          line: editor.selection.active.line,
          character: editor.selection.active.character,
        },
      });
      await this.panel.webview.postMessage({ type: 'highlight', iri: term?.iri ?? null });
    } catch {
      // Selection sync is a convenience; never surface a failure for it.
    }
  }

  private async onMessage(message: any): Promise<void> {
    switch (message?.type) {
      case 'ready':
        this.ready = true;
        await this.refresh();
        break;

      case 'setView':
        this.state = { ...this.state, view: message.view };
        await this.refresh();
        break;

      case 'setScope':
        this.state = { ...this.state, scope: message.scope };
        await this.refresh();
        break;

      case 'setShowIndividuals':
        this.state = { ...this.state, showIndividuals: !!message.value };
        await this.refresh();
        break;

      case 'reveal':
        await revealLocation(message.location);
        break;

      case 'copy':
        await vscode.env.clipboard.writeText(String(message.text ?? ''));
        vscode.window.setStatusBarMessage('Copied IRI to clipboard', 2000);
        break;

      case 'export':
        await saveExport(message.data, message.format, this.state.uri);
        break;

      default:
        break;
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = makeNonce();
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );
    const styles = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css')
    );

    // A strict CSP: no remote loads, and only our nonce-tagged script may run.
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styles}" rel="stylesheet">
<title>Ontology Graph</title>
</head>
<body>
  <div id="toolbar" role="toolbar" aria-label="Graph controls"></div>
  <div id="banner" hidden></div>
  <div id="graph" role="application" aria-label="Ontology graph"></div>
  <div id="empty" hidden></div>
  <div id="details" hidden aria-live="polite"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    PreviewPanel.current = undefined;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

async function revealLocation(location: { uri: string; range: any } | undefined): Promise<void> {
  if (!location?.uri) return;
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(location.uri));
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    });
    const range = new vscode.Range(
      location.range.start.line,
      location.range.start.character,
      location.range.end.line,
      location.range.end.character
    );
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch (err) {
    vscode.window.showWarningMessage(
      `Could not open ${location.uri}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Saves an exported image.
 *
 * The webview sandbox blocks downloads a page starts itself, so the export round
 * trips through the extension host and a real save dialog.
 */
async function saveExport(data: string, format: 'png' | 'svg', sourceUri: string): Promise<void> {
  const base = shortName(sourceUri).replace(/\.[^.]+$/, '') || 'ontology';
  const target = await vscode.window.showSaveDialog({
    filters: format === 'png' ? { Images: ['png'] } : { Images: ['svg'] },
    defaultUri: vscode.Uri.file(`${base}.${format}`),
  });
  if (!target) return;

  const bytes =
    format === 'png'
      ? Buffer.from(String(data).replace(/^data:image\/png;base64,/, ''), 'base64')
      : Buffer.from(String(data), 'utf8');

  await vscode.workspace.fs.writeFile(target, bytes);
  vscode.window.showInformationMessage(`Saved ${shortName(target.toString())}`);
}

export function isRdfDocument(doc: vscode.TextDocument): boolean {
  return ['turtle', 'ntriples', 'nquads', 'trig', 'n3', 'rdfxml'].includes(doc.languageId);
}

function shortName(uri: string): string {
  try {
    return decodeURIComponent(uri.split('/').pop() ?? uri);
  } catch {
    return uri;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
