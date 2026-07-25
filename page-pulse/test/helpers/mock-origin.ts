import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface MockOrigin {
  url: string;
  port: number;
  hits: Map<string, number>;
  close: () => Promise<void>;
}

const OK_HTML =
  '<!doctype html><html><head><title>Example Domain Home Page</title>' +
  `<meta name="description" content="${'x'.repeat(120)}"></head>` +
  '<body><h1>Welcome</h1><p>hello</p></body></html>';

export async function startMockOrigin(): Promise<MockOrigin> {
  const hits = new Map<string, number>();
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();

  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    hits.set(path, (hits.get(path) ?? 0) + 1);
    switch (path) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(OK_HTML);
        return;
      case '/redirect':
        res.writeHead(302, { location: '/ok' });
        res.end();
        return;
      case '/loop':
        res.writeHead(302, { location: '/loop-b' });
        res.end();
        return;
      case '/loop-b':
        res.writeHead(302, { location: '/loop' });
        res.end();
        return;
      case '/notfound':
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<title>not found</title>');
        return;
      case '/server-error':
        res.writeHead(500, { 'content-type': 'text/html' });
        res.end('<title>boom</title>');
        return;
      case '/nonhtml':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      case '/big':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<title>big</title>${'a'.repeat(200000)}`);
        return;
      case '/slow': {
        const timer = setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<title>slow</title>');
        }, 3000);
        timers.add(timer);
        return;
      }
      default:
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<title>root</title><h1>root</h1>');
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        for (const timer of timers) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
