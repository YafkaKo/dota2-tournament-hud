/* Оверлей: получает данные по WebSocket и перерисовывает сцены.
   Данных может не быть вообще — это нормальное состояние, а не ошибка:
   оверлей обязан выглядеть прилично и с пустой игрой. */

const params = new URLSearchParams(location.search);
if (params.get('obs') === '1') document.body.classList.add('obs');
if (params.has('gap')) document.documentElement.style.setProperty('--gap', params.get('gap') + 'px');

const $ = id => document.getElementById(id);

// Подложка под портреты: если иконка с серверов Valve не загрузилась,
// на её месте будет фирменный градиент, а не дыра.
const FALLBACK = 'linear-gradient(135deg, rgba(108,77,255,.45), rgba(255,61,138,.25))';

let control = null;
let gsi = null;
let match = null;   // состояние карты с сервера: вероятность, сравнение, итоги

/* ----------------------------------------------------------- соединение */

let ws;
let retry = 0;

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);

  ws.onopen = () => {
    retry = 0;
    document.body.classList.add('is-connected');
    document.body.classList.remove('is-loading');
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'control') control = msg.data;
    if (msg.type === 'gsi') gsi = msg.data;
    if (msg.type === 'match') match = msg.data;
    if (msg.type === 'status') return;
    render();
  };

  ws.onclose = () => {
    document.body.classList.remove('is-connected');
    retry = Math.min(retry + 1, 10);
    setTimeout(connect, 500 * retry);
  };

  ws.onerror = () => ws.close();
}

connect();
setInterval(tickCountdown, 250);

/* ----------------------------------------------------------- сцены */

function render() {
  if (!control) return;

  const drafting = control.scene === 'auto' && isDrafting(gsi);
  const manual = control.scene !== 'auto' && control.scene !== 'blank';

  $('layerGame').hidden = manual || drafting || !control.showHud;
  $('sceneDraft').hidden = !drafting;
  $('sceneStarting').hidden = control.scene !== 'starting';
  $('sceneBreak').hidden = control.scene !== 'break';
  $('sceneBracket').hidden = control.scene !== 'bracket';
  $('sceneResults').hidden = control.scene !== 'results';
  $('sceneScoreboard').hidden = control.scene !== 'scoreboard';

  renderBrand();
  if (drafting) renderDraft();
  if (!$('layerGame').hidden) renderGame();
  if (control.scene === 'bracket') renderBracket();
  if (control.scene === 'results') renderResults();
  if (control.scene === 'scoreboard') renderScoreboard();
  renderPanes();
  renderWinProb();
  renderMapResults();
  renderTrivia();
}

/* ----------------------------------------------------------- шапка */

function renderBrand() {
  const c = control;
  $('radName').textContent = c.radiant.name || 'Radiant';
  $('direName').textContent = c.dire.name || 'Dire';
  $('tournamentName').textContent = c.tournament || '';
  $('stageName').textContent = c.stage || '';

  setLogo($('radLogo'), c.radiant.logo);
  setLogo($('direLogo'), c.dire.logo);

  const need = seriesLength(c.series.format);
  $('radSeries').innerHTML = dots(need, c.series.radiantWins, 'rad');
  $('direSeries').innerHTML = dots(need, c.series.direWins, 'dire');
}

function setLogo(el, url) {
  if (url) {
    el.style.backgroundImage = `url("${url}")`;
    el.style.display = 'block';
  } else {
    el.style.backgroundImage = '';
    el.style.display = 'none';
  }
}

function seriesLength(format) {
  return { bo1: 1, bo2: 2, bo3: 2, bo5: 3 }[format] ?? 2;
}

function dots(total, won, side) {
  let html = '';
  for (let i = 0; i < total; i++) {
    html += `<span class="series__dot ${i < won ? 'series__dot--won-' + side : ''}"></span>`;
  }
  return html;
}

/* ----------------------------------------------------------- игровой слой */

