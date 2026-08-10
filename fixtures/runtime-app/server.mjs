import http from 'node:http';

const ADMIN = 'admin@example.com';

const shell = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body>
<nav><a href="/">Home</a> <a href="/dashboard">Dashboard</a> <a href="/logout">Log out</a></nav>
${body}
</body></html>`;

const pages = {
  '/': () =>
    shell(
      'Home',
      `<h1>Home</h1>
       <a href="/login">Sign in</a>
       <a href="/signup">Create account</a>
       <a href="/secrets">Secrets</a>
       <a href="/edges">Edges</a>`,
    ),

  '/edges': () =>
    shell(
      'Edges',
      `<h1>Edges</h1>
       <a href="/api/health">Health</a>
       <a href="/go-api">Check health</a>
       <a href="/blank">Blank</a>`,
    ),

  '/login': () =>
    shell(
      'Sign in',
      `<h1>Sign in</h1>
       <form method="post" action="/login">
         <label for="email">Email</label><input id="email" name="email" type="email" required>
         <label for="password">Password</label><input id="password" name="password" type="password" required>
         <button type="submit">Sign in</button>
       </form>`,
    ),

  '/dashboard': (session) =>
    shell(
      'Dashboard',
      `<h1>Dashboard</h1>
       <p>Signed in as ${session}</p>
       <a href="/settings">Settings</a>
       ${session === ADMIN ? '<a href="/admin">Admin</a>' : ''}`,
    ),

  '/settings': () =>
    shell(
      'Settings',
      `<h1>Settings</h1>
       <button id="open" type="button" onclick="document.getElementById('sheet').hidden=false">Rename workspace</button>
       <div id="sheet" role="dialog" aria-label="Rename workspace" hidden>
         <h2>Rename workspace</h2>
         <button type="button" onclick="document.getElementById('sheet').hidden=true">Close</button>
       </div>`,
    ),

  '/admin': (session) =>
    session === ADMIN
      ? shell('Admin', '<h1>Admin</h1><p>Everyone in the workspace.</p>')
      : shell('Not authorized', '<h1>Not authorized</h1>'),

  '/signup': () =>
    shell(
      'Create account',
      `<h1>Create account</h1>
       <form method="post" action="/welcome">
         <label for="name">Name</label><input id="name" name="name" required>
         <label for="email">Email</label><input id="email" name="email" type="email" required>
         <label for="plan">Plan</label>
         <select id="plan" name="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
         <button type="submit">Continue</button>
       </form>`,
    ),

  '/welcome': () => shell('Welcome', '<h1>Welcome</h1><a href="/dashboard">Go to dashboard</a>'),

  '/billing': () =>
    shell(
      'Billing',
      `<h1>Billing</h1>
       <form method="post" action="/welcome">
         <label for="card">Card number</label><input id="card" name="card" required>
         <button type="submit">Save card</button>
       </form>`,
    ),

  '/secrets': () => shell('Secrets', '<h1>Secrets</h1><p>API key sk-live-do-not-capture</p>'),

  // A page that renders nothing — the shape of a server error shell, or of a
  // route whose data never arrived. Screenshotting it produces a white rectangle.
  '/blank': () =>
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Blank</title></head><body></body></html>',
};

const AUTHENTICATED = new Set(['/dashboard', '/settings', '/admin']);

export function startFixtureApp(port = 0) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const session = /session=([^;]+)/.exec(request.headers.cookie ?? '')?.[1] ?? null;

    if (url.pathname === '/login' && request.method === 'POST') {
      readBody(request).then((body) => {
        const email = decodeURIComponent((/email=([^&]*)/.exec(body)?.[1] ?? '').replace(/\+/g, ' '));
        response.writeHead(302, {
          'set-cookie': `session=${email}; Path=/`,
          location: '/dashboard',
        });
        response.end();
      });
      return;
    }

    if (url.pathname === '/welcome' && request.method === 'POST') {
      response.writeHead(302, { location: '/welcome' });
      response.end();
      return;
    }

    // The taxonomy shape: an in-app link whose redirect ends on a route handler.
    if (url.pathname === '/go-api') {
      response.writeHead(302, { location: '/api/health' });
      response.end();
      return;
    }

    if (url.pathname === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === '/logout') {
      response.writeHead(302, { 'set-cookie': 'session=; Path=/; Max-Age=0', location: '/' });
      response.end();
      return;
    }

    if (AUTHENTICATED.has(url.pathname) && !session) {
      response.writeHead(302, { location: '/login' });
      response.end();
      return;
    }

    const page = pages[url.pathname];
    if (!page) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      response.end(shell('Not found', '<h1>Not found</h1>'));
      return;
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page(session));
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      const address = server.address();
      resolve({
        url: `http://localhost:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => resolve(body));
  });
}

if (process.argv[1]?.endsWith('server.mjs')) {
  const app = await startFixtureApp(Number(process.env.PORT ?? 4400));
  process.stdout.write(`${app.url}\n`);
}
