/**
 * Сервер трансляции.
 *
 *  Dota 2 (клиент наблюдателя)  --HTTP POST-->  /gsi
 *                                                 |
 *                       склейка снимка, итоги карты, вероятность победы
 *                                                 |
 *  overlay.html (OBS), control.html (оператор),  <--WebSocket--  рассылка
 *  /control (комментатор), агент хоткеев         --HTTP-->      /api/...
 *
 * Наружу ходит только запрос в OpenDota после окончания карты (можно выключить
 * в config/server.json). Всё остальное работает в локальной сети.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { MatchState } = require('./match');
const { computeProbability } = require('./probability');
const { OpenDotaEnricher } = require('./opendota');

const ROOT = path.join(__dirname, '..');
const CONFIG = loadConfig();
const PORT = CONFIG.port;

// ---------------------------------------------------------------- состояние

// Склеенный снимок матча живёт в MatchState: урезанные пакеты его не затирают.
const match = new MatchState({ file: path.join(ROOT, 'data', 'match.json') });
let gsiUpdatedAt = 0;          // когда пришёл последний пакет любого вида
let probability = null;        // последняя посчитанная вероятность (с разбивкой)

// Модель вероятности перечитывается при изменении файла — удобно подбирать коэффициенты.
const MODEL_FILE = path.join(ROOT, 'config', 'probability.json');
let model = loadModel();
fs.watchFile(MODEL_FILE, { interval: 2000 }, () => {
  model = loadModel();
  console.log('[probability] config/probability.json перечитан');
  probability = computeProbability(match.live, model);
  pushMatch();
});

// Данные, которые ведут оператор и комментатор. Живут в data/control.json,
// чтобы переживать перезапуск сервера посреди турнира.
const CONTROL_FILE = path.join(ROOT, 'data', 'control.json');
let control = loadControl();

function defaultControl() {
  return {
    scene: 'auto',              // auto | starting | break | bracket | results | scoreboard | blank
    tournament: 'Кубок киберспортивной арены ЮРГПУ (НПИ)',
    stage: 'Групповой этап',
    radiant: { name: 'Radiant', tag: 'RAD', logo: '' },
    dire: { name: 'Dire', tag: 'DIR', logo: '' },
    series: { format: 'bo3', radiantWins: 0, direWins: 0 },
    casters: { show: false, left: '', right: '', topic: '' },
    starting: { title: 'Трансляция скоро начнётся', subtitle: '', countdownTo: null },
    breakText: 'Технический перерыв',
    results: { show: false, winner: 'radiant', note: '' },
    bracket: { title: 'Турнирная сетка', rounds: [] },
    ticker: '',
    showHud: true,
    panels: { networth: true, objectives: true, rosters: false },
    trivia: { show: false, title: '', text: '' },
    triviaLibrary: [],              // заготовленные факты: [{ title, text }]
    probability: { show: false },   // плашка вероятности победы
    mapResults: { show: false }     // плашка итогов карты
  };
}

function loadControl() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
    // Глубокая склейка: новые поля из обновлений появятся и у старого control.json.
    return mergeDeep(defaultControl(), raw);
  } catch {
    return defaultControl();
  }
}

function saveControl() {
  try {
    fs.mkdirSync(path.dirname(CONTROL_FILE), { recursive: true });
    fs.writeFileSync(CONTROL_FILE, JSON.stringify(control, null, 2), 'utf8');
  } catch (err) {
    console.error('[control] не удалось сохранить состояние:', err.message);
  }
}

function loadConfig() {
  const fallback = {
    port: 3000,
    token: 'arena-hud',
    requireToken: true,
    results: { autoShow: true },
    comparison: { minAgeSec: 300, autoSnapshotEverySec: 0 },
    opendota: { enabled: true }
  };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'server.json'), 'utf8'));
    return mergeDeep(fallback, raw);
  } catch {
    return fallback;
  }
}

function loadModel() {
  try {
    return JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8'));
  } catch (err) {
    if (fs.existsSync(MODEL_FILE)) console.error('[probability] не разобрал config/probability.json:', err.message);
    return {};
  }
}

// ---------------------------------------------------------------- OpenDota

const opendota = new OpenDotaEnricher(CONFIG.opendota);

function startEnrichment() {
  opendota.start(match.matchId, (status, data) => {
    match.setEnrichment(status, data, opendota.constants);
    pushMatch();
  });
}


// ---------------------------------------------------------------- изменения пульта

/** Единая точка изменения control: отсюда ловим включение плашки вероятности. */
function setControl(next) {
  const wasOn = !!control.probability.show;
  control = next;
  if (!wasOn && control.probability.show) {
    probability = computeProbability(match.live, model);
    match.onProbabilityEnabled(probability, CONFIG.comparison.minAgeSec);
  }
  saveControl();
  broadcast({ type: 'control', data: control });
  pushMatch();
}