function renderGame() {
  const panels = control.panels || {};
  const live = isLive(gsi);

  // Нетворс
  const showNw = panels.networth !== false && live;
  $('networth').hidden = !showNw;
  if (showNw) {
    const rad = teamNetWorth(gsi, 'team2');
    const dire = teamNetWorth(gsi, 'team3');
    const total = rad + dire || 1;
    const share = Math.max(8, Math.min(92, (rad / total) * 100));
    $('nwRad').textContent = gold(rad);
    $('nwDire').textContent = gold(dire);
    $('nwFill').style.width = share + '%';
    const diff = rad - dire;
    const lead = $('nwLead');
    lead.textContent = diff === 0 ? 'равно' : `${diff > 0 ? '◀' : '▶'} ${gold(Math.abs(diff))}`;
    lead.style.color = diff === 0 ? '#C8D6DE' : (diff > 0 ? '#CFE9A8' : '#F2BDB6');
  }

  // Рошан
  const showObj = panels.objectives !== false && live;
  $('objectives').hidden = !showObj;
  if (showObj) {
    const state = gsi?.map?.roshan_state;
    const left = Number(gsi?.map?.roshan_state_end_seconds) || 0;
    const value = $('roshanValue');
    if (state === 'alive') {
      value.textContent = 'жив';
      value.classList.remove('is-soon');
    } else if (state) {
      value.textContent = clock(left);
      value.classList.toggle('is-soon', left < 120);
    } else {
      value.textContent = '—';
    }
  }

  // Составы
  const showRosters = panels.rosters === true && gsi;
  $('rosters').hidden = !showRosters;
  if (showRosters) {
    $('rosterRadTitle').textContent = control.radiant.name || 'Radiant';
    $('rosterDireTitle').textContent = control.dire.name || 'Dire';
    $('rosterRad').innerHTML = teamPlayers(gsi, 'team2').map(playerRow).join('');
    $('rosterDire').innerHTML = teamPlayers(gsi, 'team3').map(playerRow).join('');
  }

  // Комментаторы
  const cs = control.casters || {};
  $('casters').hidden = !cs.show;
  if (cs.show) {
    $('castersTopic').textContent = cs.topic || '';
    $('castersTopic').hidden = !cs.topic;
    $('casterLeft').textContent = cs.left || '';
    $('casterRight').textContent = cs.right || '';
    document.querySelector('.casters__sep').hidden = !(cs.left && cs.right);
  }

  // Бегущая строка
  $('ticker').hidden = !control.ticker;
  $('tickerText').textContent = control.ticker || '';
}

function playerRow({ player, hero, items }) {
  const dead = hero.alive === false;
  const img = heroImage(hero.name);
  const inv = inventory(items).map(name => {
    const url = itemImage(name);
    return `<div class="player__item" style="${url ? `background-image:url('${url}'),${FALLBACK}` : ''}"></div>`;
  }).join('');

  return `
    <li class="player ${dead ? 'player--dead' : ''}">
      <div class="player__hero" style="${img ? `background-image:url('${img}'),${FALLBACK}` : ''}">
        <span class="player__lvl">${hero.level ?? '—'}</span>
      </div>
      <div>
        <div class="player__nick">${escapeHtml(player.name || 'игрок')}</div>
        <div class="player__hero-name">${escapeHtml(heroLabel(hero.name))}</div>
      </div>
      <div class="player__kda">
        <b>${player.kills ?? 0}</b><span>/</span><b>${player.deaths ?? 0}</b><span>/</span><b>${player.assists ?? 0}</b>
      </div>
      <div class="player__nw">${gold(player.net_worth)}</div>
      <div class="player__items">${inv}</div>
    </li>`;
}

/* ----------------------------------------------------------- драфт */

function renderDraft() {
  const draft = gsi?.draft || {};
  $('draftRadName').textContent = control.radiant.name || 'Radiant';
  $('draftDireName').textContent = control.dire.name || 'Dire';

  const active = draft.activeteam;
  const phase = draft.pick ? 'выбирает' : 'банит';
  const who = active === 2 ? (control.radiant.name || 'Radiant')
            : active === 3 ? (control.dire.name || 'Dire') : '';
  $('draftPhase').textContent = who ? `${who} ${phase}` : 'Подготовка к драфту';

  const left = Number(draft.activeteam_time_remaining);
  $('draftTimer').textContent = Number.isFinite(left) ? clock(left) : '—';

  $('draftRadPicks').innerHTML = picks(draft.team2, 5);
  $('draftDirePicks').innerHTML = picks(draft.team3, 5);
  $('draftRadBans').innerHTML = bans(draft.team2, 7);
  $('draftDireBans').innerHTML = bans(draft.team3, 7);
}

