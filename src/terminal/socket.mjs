import { WebSocketServer } from 'ws';

const PATH = /^\/api\/terminal\/([0-9a-f]{12})\/ws$/;
const MAX_MESSAGE = 1024 * 1024;

export function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return false;
  try {
    const forwarded = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
    const host = new URL(origin).host.toLowerCase();
    return host === String(req.headers.host ?? '').toLowerCase() || (forwarded !== '' && host === forwarded.toLowerCase());
  } catch {
    return false;
  }
}

function reject(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachTerminalSockets(server, { hub, gate }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const match = url.pathname.match(PATH);
    if (!match) return reject(socket, 404, 'Not Found');
    const access = gate.decide(req, url);
    if (!access.allowed || access.share) return reject(socket, 401, 'Unauthorized');
    if (!sameOrigin(req)) return reject(socket, 403, 'Forbidden');
    const session = hub.get(match[1]);
    if (!session) return reject(socket, 404, 'Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = { send: (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)) };
      const detach = hub.attach(session.id, client);
      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === 'input' && typeof msg.data === 'string') session.input(msg.data);
        if (msg.type === 'resize') session.resize(msg.cols, msg.rows);
      });
      ws.on('close', () => detach?.());
    });
  });
  return wss;
}