// ---------------------------------------------------------------- HTTP

const app = express();
app.use(express.json({ limit: '5mb' }));

// Пульт комментатора — отдельная простая страница.
app.get(['/control', '/control/'], (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'caster.html'));
});

app.use(express.static(path.join(ROOT, 'public')));

// Dota 2 шлёт состояние сюда. Путь совпадает с "uri" в конфиге GSI.
// Открыть его в браузере нельзя: браузер делает GET, а сюда приходит только POST.
app.post(['/gsi', '/'], (req, res) => {
  const body = req.body || {};

  if (CONFIG.requireToken) {
    const token = body.auth && body.auth.token;
    if (token !== CONFIG.token) {
      console.warn('[gsi] отклонён пакет с токеном:', token);
      return res.status(403).end();
    }
  }
  delete body.auth;           // токен не рассылаем клиентам
  delete body.previously;     // служебные диффы GSI нам не нужны
  delete body.added;

  gsiUpdatedAt = Date.now();
  const result = match.ingest(body);
  res.status(200).end();

  if (result.ignored) return;  // heartbeat без данных матча — снимок не трогаем

  if (result.newMatch) {
    opendota.stop();
    if (control.mapResults.show) {
      control = mergeDeep(control, { mapResults: { show: false } });
      saveControl();
      broadcast({ type: 'control', data: control });
    }
  }

  if (result.froze) {
    if (CONFIG.results.autoShow && !control.mapResults.show) {
      control = mergeDeep(control, { mapResults: { show: true } });
      saveControl();
      broadcast({ type: 'control', data: control });
    }
    startEnrichment();
  }

  probability = computeProbability(match.live, model);
  match.maybeAutoSnapshot(probability, CONFIG.comparison.autoSnapshotEverySec);

  broadcast({ type: 'gsi', data: match.live });
  pushMatch();
});

app.get('/api/state', (req, res) => {
  res.json({ control, gsi: match.live, match: matchView(), gsiAge: gsiUpdatedAt ? Date.now() - gsiUpdatedAt : null });
});

app.post('/api/control', (req, res) => {
  setControl(mergeDeep(control, req.body || {}));
  res.json(control);
});

// Переключатели для пульта комментатора и агента хоткеев.
const TOGGLES = ['probability', 'mapResults', 'trivia', 'casters'];
app.post('/api/toggle/:key', (req, res) => {
  const key = req.params.key;
  if (!TOGGLES.includes(key)) return res.status(404).json({ error: `Нет переключателя «${key}». Есть: ${TOGGLES.join(', ')}` });
  const show = typeof req.body?.show === 'boolean' ? req.body.show : !control[key].show;
  setControl(mergeDeep(control, { [key]: { show } }));
  res.json({ key, show });
});

app.post('/api/control/reset', (req, res) => {
  setControl(defaultControl());
  res.json(control);
});

