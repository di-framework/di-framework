// main_test.ts
// Run with: deno test --allow-net --allow-env

import { assert, assertEquals } from 'jsr:@std/assert';
import { delay } from 'jsr:@std/async/delay';

// For testing, we'll start the server in a separate thread
// (in real projects, consider using a test helper or supertest-like lib for Deno)

const PORT = 8001; // different from dev port to avoid conflicts
const BASE_URL = `http://localhost:${PORT}`;

let server: Deno.HttpServer | null = null;

async function startTestServer() {
  if (server) return;

  // Import your main file (assuming it's named main.ts)
  const { router, env, ctx } = await import('./main.ts');

  server = Deno.serve(
    {
      port: PORT,
      onListen: ({ hostname, port }) => {
        console.log(`Test server listening on http://${hostname}:${port}`);
      },
    },
    async (req) => {
      try {
        const response = await router.fetch(req, env, ctx);
        return response ?? new Response('Not Found', { status: 404 });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(message, { status: 500 });
      }
    },
  );

  // Give server a moment to bind
  await delay(300);
}

async function stopTestServer() {
  if (server) {
    await server.shutdown();
    server = null;
    await delay(100);
  }
}

Deno.test({
  name: 'Server starts and responds to health check (optional)',
  async fn(t) {
    await startTestServer();

    try {
      const res = await fetch(BASE_URL);
      assertEquals(res.status, 404); // or 200 if you add a root handler
    } finally {
      // cleanup happens in teardown
    }
  },
  sanitizeOps: false, // allow network
  sanitizeResources: false,
});

Deno.test({
  name: 'POST /api/sandbox - creates a sandbox and returns ID',
  async fn(t) {
    await startTestServer();

    try {
      const payload = { message: 'Test sandbox creation' };

      const res = await fetch(`${BASE_URL}/api/sandbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      assertEquals(res.status, 201);

      const data = await res.json();
      assertEquals(data.created, true);
      assert(data.sandboxId);
      assertEquals(data.message, payload.message);

      // remember the ID for next tests
      const sandboxId = data.sandboxId;

      // Test 2: execute a simple command
      await t.step('POST /api/sandbox/:id/execute - runs ls', async () => {
        const execRes = await fetch(`${BASE_URL}/api/sandbox/${sandboxId}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'echo Hello from sandbox' }),
        });

        assertEquals(execRes.status, 200);
        const execData = await execRes.json();
        assert(execData.success);
        assert(execData.output.includes('Hello from sandbox'));
      });

      // Test 3: run Python code
      await t.step('POST /api/sandbox/:id/run-python - runs print(42)', async () => {
        const pyRes = await fetch(`${BASE_URL}/api/sandbox/${sandboxId}/run-python`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 'print(42 * 3)' }),
        });

        assertEquals(pyRes.status, 200);
        const pyData = await pyRes.json();
        assert(pyData.success);
        assert(pyData.output.includes('126'));
      });

      // Test 4: destroy the sandbox
      await t.step('DELETE /api/sandbox/:id - cleans up', async () => {
        const delRes = await fetch(`${BASE_URL}/api/sandbox/${sandboxId}`, {
          method: 'DELETE',
        });

        assertEquals(delRes.status, 200);
        const delData = await delRes.json();
        assert(delData.destroyed);

        // Try to use it again → should 404 or error
        const goneRes = await fetch(`${BASE_URL}/api/sandbox/${sandboxId}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'echo test' }),
        });

        assertEquals(goneRes.status, 400); // or 404 depending on your error handling
      });
    } finally {
      await stopTestServer();
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'POST /api/sandbox - fails without message',
  async fn() {
    await startTestServer();

    try {
      const res = await fetch(`${BASE_URL}/api/sandbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      assertEquals(res.status, 500); // or 400 if you improve error handling
      const text = await res.text();
      assert(text.includes('Message required'));
    } finally {
      await stopTestServer();
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'Invalid sandbox ID returns error',
  async fn() {
    await startTestServer();

    try {
      const res = await fetch(`${BASE_URL}/api/sandbox/this-is-not-a-uuid/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'ls' }),
      });

      assertEquals(res.status, 400); // or 404
      const data = await res.json();
      assert(data.output?.includes('Sandbox not found') || !data.success);
    } finally {
      await stopTestServer();
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
