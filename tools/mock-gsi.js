/**
 * Имитатор Dota 2: шлёт на сервер правдоподобные пакеты GSI наблюдателя.
 * Нужен, чтобы верстать и репетировать без живого матча.
 *
 *   node tools/mock-gsi.js                 — матч в разгаре
 *   node tools/mock-gsi.js --draft         — драфт Captain's Mode: баны и пики по фазам,
 *                                            основное и резервное время (--speed ускоряет)
 *   node tools/mock-gsi.js --end           — конец карты: 15 с игры, итоги, затем
 *                                            урезанные пакеты, как после выхода в меню
 *   node tools/mock-gsi.js --speed=10      — 10 игровых секунд за секунду (для сравнения вероятности)
 *   node tools/mock-gsi.js --pause         — каждые 2 игровые минуты пауза на 10 секунд
 *   node tools/mock-gsi.js --start=600     — с какой игровой секунды начать
 *   node tools/mock-gsi.js --match=7900000002  — другой matchid (имитация новой карты)
 *   node tools/mock-gsi.js --winner=dire   — кто победит в режиме --end
 *   node tools/mock-gsi.js --no-damage     — без урона/лечения в данных игрока
 *                                            (проверка догрузки из OpenDota)
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'server.json'), 'utf8'));

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

const DRAFT = !!args.draft;
const END = !!args.end;
const SPEED = Math.max(1, Number(args.speed) || 1);
const PAUSES = !!args.pause;
const MATCH_ID = String(args.match || '7900000001');
const WINNER = args.winner === 'dire' ? 'dire' : 'radiant';
const NO_DAMAGE = !!args['no-damage'];

const HEROES = [
  'npc_dota_hero_juggernaut', 'npc_dota_hero_lina', 'npc_dota_hero_pudge',
  'npc_dota_hero_crystal_maiden', 'npc_dota_hero_axe', 'npc_dota_hero_invoker',
  'npc_dota_hero_shadow_fiend', 'npc_dota_hero_witch_doctor', 'npc_dota_hero_tidehunter',
  'npc_dota_hero_phantom_assassin'
];
const HERO_IDS = [8, 25, 14, 5, 2, 74, 11, 30, 29, 44];

const NICKS = ['Sever', 'kotyara', 'Almaz', 'nikitka', 'Zubov', 'Dyadya', 'w1nter', 'Malysh', 'Grek', 'Stepa'];

const ITEMS = [
  'item_black_king_bar', 'item_power_treads', 'item_manta', 'item_blink',
  'item_force_staff', 'item_magic_wand', 'item_aghanims_shard', 'item_desolator'
];

// ---------------------------------------------------------------- драфт Captain's Mode

// Порядок ходов. Это приближение к CM патчей 7.3x: 7 банов и 5 пиков у каждой
// команды, баны и пики идут фазами и чередуются. Если в актуальном патче порядок
// другой, поправьте этот массив — оверлей от него не зависит, он рисует то, что прислала игра.
// A — команда первого выбора (здесь Radiant), B — вторая.
const CM_ORDER = [
  'bA', 'bB', 'bA', 'bB', 'bA', 'bB', 'bB',   // баны 1
  'pA', 'pB',                                 // пики 1
  'bA', 'bA', 'bB',                           // баны 2
  'pB', 'pA', 'pA', 'pB', 'pB', 'pA',         // пики 2
  'bA', 'bB', 'bA', 'bB',                     // баны 3
  'pA', 'pB'                                  // пики 3
];
// Сколько «думает» капитан на каждом ходу, секунд. На 3-м и 13-м ходу дольше
// основного времени — так видно, как тратится резерв.
const THINK = [6, 7, 36, 5, 8, 6, 7, 12, 9, 6, 5, 7, 33, 8, 10, 6, 9, 11, 5, 6, 7, 5, 14, 40];
const MAIN_TIME = 30;
const RESERVE_TIME = 130;
const STRATEGY_TIME = 30;

const DRAFT_POOL = [
  ...HEROES,
  'npc_dota_hero_tinker', 'npc_dota_hero_storm_spirit', 'npc_dota_hero_earthshaker', 'npc_dota_hero_mars',
  'npc_dota_hero_shadow_shaman', 'npc_dota_hero_rubick', 'npc_dota_hero_puck', 'npc_dota_hero_morphling',
  'npc_dota_hero_enigma', 'npc_dota_hero_faceless_void', 'npc_dota_hero_lion', 'npc_dota_hero_magnataur',
  'npc_dota_hero_sniper', 'npc_dota_hero_bane'
];

const cm = {
  step: 0, spent: 0, main: MAIN_TIME,
  reserve: { 2: RESERVE_TIME, 3: RESERVE_TIME },
  teams: { 2: { picks: [], bans: [] }, 3: { picks: [], bans: [] } },
  strategyLeft: null, used: 0
};

function cmTeam(code) { return code[1] === 'A' ? 2 : 3; }

/** Один игровой момент драфта (1 секунда). */
function cmTick() {
  if (cm.strategyLeft !== null) {
    cm.strategyLeft -= 1;
    if (cm.strategyLeft <= 0) {
      console.log('→ стратегия закончилась, драфт начинается заново');
      Object.assign(cm, { step: 0, spent: 0, main: MAIN_TIME, reserve: { 2: RESERVE_TIME, 3: RESERVE_TIME },
        teams: { 2: { picks: [], bans: [] }, 3: { picks: [], bans: [] } }, strategyLeft: null, used: 0 });
    }
    return;
  }
  const code = CM_ORDER[cm.step];
  const team = cmTeam(code);
  cm.spent += 1;
  if (cm.main > 0) cm.main -= 1;
  else cm.reserve[team] = Math.max(0, cm.reserve[team] - 1);

  const outOfTime = cm.main <= 0 && cm.reserve[team] <= 0;
  if (cm.spent >= THINK[cm.step] || outOfTime) {
    const hero = DRAFT_POOL[cm.used++ % DRAFT_POOL.length];
    const list = code[0] === 'p' ? cm.teams[team].picks : cm.teams[team].bans;
    list.push(hero);
    console.log(`→ ход ${cm.step + 1}/${CM_ORDER.length}: ${team === 2 ? 'Radiant' : 'Dire'} ${code[0] === 'p' ? 'пикает' : 'банит'} ${hero.replace('npc_dota_hero_', '')}` +
      (cm.main <= 0 ? ` (резерв ${team === 2 ? 'Radiant' : 'Dire'}: ${cm.reserve[team]} с)` : ''));
    cm.step += 1;
    cm.spent = 0;
    cm.main = MAIN_TIME;
    if (cm.step >= CM_ORDER.length) {
      cm.strategyLeft = STRATEGY_TIME;
      console.log('→ драфт окончен, время стратегии');
    }
  }
}

