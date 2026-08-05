/**
 * @di-framework/auth example
 *
 * A password login protecting an HTTP route, and a bearer token protecting the
 * same route for machine clients — both through one strategy chain.
 */

import { type AuthError, registerAuth } from '@di-framework/auth';
import { withAuthErrors, withAuthRoutes } from '@di-framework/auth/http';
import { useContainer } from '@di-framework/core/container';
import { Controller, Endpoint, json, TypedRouter } from '@di-framework/http';

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

// In a real application this comes from @di-framework/config or the environment.
// It must be at least 32 bytes; HKDF expands it into the CSRF and cookie keys.
const AUTH_SECRET = 'example-secret-please-replace-me-32b+';

const auth = registerAuth({
  secret: AUTH_SECRET,
  jwt: { issuer: 'https://api.example.com', audience: 'library-api', accessTtlSeconds: 900 },
  // The in-memory stores are the default. Swap in `repoUserStore(...)` and
  // friends from '@di-framework/auth/repo' to persist.
});

/* -------------------------------------------------------------------------- */
/* Domain                                                                     */
/* -------------------------------------------------------------------------- */

const notes = new Map<string, string[]>();

@Controller()
class NotesController {
  list(subject: string): string[] {
    return notes.get(subject) ?? [];
  }

  add(subject: string, text: string): string[] {
    const existing = notes.get(subject) ?? [];
    existing.push(text);
    notes.set(subject, existing);
    return existing;
  }
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

const router = TypedRouter({ catch: withAuthErrors() });
const secure = withAuthRoutes(router);

router.get('/health', () => json({ ok: true }));

// `req.principal` is typed as Principal here, not any — that is what
// `withAuthRoutes` buys over a plain middleware array.
secure.get('/notes', (req) => {
  const controller = useContainer().resolve(NotesController);
  return json({ notes: controller.list(req.principal.sub) });
});

secure.post('/notes', async (req) => {
  const controller = useContainer().resolve(NotesController);
  const body = req.content as { text?: string };
  return json({ notes: controller.add(req.principal.sub, body.text ?? '') });
});

// Marked public even though it sits on the protected router.
secure.get('/whoami', () => json({ anonymous: true }), { auth: false });

/* -------------------------------------------------------------------------- */
/* Walk through it                                                            */
/* -------------------------------------------------------------------------- */

const show = async (label: string, response: Response) => {
  const body = await response.clone().text();
  console.log(`${label} → ${response.status} ${body}`);
};

async function main(): Promise<void> {
  await auth.passwords.createUser({
    identifier: 'ada@example.com',
    password: 'correct horse battery staple',
    displayName: 'Ada Lovelace',
  });
  console.log('Registered ada@example.com\n');

  // 1. Unauthenticated access is refused.
  await show(
    'GET  /notes            (no credential)',
    await router.fetch(new Request('https://api.example.com/notes')),
  );

  // 2. Password login establishes a session.
  const { principal } = await auth.passwords.login(
    'ada@example.com',
    'correct horse battery staple',
  );
  const session = await auth.sessions.create({ subject: principal.sub, amr: principal.amr });
  console.log(`\nLogged in as ${principal.sub} (amr: ${principal.amr?.join(', ')})`);

  const cookie = `__Host-sid=${session.token}`;
  await show(
    'GET  /notes            (session cookie)',
    await router.fetch(new Request('https://api.example.com/notes', { headers: { cookie } })),
  );
  // A cookie-authenticated mutation needs a CSRF token bound to this session.
  // Bearer and API-key requests do not — they carry no ambient credential and so
  // cannot be forged cross-site.
  const csrfToken = await auth.csrf!.issue(session.record.id);
  await show(
    'POST /notes            (session + CSRF)',
    await router.fetch(
      new Request('https://api.example.com/notes', {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({ text: 'On the Analytical Engine' }),
      }),
    ),
  );

  await show(
    'POST /notes            (session, no CSRF token)',
    await router.fetch(
      new Request('https://api.example.com/notes', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({ text: 'forged' }),
      }),
    ),
  );

  await show(
    'POST /notes            (cross-site)',
    await router.fetch(
      new Request('https://api.example.com/notes', {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'sec-fetch-site': 'cross-site',
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({ text: 'forged' }),
      }),
    ),
  );

  // 3. A machine client uses a bearer token against the same routes.
  const access = await auth.tokens!.issueAccessToken({ subject: principal.sub });
  await show(
    '\nGET  /notes            (bearer token)',
    await router.fetch(
      new Request('https://api.example.com/notes', {
        headers: { authorization: `Bearer ${access.token}` },
      }),
    ),
  );

  // 4. A forged token is rejected — and, importantly, does not fall through to
  //    the next strategy and end up anonymous.
  await show(
    'GET  /notes            (forged token)',
    await router.fetch(
      new Request('https://api.example.com/notes', {
        headers: { authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9.' },
      }),
    ),
  );

  // 5. Session lifecycle.
  console.log('\nSession lifecycle:');
  const rotated = await auth.sessions.regenerate(session.token);
  console.log(
    `  regenerated → old id resolves: ${(await auth.sessions.resolve(session.token)).state}`,
  );
  console.log(
    `               new id resolves: ${(await auth.sessions.resolve(rotated!.token)).state}`,
  );

  await auth.sessions.revokeAllForSubject(principal.sub);
  console.log(`  revoked all  → ${(await auth.sessions.resolve(rotated!.token)).state}`);

  // 6. Login failures are throttled and never distinguish "no such user" from
  //    "wrong password".
  console.log('\nFailed logins:');
  for (const identifier of ['ada@example.com', 'nobody@example.com']) {
    try {
      await auth.passwords.login(identifier, 'not the password');
    } catch (error) {
      const authError = error as AuthError;
      console.log(`  ${identifier.padEnd(20)} → ${authError.publicMessage} (${authError.code})`);
    }
  }

  useContainer().clear();
}

/** CLI main gate — `isMain` is injectable so tests can cover the entry path. */
export async function runAuthMain(isMain = import.meta.main): Promise<void> {
  if (isMain) {
    await main();
  }
}

await runAuthMain();

export { auth, main, NotesController, router };
