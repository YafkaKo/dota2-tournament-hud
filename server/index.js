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
const { GsiLog } = require('./gsi-log');
const { matchIdOf } = require('./snapshot');

const ROOT = path.join(__dirname, '..');
const CONFIG = loadConfig();
const PORT = CONFIG.port;

// ---------------------------------------------------------------- состояние

// Склеенный снимок матча живёт в MatchState: урезанные пакеты его не затирают.
const match = new MatchState({ file: path.join(ROOT, 'data', 'match.json') });
let gsiUpdatedAt = 0;          // когда пришёл последний пакет любого вида
let probability = null;        // последняя посчитанная вероятность (с разбивкой)

// Защита от двух источников данных сразу. Если параллельно с игрой забыли
// выключить имитатор или данные шлют два клиента с разными матчами, сервер
// раньше прыгал между ними на каждом пакете и сбрасывал состояние матча.
const sources = { realAt: 0, mockAt: 0, customAt: 0, currentIdAt: 0, currentFromMock: false, conflictAt: 0, conflictId: null };
const gsiLog = new GsiLog(CONFIG.gsiLog, ROOT);

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
    // «Только фон»: заставка без текста и графики — остаётся один фон сцены.
    bgOnly: { starting: false, break: false },
    results: { show: false, winner: 'radiant', note: '' },
    bracket: { title: 'Турнирная сетка', rounds: [] },
    ticker: '',
    showHud: true,
    panels: { networth: true, objectives: true, rosters: false },
    trivia: { show: false, title: '', text: '' },
    // Фон полноэкранных сцен: адрес картинки или видео. Пусто — стандартный фон.
    // scenes.<сцена> важнее all. dim — затемнение поверх фона, 0–80 %.
    background: {
      all: '',
      scenes: { starting: '', break: '', bracket: '', results: '', scoreboard: '', mapResults: '', draft: '' },
      dim: 40
    },
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
    opendota: { enabled: true },
    gsiLog: { enabled: false, onlyDraft: true, compact: true }
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
  // Матчи кастомки не попадают в OpenDota, а вся статистика и так приходит из игры.
  if (match.live && match.live.provider && match.live.provider.custom) {
    match.setEnrichment({ state: 'off', message: 'Кастомка Arena 5x5: статистика приходит из игры, OpenDota не нужна' }, null, opendota.constants);
    pushMatch();
    return;
  }
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

  res.status(200).end();

  const verdict = checkSource(body);
  gsiLog.write(body, verdict);
  if (verdict !== 'accepted') return;

  gsiUpdatedAt = Date.now();
  const result = match.ingest(body);

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

/**
 * Решает, принимать ли пакет. Возвращает 'accepted' или причину отказа.
 *   — пакеты имитатора игнорируются, пока идут данные из настоящей игры;
 *   — пакет с другим matchid игнорируется, пока текущий матч ещё присылает
 *     данные (значит, это второй клиент, а не новая карта).
 */
function checkSource(body) {
  const now = Date.now();
  const isMock = !!(body.provider && body.provider.mock);
  // Кастомка Arena 5x5 шлёт полные данные сама (provider.custom). Пока она в эфире,
  // пакеты обычного клиента Dota (GSI наблюдателя/игрока) игнорируем — иначе они
  // перемешаются с данными кастомки.
  const isCustom = !!(body.provider && body.provider.custom);
  if (isCustom && body.map && body.map.game_state) sources.customAt = now;
  if (!isCustom && !isMock && now - sources.customAt < 10000) return 'ignored: идут данные из кастомки Arena 5x5';

  if (isMock) {
    sources.mockAt = now;
    if (now - sources.realAt < 10000) return 'ignored: имитатор, пока идут данные из игры';
  } else if (body.map && body.map.game_state) {
    // Пакеты из главного меню (без матча) не считаем: с открытой в меню Dota имитатор должен работать.
    sources.realAt = now;
  }

  const id = matchIdOf(body);
  if (id && match.matchId && id === match.matchId) sources.currentIdAt = now;
  // Настоящая игра всегда важнее имитатора: если текущий матч пришёл из имитатора,
  // данные игры принимаются сразу.
  const realOverMock = !isMock && sources.currentFromMock;
  if (id && match.matchId && id !== match.matchId && now - sources.currentIdAt < 5000 && !realOverMock) {
    sources.conflictAt = now;
    sources.conflictId = id;
    return `ignored: второй матч ${id}, пока идёт ${match.matchId}`;
  }
  if (id) { sources.currentFromMock = isMock; sources.currentIdAt = now; }
  return 'accepted';
}