function draftBlock() {
  const teamBlock = (team) => {
    const t = cm.teams[team];
    const out = { home_team: team === 2 };
    for (let i = 0; i < 5; i++) {
      const name = t.picks[i] || '';
      out[`pick${i}_id`] = name ? HERO_IDS[HEROES.indexOf(name)] ?? 100 + i : -1;
      out[`pick${i}_class`] = name;
    }
    for (let i = 0; i < 7; i++) {
      const name = t.bans[i] || '';
      out[`ban${i}_id`] = name ? 200 + i : -1;
      out[`ban${i}_class`] = name;
    }
    return out;
  };
  const code = CM_ORDER[Math.min(cm.step, CM_ORDER.length - 1)];
  const done = cm.strategyLeft !== null;
  return {
    activeteam: done ? 0 : cmTeam(code),
    pick: !done && code[0] === 'p',
    activeteam_time_remaining: done ? 0 : cm.main,
    radiant_bonus_time: cm.reserve[2],
    dire_bonus_time: cm.reserve[3],
    team2: teamBlock(2),
    team3: teamBlock(3)
  };
}

let clock = DRAFT ? -90 : Number(args.start ?? (END ? 2280 : 620));
let radKills = END ? 31 : 12;
let direKills = END ? 19 : 9;
let tick = 0;
let pausedFor = 0;
let phase = 'game';            // game | post | menu