function picks(team, count) {
  let html = '';
  for (let i = 0; i < count; i++) {
    const name = team?.[`pick${i}_class`];
    const img = heroImage(name);
    html += `
      <div class="pick ${name ? '' : 'pick--empty'}">
        <div class="pick__img" style="${img ? `background-image:url('${img}'),${FALLBACK}` : ''}"></div>
        <div class="pick__name">${escapeHtml(heroLabel(name)) || '—'}</div>
      </div>`;
  }
  return html;
}

function bans(team, count) {
  let html = '';
  for (let i = 0; i < count; i++) {
    const name = team?.[`ban${i}_class`];
    const img = heroImage(name);
    html += `<div class="ban ${name ? '' : 'ban--empty'}" style="${img ? `background-image:url('${img}'),${FALLBACK}` : ''}"></div>`;
  }
  return html;
}

/* ----------------------------------------------------------- заставки */

function renderPanes() {
  const s = control.starting || {};
  $('startEyebrow').textContent = control.tournament || '';
  $('startTitle').textContent = s.title || 'Трансляция скоро начнётся';
  $('startSub').textContent = s.subtitle || '';
  $('startSub').hidden = !s.subtitle;
  $('breakTitle').textContent = control.breakText || 'Технический перерыв';
  $('vsRad').textContent = control.radiant.name || 'Radiant';
  $('vsDire').textContent = control.dire.name || 'Dire';
}

function tickCountdown() {
  if (!control) return;
  const to = control.starting?.countdownTo;
  const el = $('startCountdown');
  if (!to) { el.hidden = true; return; }
  const left = Math.max(0, Math.floor((new Date(to).getTime() - Date.now()) / 1000));
  el.hidden = false;
  el.textContent = clock(left);
}

function renderResults() {
  const r = control.results || {};
  const winner = r.winner === 'dire' ? control.dire.name : control.radiant.name;
  $('resultWinner').textContent = winner || '—';
  $('resultScore').textContent = `${control.series.radiantWins} : ${control.series.direWins}`;
  $('resultNote').textContent = r.note || '';
  $('resultNote').hidden = !r.note;
}

/* ----------------------------------------------------------- сетка */

function renderBracket() {
  const b = control.bracket || {};
  $('bracketTitle').textContent = b.title || 'Турнирная сетка';
  const rounds = Array.isArray(b.rounds) ? b.rounds : [];

  $('bracket').innerHTML = rounds.map(round => `
    <div class="round">
      <div class="round__name">${escapeHtml(round.name || '')}</div>
      <div class="round__matches">
        ${(round.matches || []).map(m => `
          <div class="match">
            ${matchRow(m.a)}
            ${matchRow(m.b)}
          </div>`).join('')}
      </div>
    </div>`).join('');
}

function matchRow(side) {
  if (!side) return `<div class="match__row"><span>—</span><span class="match__score"></span></div>`;
  return `
    <div class="match__row ${side.won ? 'match__row--won' : ''}">
      <span>${escapeHtml(side.name || '—')}</span>
      <span class="match__score">${side.score ?? ''}</span>
    </div>`;
}

/* ----------------------------------------------------------- итог карты */

function renderScoreboard() {
  $('sbTime').textContent = clock(gsi?.map?.clock_time);

  $('sbRadName').textContent = control.radiant.name || 'Radiant';
  $('sbDireName').textContent = control.dire.name || 'Dire';

  const radNw = teamNetWorth(gsi, 'team2');
  const direNw = teamNetWorth(gsi, 'team3');
  $('sbRadNw').textContent = gold(radNw);
  $('sbDireNw').textContent = gold(direNw);

  const win = gsi?.map?.win_team; // 'radiant' | 'dire' | 'none'
  $('sbRadBadge').hidden = win !== 'radiant';
  $('sbDireBadge').hidden = win !== 'dire';
  $('sbRad').classList.toggle('sb-team--win', win === 'radiant');
  $('sbDire').classList.toggle('sb-team--win', win === 'dire');

  $('sbRadRows').innerHTML = teamPlayers(gsi, 'team2').map(scoreboardRow).join('');
  $('sbDireRows').innerHTML = teamPlayers(gsi, 'team3').map(scoreboardRow).join('');
}

