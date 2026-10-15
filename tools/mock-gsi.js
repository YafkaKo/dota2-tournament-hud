/**
 * Имитатор Dota 2: шлёт на сервер правдоподобные пакеты GSI наблюдателя.
 * Нужен, чтобы верстать и репетировать без живого матча.
 *
 *   node tools/mock-gsi.js                 — матч в разгаре
 *   node tools/mock-gsi.js --draft         — стадия драфта
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

let clock = DRAFT ? -90 : Number(args.start ?? (END ? 2280 : 620));
let radKills = END ? 31 : 12;
let direKills = END ? 19 : 9;
let draftStep = 0;
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

function draftBlock() {
  const pick = (team, n) => {
    const out = { home_team: team === 2 };
    for (let i = 0; i < 5; i++) {
      out[`pick${i}_class`] = i < n ? HEROES[(team === 2 ? 0 : 5) + i] : '';
      out[`pick${i}_id`] = i < n ? HERO_IDS[(team === 2 ? 0 : 5) + i] : -1;
    }
    for (let i = 0; i < 7; i++) {
      out[`ban${i}_class`] = i < Math.min(7, n + 2) ? HEROES[(i + team) % HEROES.length] : '';
    }
    return out;
  };
  const picked = Math.min(5, Math.floor(draftStep / 2));
  return {
    activeteam: draftStep % 2 === 0 ? 2 : 3,
    pick: draftStep % 3 !== 0,
    activeteam_time_remaining: 30 - (draftStep % 30),
    team2: pick(2, picked),
    team3: pick(3, Math.max(0, picked - 1))
  };
}

function gameState() {
  if (DRAFT) return 'DOTA_GAMERULES_STATE_HERO_SELECTION';
  if (phase === 'post') return 'DOTA_GAMERULES_STATE_POST_GAME';
  return clock < 0 ? 'DOTA_GAMERULES_STATE_PRE_GAME' : 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS';
}

function payload() {
  const provider = { name: 'Dota 2', appid: 570, version: 47, timestamp: Math.floor(Date.now() / 1000) };

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
  draftStep += 1;
  send();
}

const mode = DRAFT ? 'драфт' : END ? 'конец карты' : 'матч в разгаре';
console.log(`Имитация: ${mode}, matchid ${MATCH_ID}, скорость ×${SPEED}${PAUSES ? ', с паузами' : ''}. Ctrl+C — остановить.`);

setInterval(step, 1000);
send();