// Radiant потихоньку отрывается: так видно движение вероятности.
const lead = (i) => (i < 5 ? 1 : 0.86);

function player(i) {
  const t = Math.max(clock, 0);
  const p = {
    steamid: '7656119800000000' + i,
    accountid: String(100000 + i),
    name: NICKS[i],
    activity: 'playing',
    kills: Math.max(0, Math.round(((i < 5 ? radKills : direKills) / 5) + (2 - i % 5))),
    deaths: 1 + (i % 4) + Math.floor(t / 900),
    assists: 2 + (i % 6) + Math.floor(t / 300),
    last_hits: 40 + i * 9 + Math.floor(t / 4 * lead(i) / 5),
    denies: 3 + (i % 7),
    kill_streak: 0,
    team_name: i < 5 ? 'radiant' : 'dire',
    gold: 900 + i * 120,
    gold_reliable: 300,
    gold_unreliable: 600 + i * 120,
    gpm: Math.round((420 + (i % 5) * 33) * lead(i)),
    xpm: Math.round((510 + (i % 5) * 27) * lead(i)),
    net_worth: Math.max(600, Math.round((1500 + i % 5 * 300 + t * (6 + i % 5)) * lead(i))),
    hero_damage: Math.round(t * (6 + i % 5) * lead(i)),
    tower_damage: Math.round(t * (i % 5) * 0.4 * lead(i)),
    hero_healing: i % 5 === 3 ? Math.round(t * 2) : 0
  };
  if (NO_DAMAGE) { delete p.hero_damage; delete p.tower_damage; delete p.hero_healing; }
  return p;
}

function hero(i) {
  const alive = phase !== 'game' || !(i === 3 && clock % 60 > 40);
  const t = Math.max(clock, 0);
  return {
    id: HERO_IDS[i],
    name: HEROES[i],
    level: Math.min(30, 1 + Math.floor(t / 100 * lead(i)) + (i % 3)),
    xp: Math.round(t * (8 + i % 5) * lead(i)),
    alive,
    respawn_seconds: alive ? 0 : 18,
    health_percent: alive ? 60 + (i * 4) % 40 : 0,
    mana_percent: 40 + (i * 7) % 60
  };
}

function items(i) {
  const out = {};
  const filled = Math.min(6, 2 + Math.floor(Math.max(clock, 0) / 600) + (i % 2));
  for (let s = 0; s < 6; s++) {
    out[`slot${s}`] = s < filled ? { name: ITEMS[(i + s) % ITEMS.length] } : { name: 'empty' };
  }
  out.neutral0 = { name: clock > 1200 ? 'item_mysterious_hat' : 'empty' };
  return out;
}

// Наблюдатель получает Radiant как player0–4, Dire как player5–9.
function group(fn, from) {
  const out = {};
  for (let i = 0; i < 5; i++) out[`player${from + i}`] = fn(from + i);
  return out;
}

function buildings() {
  const lanes = ['top', 'mid', 'bot'];
  const side = (prefix, rax, lost) => {
    const out = {};
    let n = 0;
    for (const lane of lanes) {
      for (let tier = 1; tier <= 3; tier++) {
        out[`dota_${prefix}_tower${tier}_${lane}`] = { health: n++ < lost ? 0 : 1800, max_health: 1800 };
      }
      out[`${rax}_rax_melee_${lane}`] = { health: 2200, max_health: 2200 };
      out[`${rax}_rax_range_${lane}`] = { health: 1300, max_health: 1300 };
    }
    out[`dota_${prefix}_tower4_top`] = { health: 2100, max_health: 2100 };
    out[`dota_${prefix}_tower4_bot`] = { health: 2100, max_health: 2100 };
    out[`dota_${prefix}_fort`] = { health: 4500, max_health: 4500 };
    return out;
  };
  const t = Math.max(clock, 0);
  return {
    radiant: side('goodguys', 'good', Math.floor(t / 900)),
    dire: side('badguys', 'bad', Math.floor(t / 600))
  };
}

