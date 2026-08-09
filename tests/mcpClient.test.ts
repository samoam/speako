import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServerClient } from '../src/mcp/mcpClient';

// The SDK's real Client/transport classes try to actually connect (spawn a
// subprocess for stdio, open a real HTTP stream for streamable-http) — not
// something to invoke in a unit test. close()'s job is purely to reset
// internal state so the next call reconnects fresh, so these tests inject a
// fake "already connected" client directly into the private fields (via
// `as any`) rather than driving a real connection through getClient().

test('McpServerClient.close: no-ops safely when never connected', () => {
  const client = new McpServerClient({ transport: 'http', url: 'http://example.invalid', apiKey: 'k' });
  assert.doesNotThrow(() => client.close());
});

test('McpServerClient.close: calls close() on the underlying client and clears cached state', () => {
  const client = new McpServerClient({ transport: 'http', url: 'http://example.invalid', apiKey: 'k' });
  let closeCalled = false;
  (client as any).client = { close: () => { closeCalled = true; } };
  (client as any).connecting = Promise.resolve();

  client.close();

  assert.equal(closeCalled, true);
  assert.equal((client as any).client, null);
  assert.equal((client as any).connecting, null);
});

test('McpServerClient.close: tolerates an underlying client with no close() method', () => {
  const client = new McpServerClient({ transport: 'stdio', command: 'echo', args: [], env: {} });
  (client as any).client = {}; // no close method at all
  assert.doesNotThrow(() => client.close());
  assert.equal((client as any).client, null);
});
