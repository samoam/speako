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

// Regression test — traced to a real incident: an already-connected
// McpServerClient's underlying `uvx mcp-atlassian` subprocess died
// unexpectedly (crashed independently of anything Speako did). Before this
// fix, McpServerClient had no way to notice — `this.client` kept pointing at
// the dead connection forever, so every subsequent callTool() call hung
// until CALL_TOOL_TIMEOUT_MS (20s) with no recovery short of restarting the
// whole Speako process. getClient() now wires the SDK Client's `onclose`
// callback to clearCachedClient() so an unexpected disconnect is noticed and
// the next call reconnects fresh instead of reusing a dead client.
test('McpServerClient: an unexpected disconnect (the SDK client\'s onclose firing) clears the cached client so the next call reconnects fresh', () => {
  const client = new McpServerClient({ transport: 'http', url: 'http://example.invalid', apiKey: 'k' });
  (client as any).client = { close: () => {} };
  (client as any).connecting = Promise.resolve();

  // Simulates getClient() invoking clearCachedClient() via the wired
  // `client.onclose` handler when the underlying connection dies on its own
  // (not via an explicit close() call) — see getClient()'s `client.onclose = ...` line.
  (client as any).clearCachedClient();

  assert.equal((client as any).client, null);
  assert.equal((client as any).connecting, null);
});