/** Предупреждение для пультов, если данные приходят из двух мест. */
function sourceWarning() {
  const now = Date.now();
  if (now - sources.mockAt < 10000 && now - sources.realAt < 10000) {
    return 'Одновременно идут данные из игры и из имитатора. Закройте окно start-test-data.bat — данные имитатора сейчас игнорируются.';
  }
  if (now - sources.conflictAt < 10000) {
    return `Данные приходят сразу по двум матчам (${match.matchId} и ${sources.conflictId}). Оставьте один клиент-наблюдатель с этим .cfg.`;
  }
  return null;
}

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

// ---------------------------------------------------------------- фоны заставок

const BG_DIR = path.join(ROOT, 'public', 'assets', 'backgrounds');
const BG_MAX = 20 * 1024 * 1024;
const BG_TYPES = {
  'image/jpeg': { ext: '.jpg', magic: (b) => b[0] === 0xFF && b[1] === 0xD8 },
  'image/png':  { ext: '.png', magic: (b) => b.slice(0, 4).toString('hex') === '89504e47' },
  'image/webp': { ext: '.webp', magic: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
  'video/mp4':  { ext: '.mp4', magic: (b) => b.slice(4, 8).toString() === 'ftyp' },
  'video/webm': { ext: '.webm', magic: (b) => b.slice(0, 4).toString('hex') === '1a45dfa3' }
};

// Загрузка файла фона. Тело запроса — сам файл, имя — в заголовке X-File-Name.
app.post('/api/backgrounds',
  express.raw({ type: Object.keys(BG_TYPES), limit: BG_MAX }),
  (req, res) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim();
    const kind = BG_TYPES[type];
    if (!kind) return res.status(415).json({ error: 'Подходят только JPG, PNG, WebP, MP4 и WebM' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Файл пустой' });
    if (!kind.magic(req.body)) return res.status(415).json({ error: 'Содержимое файла не похоже на ' + kind.ext.slice(1).toUpperCase() });

    const original = decodeURIComponent(String(req.headers['x-file-name'] || 'фон'));
    const base = original.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'background';
    const name = `${Date.now()}-${base}${kind.ext}`;
    fs.mkdirSync(BG_DIR, { recursive: true });
    fs.writeFileSync(path.join(BG_DIR, name), req.body);
    console.log(`[background] загружен ${name} (${Math.round(req.body.length / 1024)} КБ)`);
    res.json({ url: `/assets/backgrounds/${encodeURIComponent(name)}`, name, size: req.body.length });
  });

app.get('/api/backgrounds', (req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(BG_DIR)
      .filter((f) => /\.(jpe?g|png|webp|mp4|webm)$/i.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(BG_DIR, f));
        return { name: f, url: `/assets/backgrounds/${encodeURIComponent(f)}`, size: st.size, at: st.mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
  } catch { /* папки ещё нет */ }
  res.json(files);
});

app.delete('/api/backgrounds/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(BG_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Файла уже нет' });
  fs.unlinkSync(file);

  // Если удалённый файл где-то стоял фоном — возвращаем стандартный.
  const url = `/assets/backgrounds/${encodeURIComponent(name)}`;
  const bg = control.background;
  const scenes = Object.fromEntries(Object.entries(bg.scenes).map(([k, v]) => [k, v === url ? '' : v]));
  setControl(mergeDeep(control, { background: { all: bg.all === url ? '' : bg.all, scenes } }));
  res.json({ ok: true });
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
    warning: sourceWarning(),
    gsiLog: gsiLog.file ? { file: path.relative(ROOT, gsiLog.file), packets: gsiLog.count } : null,
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
  send(ws, { type: 'status', data: statusData() });
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

// Раз в 2 секунды сообщаем клиентам, идут ли данные из игры и нет ли конфликта источников.
setInterval(() => {
  broadcast({ type: 'status', data: statusData() });
}, 2000);

function statusData() {
  return { gsiConnected: isGsiConnected(), warning: sourceWarning() };
}

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

// Понятные ответы на ошибки загрузки (например, файл больше 20 МБ).
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: req.path.startsWith('/api/backgrounds') ? 'Файл больше 20 МБ' : 'Слишком большой запрос' });
  }
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Не разобрал данные запроса' });
  next(err);
});

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
