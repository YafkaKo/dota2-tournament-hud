/**
 * Имитатор OBS (протокол obs-websocket v5) для проверки агента хоткеев без OBS.
 * Понимает GetSceneList и SetCurrentProgramScene, умеет пароль.
 *
 *   node tools/mock-obs.js                    — порт 4455, без пароля
 *   node tools/mock-obs.js --password=secret  — с паролем
 */

const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const PORT = Number(args.port) || 4455;
const PASSWORD = typeof args.password === 'string' ? args.password : '';

const scenes = ['Игра', 'Драфт', 'Камера комментаторов', 'Повтор', 'Перерыв', 'Скоро начнём', 'Сетка', 'Итоги'];
let current = 'Игра';

const sha = (s) => crypto.createHash('sha256').update(s).digest('base64');

const wss = new WebSocketServer({
  port: PORT,
  handleProtocols: (protocols) => (protocols.has('obswebsocket.json') ? 'obswebsocket.json' : false)
});

wss.on('connection', (ws) => {
  const salt = crypto.randomBytes(16).toString('base64');
  const challenge = crypto.randomBytes(16).toString('base64');
  const send = (op, d) => ws.send(JSON.stringify({ op, d }));

  send(0, {
    obsWebSocketVersion: '5.5.0-mock',
    rpcVersion: 1,
    ...(PASSWORD ? { authentication: { salt, challenge } } : {})
  });

  ws.on('message', (raw) => {
    const { op, d } = JSON.parse(raw);

    if (op === 1) {
      if (PASSWORD && d.authentication !== sha(sha(PASSWORD + salt) + challenge)) {
        console.log('× неверный пароль');
        return ws.close(4009, 'Authentication failed.');
      }
      console.log('✓ клиент подключился');
      return send(2, { negotiatedRpcVersion: 1 });
    }

    if (op === 6) {
      const reply = (ok, code, responseData, comment) => send(7, {
        requestType: d.requestType, requestId: d.requestId,
        requestStatus: { result: ok, code, ...(comment ? { comment } : {}) },
        ...(responseData ? { responseData } : {})
      });

      if (d.requestType === 'GetSceneList') {
        return reply(true, 100, {
          currentProgramSceneName: current,
          currentPreviewSceneName: null,
          scenes: scenes.map((sceneName, i) => ({ sceneName, sceneIndex: scenes.length - 1 - i })).reverse()
        });
      }
      if (d.requestType === 'SetCurrentProgramScene') {
        const name = d.requestData && d.requestData.sceneName;
        if (!scenes.includes(name)) return reply(false, 600, null, `No source was found by the name of \`${name}\`.`);
        current = name;
        console.log(`→ сцена «${name}»`);
        reply(true, 100);
        for (const c of wss.clients) {
          c.send(JSON.stringify({ op: 5, d: { eventType: 'CurrentProgramSceneChanged', eventIntent: 4, eventData: { sceneName: name } } }));
        }
        return;
      }
      return reply(false, 204, null, 'mock: запрос не поддерживается');
    }
  });
});

console.log(`Имитатор OBS на ws://127.0.0.1:${PORT}${PASSWORD ? ' (с паролем)' : ''}. Сцены: ${scenes.join(', ')}`);