function gameState() {
  if (DRAFT) return cm.strategyLeft !== null ? 'DOTA_GAMERULES_STATE_STRATEGY_TIME' : 'DOTA_GAMERULES_STATE_HERO_SELECTION';
  if (phase === 'post') return 'DOTA_GAMERULES_STATE_POST_GAME';
  return clock < 0 ? 'DOTA_GAMERULES_STATE_PRE_GAME' : 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS';
}

function payload() {
  // mock: true — по этой метке сервер отличает имитатор от настоящей игры
  // и не даёт им смешаться, если имитатор забыли выключить.
  const provider = { name: 'Dota 2', appid: 570, version: 47, timestamp: Math.floor(Date.now() / 1000), mock: true };

  // После выхода из матча клиент шлёт только provider — ровно на этом раньше
  // и пропадали итоги карты.
  if (phase === 'menu') return { provider, auth: { token: cfg.token } };

  const body = {
    provider,
    map: {
      name: 'start',
      matchid: MATCH_ID,
      game_time: clock + 90,
      clock_time: clock,
      daytime: Math.floor(clock / 300) % 2 === 0,
      game_state: gameState(),
      paused: pausedFor > 0,
      win_team: phase === 'post' ? WINNER : 'none',
      customgamename: '',
      ward_purchase_cooldown: 0,
      radiant_score: radKills,
      dire_score: direKills,
      roshan_state: clock % 400 < 200 ? 'alive' : 'respawn_variable',
      roshan_state_end_seconds: Math.max(0, 480 - (clock % 400))
    },
    player: { team2: group(player, 0), team3: group(player, 5) },
    hero: { team2: group(hero, 0), team3: group(hero, 5) },
    items: { team2: group(items, 0), team3: group(items, 5) },
    buildings: buildings(),
    auth: { token: cfg.token }
  };
  if (DRAFT) body.draft = draftBlock();
  return body;
}

function send() {
  const data = JSON.stringify(payload());
  const req = http.request({
    host: 'localhost',
    port: cfg.port,
    path: '/gsi',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
  }, (res) => {
    if (res.statusCode !== 200) console.error('сервер ответил', res.statusCode);
    res.resume();
  });
  req.on('error', (err) => console.error('не достучался до сервера:', err.message));
  req.end(data);
}

function step() {
  tick += 1;

  if (END) {
    if (tick === 15) { phase = 'post'; console.log(`→ карта окончена, победа ${WINNER} (POST_GAME)`); }
    if (tick === 22) { phase = 'menu'; console.log('→ наблюдатель вышел в меню: дальше только урезанные пакеты'); }
  }

  if (phase === 'game' && !DRAFT) {
    if (pausedFor > 0) {
      pausedFor -= 1;
      if (pausedFor === 0) console.log('→ пауза снята');
    } else {
      for (let s = 0; s < SPEED; s++) {
        clock += 1;
        if (clock > 0 && clock % 37 === 0) radKills += 1;
        if (clock > 0 && clock % 53 === 0) direKills += 1;
        if (PAUSES && clock > 0 && clock % 120 === 0) { pausedFor = 10; console.log(`→ пауза на ${clock}с игрового времени`); break; }
      }
    }
  }
  if (DRAFT) for (let s = 0; s < SPEED; s++) cmTick();
  send();
}

const mode = DRAFT ? 'драфт' : END ? 'конец карты' : 'матч в разгаре';
console.log(`Имитация: ${mode}, matchid ${MATCH_ID}, скорость ×${SPEED}${PAUSES ? ', с паузами' : ''}. Ctrl+C — остановить.`);

setInterval(step, 1000);
send();
