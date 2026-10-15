/* Хелперы для данных Dota 2: имена, картинки, форматирование. */

const CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react';

/** npc_dota_hero_shadow_fiend | shadow_fiend -> shadow_fiend */
function heroKey(name) {
  if (!name) return '';
  return String(name).replace(/^npc_dota_hero_/, '');
}

/** shadow_fiend -> Shadow Fiend */
function heroLabel(name) {
  const key = heroKey(name);
  if (!key) return '';
  return key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Горизонтальный портрет героя (используется и в составах, и в драфте). */
function heroImage(name) {
  const key = heroKey(name);
  return key ? `${CDN}/heroes/${key}.png` : '';
}

/** item_black_king_bar -> иконка предмета */
function itemImage(name) {
  if (!name || name === 'empty') return '';
  const key = String(name).replace(/^item_/, '');
  return `${CDN}/items/${key}.png`;
}

/** 14370 -> "14.4k", 860 -> "860" */
function gold(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v);
}

/** 1875 -> "31:15", отрицательное время до старта -> "-1:25" */
function clock(seconds) {
  const s = Number(seconds) || 0;
  const sign = s < 0 ? '-' : '';
  const abs = Math.abs(s);
  const m = Math.floor(abs / 60);
  const ss = String(abs % 60).padStart(2, '0');
  return `${sign}${m}:${ss}`;
}

/** Все игроки команды в порядке слотов. team: 'team2' (Radiant) | 'team3' (Dire) */
function teamPlayers(gsi, team) {
  const players = gsi?.player?.[team] || {};
  const heroes = gsi?.hero?.[team] || {};
  const items = gsi?.items?.[team] || {};

  return Object.keys(players)
    .sort((a, b) => Number(a.replace('player', '')) - Number(b.replace('player', '')))
    .map(slot => ({
      slot,
      player: players[slot] || {},
      hero: heroes[slot] || {},
      items: items[slot] || {}
    }));
}

function teamNetWorth(gsi, team) {
  return teamPlayers(gsi, team)
    .reduce((sum, p) => sum + (Number(p.player.net_worth) || 0), 0);
}

/** Шесть слотов инвентаря + нейтралка. */
function inventory(itemsObj) {
  const slots = [];
  for (let i = 0; i < 6; i++) slots.push(itemsObj?.[`slot${i}`]?.name || null);
  slots.push(itemsObj?.neutral0?.name || null);
  return slots;
}

/** Идёт ли сейчас стадия драфта. */
function isDrafting(gsi) {
  const state = gsi?.map?.game_state;
  return state === 'DOTA_GAMERULES_STATE_HERO_SELECTION' ||
         state === 'DOTA_GAMERULES_STATE_STRATEGY_TIME';
}

function isLive(gsi) {
  const state = gsi?.map?.game_state;
  return state === 'DOTA_GAMERULES_STATE_PRE_GAME' ||
         state === 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS';
}
