/**
 * Проверка худа без Dota: шлёт на сервер пакет в том виде, в каком его шлёт кастомка Arena 5x5.
 *   node dota-addon/arena5v5/test/send-sample.js          — матч в разгаре
 *   node dota-addon/arena5v5/test/send-sample.js --end    — конец карты (победа Radiant)
 * Пакет записан из прогона скриптов кастомки на заглушках, герои и цифры условные.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'server.json'), 'utf8'));
const body = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-payload.json'), 'utf8'));

body.auth = { token: cfg.token };
body.provider.timestamp = Math.floor(Date.now() / 1000);
if (process.argv.includes('--end')) {
  body.map.game_state = 'DOTA_GAMERULES_STATE_POST_GAME';
  body.map.win_team = 'radiant';
}

const data = JSON.stringify(body);
const req = http.request({
  host: '127.0.0.1', port: cfg.port, path: '/gsi', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
}, (res) => { console.log('сервер ответил', res.statusCode); res.resume(); });
req.on('error', (err) => console.error('не достучался до сервера:', err.message));
req.end(data);