// Состояние карты: вероятность с разбивкой по признакам, снимки, статус OpenDota.
app.get('/api/match', (req, res) => {
  res.json({ view: matchView(), probability, snapshots: match.snapshots, comparisonBase: match.comparisonBase });
});

// «Сброс матча»: снять итоги, удалить снимки. Команды и счёт серии не трогаем.
app.post('/api/match/reset', (req, res) => {
  opendota.stop();
  match.reset();
  probability = null;
  control = mergeDeep(control, { mapResults: { show: false } });
  saveControl();
  broadcast({ type: 'control', data: control });
  broadcast({ type: 'gsi', data: match.live });
  pushMatch();
  res.json({ ok: true });
});

// Диагностика: жив ли поток данных из игры.
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    gsiConnected: isGsiConnected(),
    gsiAgeMs: gsiUpdatedAt ? Date.now() - gsiUpdatedAt : null,
    matchId: match.matchId,
    gameState: match.live?.map?.game_state ?? null,
    resultsFrozen: !!match.final,
    clients: wss ? wss.clients.size : 0
  });
});

const server = http.createServer(app);

// ---------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ server, path: '/ws' });
let lastMatchJson = '';

wss.on('connection', (ws) => {
  // Новому клиенту сразу отдаём полную картину, чтобы он не ждал следующего пакета из игры.
  send(ws, { type: 'control', data: control });
  if (match.live) send(ws, { type: 'gsi', data: match.live });
  send(ws, { type: 'match', data: matchView() });
  send(ws, { type: 'status', data: { gsiConnected: isGsiConnected() } });
  ws.on('error', () => {});
});

function matchView() {
  const map = (match.live && match.live.map) || {};
  const prob = probability
    ? { radiant: Math.round(probability.radiant), dire: 100 - Math.round(probability.radiant) }
    : null;
  return {
    matchId: match.matchId,
    gameState: map.game_state ?? null,
    clock: Number.isFinite(Number(map.clock_time)) ? Number(map.clock_time) : null,
    paused: !!map.paused,
    probability: prob,
    comparison: match.comparison(probability),
    finished: !!match.final,
    results: match.resultsView(),
    enrichment: match.enrichment
  };
}

/** Рассылает состояние карты, только если оно изменилось. */
function pushMatch() {
  const view = matchView();
  const json = JSON.stringify(view);
  if (json === lastMatchJson) return;
  lastMatchJson = json;
  broadcast({ type: 'match', data: view });
}

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function isGsiConnected() {
  return gsiUpdatedAt > 0 && Date.now() - gsiUpdatedAt < 15000;
}

// Раз в 5 секунд сообщаем клиентам, идут ли данные из игры.
setInterval(() => {
  broadcast({ type: 'status', data: { gsiConnected: isGsiConnected() } });
}, 5000);

// ---------------------------------------------------------------- утилиты

function mergeDeep(target, patch) {
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeDeep(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Порт ${PORT} занят. Скорее всего, сервер уже запущен в другом окне.`);
    console.error('  Закройте его или поменяйте "port" в config/server.json.\n');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  // Сервер перезапустили, пока ждали OpenDota — продолжаем ждать.
  if (match.final && match.enrichment.state === 'waiting') startEnrichment();

  const lan = lanAddresses();
  console.log('');
  console.log('  Сервер трансляции запущен');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  Оверлей для OBS      http://localhost:${PORT}/overlay.html?obs=1`);
  console.log(`  Пульт оператора      http://localhost:${PORT}/control.html`);
  console.log(`  Пульт для телефона   http://localhost:${PORT}/control`);
  console.log(`  Приём GSI            http://localhost:${PORT}/gsi   (только POST из игры)`);
  for (const ip of lan) {
    console.log(`  С других ПК в сети   http://${ip}:${PORT}/control`);
  }
  console.log('');
  console.log('  Не закрывайте это окно во время эфира.');
  console.log('');
});