function scoreboardRow({ player, hero, items }) {
  const dead = hero.alive === false;
  const img = heroImage(hero.name);
  const inv = inventory(items).map(name => {
    const url = itemImage(name);
    return `<div class="sb-item" style="${url ? `background-image:url('${url}'),${FALLBACK}` : ''}"></div>`;
  }).join('');

  return `
    <div class="sb-row ${dead ? 'sb-row--dead' : ''}">
      <div class="sb-hero" style="${img ? `background-image:url('${img}'),${FALLBACK}` : ''}">
        <span class="sb-lvl">${hero.level ?? '—'}</span>
      </div>
      <div class="sb-nick">
        <div class="sb-nick__name">${escapeHtml(player.name || 'игрок')}</div>
        <div class="sb-nick__hero">${escapeHtml(heroLabel(hero.name))}</div>
      </div>
      <div class="sb-kda"><b>${player.kills ?? 0}</b>/<b>${player.deaths ?? 0}</b>/<b>${player.assists ?? 0}</b></div>
      <div class="sb-lh">${player.last_hits ?? 0}<i>/${player.denies ?? 0}</i></div>
      <div class="sb-nw">${gold(player.net_worth)}</div>
      <div class="sb-items">${inv}</div>
    </div>`;
}

/* ----------------------------------------------------------- вероятность победы */

function renderWinProb() {
  const p = match?.probability;
  const on = !!(control.probability?.show && p && !match.finished);
  const box = $('winprob');
  box.classList.toggle('is-on', on);
  box.setAttribute('aria-hidden', String(!on));
  if (!p) return;   // при скрытии оставляем последние цифры, пока плашка гаснет

  const radName = control.radiant.name || 'Radiant';
  $('wpRadName').textContent = radName;
  $('wpDireName').textContent = control.dire.name || 'Dire';
  setLogo($('wpRadLogo'), control.radiant.logo);
  setLogo($('wpDireLogo'), control.dire.logo);

  tweenNumber($('wpRadPct'), p.radiant, '%');
  tweenNumber($('wpDirePct'), p.dire, '%');
  $('wpFill').style.width = p.radiant + '%';

  const c = match.comparison;
  $('wpCmp').hidden = !c;
  if (c) {
    $('wpCmpTime').textContent = `${clock(c.from.clock)} → ${clock(c.to.clock)}`;
    $('wpCmpText').textContent = `${radName} ${c.from.radiant}% → ${c.to.radiant}%`;
    const d = $('wpCmpDelta');
    d.textContent = c.delta > 0 ? `▲${c.delta}` : c.delta < 0 ? `▼${Math.abs(c.delta)}` : '= 0';
    d.className = 'winprob__delta ' + (c.delta > 0 ? 'is-up' : c.delta < 0 ? 'is-down' : 'is-flat');
  }
}

