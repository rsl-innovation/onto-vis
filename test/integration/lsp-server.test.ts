import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER = 'dist/server.js';
const URI = 'file:///tmp/rdf-test/o.ttl';

const TTL = [
  '@prefix ex: <http://example.org/> .',
  '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
  '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
  '',
  'ex:Agent a owl:Class .',
  'ex:Person a owl:Class ;',
  '    rdfs:subClassOf ex:Agent ;',
  '    rdfs:label "Person" .',
  'ex:worksFor a owl:ObjectProperty ;',
  '    rdfs:domain ex:Person ;',
  '    rdfs:range ex:Agent .',
  'ex:BROKEN !!! .',
].join('\n');

/** A minimal LSP client speaking the real wire protocol to the built server. */
class Client {
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, (msg: any) => void>();
  readonly notifications: any[] = [];
  private nextId = 1;

  constructor(private readonly proc: ChildProcessWithoutNullStreams) {
    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString();
      const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
      if (!length || this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString();
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      const msg = JSON.parse(body);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg);
        this.pending.delete(msg.id);
      } else if (msg.method) {
        this.notifications.push(msg);
      }
    }
  }

  private write(obj: unknown): void {
    const json = JSON.stringify(obj);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }
}

const built = existsSync(SERVER);
const maybe = built ? describe : describe.skip;

maybe('LSP server (end to end)', () => {
  let proc: ChildProcessWithoutNullStreams;
  let client: Client;

  beforeAll(async () => {
    proc = spawn('node', [SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    client = new Client(proc);
    await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      workspaceFolders: [],
      capabilities: {},
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: { uri: URI, languageId: 'turtle', version: 1, text: TTL },
    });
    await new Promise((r) => setTimeout(r, 600));
  }, 20000);

  afterAll(() => proc?.kill());

  it('advertises the full feature set', async () => {
    const init = await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      workspaceFolders: [],
      capabilities: {},
    });
    const caps = init.result.capabilities;
    expect(caps.hoverProvider).toBe(true);
    expect(caps.definitionProvider).toBe(true);
    expect(caps.referencesProvider).toBe(true);
    expect(caps.documentFormattingProvider).toBe(true);
    expect(caps.renameProvider.prepareProvider).toBe(true);
    expect(caps.semanticTokensProvider.legend.tokenTypes).toContain('ontologyClass');
  });

  it('publishes diagnostics for the broken statement', () => {
    const published = client.notifications
      .filter((n) => n.method === 'textDocument/publishDiagnostics')
      .pop();
    expect(published).toBeDefined();
    const errors = published.params.diagnostics.filter((d: any) => d.severity === 1);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('answers hover with rendered markdown', async () => {
    const res = await client.request('textDocument/hover', {
      textDocument: { uri: URI },
      position: { line: 5, character: 4 },
    });
    expect(res.result.contents.value).toContain('Person');
    expect(res.result.contents.kind).toBe('markdown');
  });

  it('resolves go-to-definition', async () => {
    const res = await client.request('textDocument/definition', {
      textDocument: { uri: URI },
      position: { line: 6, character: 22 },
    });
    expect(res.result.length).toBeGreaterThan(0);
    expect(res.result[0].uri).toBe(URI);
  });

  it('returns a grouped outline', async () => {
    const res = await client.request('textDocument/documentSymbol', {
      textDocument: { uri: URI },
    });
    const names = res.result.map((s: any) => s.name);
    expect(names).toContain('Classes');
    expect(names).toContain('Object Properties');
  });

  it('emits semantic tokens', async () => {
    const res = await client.request('textDocument/semanticTokens/full', {
      textDocument: { uri: URI },
    });
    expect(res.result.data.length).toBeGreaterThan(0);
    expect(res.result.data.length % 5).toBe(0); // five integers per token
  });

  it('serves the ontology graph over rdf/graph', async () => {
    const res = await client.request('rdf/graph', { uri: URI, view: 'ontology', scope: 'file' });
    const model = res.result;
    expect(model.view).toBe('ontology');
    expect(model.nodes.length).toBeGreaterThanOrEqual(2);
    expect(model.edges.some((e: any) => e.kind === 'subClassOf')).toBe(true);
    expect(model.edges.some((e: any) => e.kind === 'domainRange')).toBe(true);
  });

  it('serves the triples view', async () => {
    const res = await client.request('rdf/graph', { uri: URI, view: 'triples', scope: 'file' });
    expect(res.result.view).toBe('triples');
    expect(res.result.nodes.length).toBeGreaterThan(0);
  });

  it('reports the term under the cursor for preview sync', async () => {
    const res = await client.request('rdf/termAt', {
      uri: URI,
      position: { line: 5, character: 4 },
    });
    expect(res.result.iri).toBe('http://example.org/Person');
  });
});