/** Плавно докручивает число до нового значения (~450 мс). */
function tweenNumber(el, target, suffix = '') {
  const from = Number(el.dataset.value ?? target);
  el.dataset.value = target;
  if (from === target || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = target + suffix;
    return;
  }
  const start = performance.now();
  const dur = 450;
  const id = (el._tween = (el._tween || 0) + 1);
  const frame = (now) => {
    if (el._tween !== id) return;
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(from + (target - from) * eased) + suffix;
    if (t < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/* ----------------------------------------------------------- итоги карты */

// Колонки таблицы. optional — колонка показывается, только если значение
// есть хотя бы у одного игрока: так в таблице не бывает пустых столбцов.
const MR_COLUMNS = [
  { key: 'kda',    title: 'K / D / A', width: '150px', cell: p => `<b>${v(p.kills)}</b><i>/</i>${v(p.deaths)}<i>/</i>${v(p.assists)}` },
  { key: 'nw',     title: 'Net worth', width: '120px', cell: p => `<span class="mr-lime">${p.netWorth == null ? '—' : gold(p.netWorth)}</span>` },
  { key: 'gpmxpm', title: 'GPM / XPM', width: '150px', optional: p => p.gpm != null || p.xpm != null, cell: p => `${v(p.gpm)}<i>/</i>${v(p.xpm)}` },
  { key: 'lhdn',   title: 'LH / DN',   width: '120px', optional: p => p.lastHits != null, cell: p => `${v(p.lastHits)}<i>/</i>${v(p.denies)}` },
  { key: 'dmg',    title: 'Урон',      width: '110px', optional: p => p.heroDamage != null, cell: p => p.heroDamage == null ? '—' : gold(p.heroDamage) },
  { key: 'tower',  title: 'Строения',  width: '110px', optional: p => p.towerDamage != null, cell: p => p.towerDamage == null ? '—' : gold(p.towerDamage) }
];

function v(x) { return x == null ? '—' : x; }

function renderMapResults() {
  const r = match?.results;
  const on = !!(control.mapResults?.show && r);
  const box = $('mapResults');
  box.classList.toggle('is-on', on);
  box.setAttribute('aria-hidden', String(!on));
  if (!r) return;

  const radName = control.radiant.name || 'Radiant';
  const direName = control.dire.name || 'Dire';
  const winnerName = r.winner === 'radiant' ? radName : r.winner === 'dire' ? direName : null;

  $('mrEyebrow').textContent = r.provisional ? 'Карта идёт' : 'Итоги карты';
  $('mrTitle').textContent = r.provisional ? 'Статистика карты'
    : winnerName ? `Победа ${winnerName}` : 'Карта окончена';
  $('mrRadScore').textContent = r.radiantScore ?? 0;
  $('mrDireScore').textContent = r.direScore ?? 0;
  $('mrDuration').textContent = clock(r.provisional && match.clock != null ? match.clock : r.duration);
  $('mrSub').textContent = r.provisional ? 'игровое время' : 'длительность';

  $('mrRadName').textContent = radName;
  $('mrDireName').textContent = direName;
  $('mrRad').classList.toggle('mrteam--win', r.winner === 'radiant' && !r.provisional);
  $('mrDire').classList.toggle('mrteam--win', r.winner === 'dire' && !r.provisional);

  const all = [...r.players.radiant, ...r.players.dire];
  const cols = MR_COLUMNS.filter(c => !c.optional || all.some(c.optional));
  const template = `64px minmax(0,1fr) ${cols.map(c => c.width).join(' ')} 330px`;

  for (const [team, el, nwEl] of [['radiant', 'mrRadTable', 'mrRadNw'], ['dire', 'mrDireTable', 'mrDireNw']]) {
    const players = r.players[team] || [];
    const nw = players.reduce((s, p) => s + (p.netWorth || 0), 0);
    $(nwEl).textContent = nw ? gold(nw) : '';
    const head = `<div class="mr-row mr-row--head" style="grid-template-columns:${template}">
        <span></span><span>Игрок</span>${cols.map(c => `<span>${c.title}</span>`).join('')}<span>Предметы</span></div>`;
    const rows = players.map(p => mapResultsRow(p, cols, template)).join('');
    $(el).innerHTML = head + (rows || `<div class="mr-empty">Данные по игрокам появятся, как только придут из игры или OpenDota</div>`);
  }

  const src = r.sources?.opendota ? 'Данные: игра и OpenDota' : 'Данные: игра';
  $('mrFoot').textContent = r.matchId ? `${src} · матч ${r.matchId}` : src;
}

function mapResultsRow(p, cols, template) {
  const img = heroImage(p.hero);
  const items = (p.items || []).map((name, i) => {
    const url = itemImage(name);
    return `<div class="mr-item ${i === 6 ? 'mr-item--neutral' : ''}" style="${url ? `background-image:url('${url}'),${FALLBACK}` : ''}"></div>`;
  }).join('');
  return `
    <div class="mr-row" style="grid-template-columns:${template}">
      <div class="mr-hero" style="${img ? `background-image:url('${img}'),${FALLBACK}` : ''}">
        ${p.level != null ? `<span class="mr-lvl">${p.level}</span>` : ''}
      </div>
      <div class="mr-name">
        <div class="mr-name__nick">${escapeHtml(p.name || heroLabel(p.hero) || 'Игрок')}</div>
        <div class="mr-name__hero">${escapeHtml(p.name ? heroLabel(p.hero) : '')}</div>
      </div>
      ${cols.map(c => `<div class="mr-cell mr-cell--${c.key}">${c.cell(p)}</div>`).join('')}
      <div class="mr-items">${items}</div>
    </div>`;
}

/* ----------------------------------------------------------- trivia */

function renderTrivia() {
  const t = control.trivia || {};
  $('trivia').hidden = !t.show;
  if (!t.show) return;
  $('triviaTitle').textContent = t.title || '';
  $('triviaTitle').hidden = !t.title;
  $('triviaText').textContent = t.text || '';
}

/* ----------------------------------------------------------- прочее */

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
