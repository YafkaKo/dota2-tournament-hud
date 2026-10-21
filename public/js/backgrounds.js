/* Панель «Фон заставок» — общая для пульта оператора и пульта на телефоне.

   createBackgroundPanel(root, { patch, toast }) рисует панель в root и возвращает
   функцию update(control), которую страница вызывает при каждом новом состоянии. */

const BG_TARGETS = [
  ['all', 'Все заставки'],
  ['starting', 'Скоро начнём'],
  ['break', 'Перерыв'],
  ['bracket', 'Сетка'],
  ['results', 'Итог-заставка'],
  ['scoreboard', 'Таблица счёта'],
  ['mapResults', 'Итоги карты'],
  ['draft', 'Драфт']
];
const BG_MAX_MB = 20;
const BG_ACCEPT = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'];

function createBackgroundPanel(root, { patch, toast }) {
  let control = null;
  let target = 'all';
  let library = [];

  root.innerHTML = `
    <div class="bgp">
      <label class="field">
        <span>Для какой сцены</span>
        <select data-bg="target">
          ${BG_TARGETS.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}
        </select>
      </label>

      <div class="bgp__preview" data-bg="preview">
        <div class="bgp__media" data-bg="img"></div>
        <video class="bgp__media" data-bg="video" muted loop playsinline autoplay hidden></video>
        <div class="bgp__dim" data-bg="dim"></div>
        <span class="bgp__caption" data-bg="caption">Стандартный фон</span>
      </div>

      <div class="bgp__actions">
        <label class="bgp__upload">
          <input type="file" accept="${BG_ACCEPT.join(',')}" data-bg="file">
          <span>Загрузить файл</span>
        </label>
        <button type="button" class="ghost" data-bg="reset">Вернуть стандартный</button>
      </div>
      <p class="hint">JPG, PNG, WebP или видео MP4/WebM, до ${BG_MAX_MB} МБ. Видео крутится по кругу без звука.</p>

      <div class="bgp__url">
        <input type="url" inputmode="url" placeholder="или ссылка на картинку/видео: https://…" data-bg="url" autocomplete="off">
        <button type="button" data-bg="apply">Поставить</button>
      </div>

      <label class="field">
        <span>Затемнение фона: <b data-bg="dimValue">40</b>%</span>
        <input type="range" min="0" max="80" step="5" data-bg="dimRange">
      </label>

      <p class="bgp__status" data-bg="status" role="status"></p>

      <div class="bgp__library-head">
        <span>Загруженные фоны</span>
      </div>
      <ul class="bgp__library" data-bg="library"></ul>
    </div>`;

  const q = (name) => root.querySelector(`[data-bg="${name}"]`);

  function setStatus(text, isError) {
    const el = q('status');
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  function current(t = target) {
    const bg = control.background || {};
    return t === 'all' ? (bg.all || '') : ((bg.scenes && bg.scenes[t]) || '');
  }

  function effective() {
    const own = current();
    if (own) return { url: own, from: target === 'all' ? 'Общий фон' : 'Свой фон сцены' };
    if (target !== 'all' && control.background.all) return { url: control.background.all, from: 'Общий фон (своего у сцены нет)' };
    return { url: '', from: 'Стандартный фон' };
  }

  async function setUrl(url) {
    const value = target === 'all' ? { all: url } : { scenes: { [target]: url } };
    return patch({ background: value });
  }

  function isVideo(url) {
    return /\.(mp4|webm)(\?|#|$)/i.test(url);
  }

  /** Проверяем, что ссылка открывается и это картинка или видео. */
  function probe(url) {
    return new Promise((resolve) => {
      const done = (ok) => { clearTimeout(timer); resolve(ok); };
      const timer = setTimeout(() => done(false), 10000);
      if (isVideo(url)) {
        const v = document.createElement('video');
        v.muted = true;
        v.preload = 'metadata';
        v.onloadedmetadata = () => done(true);
        v.onerror = () => done(false);
        v.src = url;
      } else {
        const img = new Image();
        img.onload = () => done(img.naturalWidth > 0);
        img.onerror = () => done(false);
        img.src = url;
      }
    });
  }

  async function loadLibrary() {
    try {
      library = await fetch('/api/backgrounds').then((r) => r.json());
    } catch {
      library = [];
    }
    renderLibrary();
  }

  function renderLibrary() {
    const ul = q('library');
    if (!library.length) {
      ul.innerHTML = '<li class="bgp__empty">Пока ничего не загружено</li>';
      return;
    }
    const inUse = new Set([control?.background?.all, ...Object.values(control?.background?.scenes || {})].filter(Boolean));
    ul.innerHTML = library.map((f) => `
      <li class="bgp__item ${inUse.has(f.url) ? 'is-used' : ''}">
        <div class="bgp__thumb" style="${isVideo(f.url) ? '' : `background-image:url('${f.url}')`}">${isVideo(f.url) ? '<span>видео</span>' : ''}</div>
        <div class="bgp__name" title="${escapeAttr(f.name)}">${escapeAttr(f.name.replace(/^\d+-/, ''))}<i>${(f.size / 1048576).toFixed(1)} МБ</i></div>
        <button type="button" data-use="${escapeAttr(f.url)}">Поставить</button>
        <button type="button" class="ghost bgp__del" data-del="${escapeAttr(f.name)}" aria-label="Удалить файл">✕</button>
      </li>`).join('');
  }

  function escapeAttr(s) {
    return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function render() {
    if (!control) return;
    const bg = control.background || {};
    q('target').value = target;

    // Подписи у сцен, где стоит свой фон
    for (const opt of q('target').options) {
      const [, name] = BG_TARGETS.find(([k]) => k === opt.value);
      opt.textContent = opt.value !== 'all' && current(opt.value) ? `${name} — свой фон` : name;
    }

    const eff = effective();
    q('caption').textContent = eff.from;
    const img = q('img');
    const video = q('video');
    if (eff.url && isVideo(eff.url)) {
      img.hidden = true;
      video.hidden = false;
      if (video.dataset.src !== eff.url) { video.dataset.src = eff.url; video.src = eff.url; video.play().catch(() => {}); }
    } else {
      video.hidden = true;
      if (video.dataset.src) { video.removeAttribute('src'); video.dataset.src = ''; video.load(); }
      img.hidden = false;
      img.style.backgroundImage = eff.url ? `url("${eff.url.replace(/"/g, '%22')}")` : '';
    }
    q('preview').classList.toggle('is-default', !eff.url);

    const dim = Number(bg.dim ?? 40);
    if (document.activeElement !== q('dimRange')) q('dimRange').value = dim;
    q('dimValue').textContent = dim;
    q('dim').style.opacity = eff.url ? String(dim / 100) : '0';
    q('reset').disabled = !current();
    renderLibrary();
  }

  /* ---- действия */

  q('target').addEventListener('change', (e) => { target = e.target.value; setStatus(''); render(); });

  q('file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!BG_ACCEPT.includes(file.type)) { setStatus('Этот формат не подходит. Нужен JPG, PNG, WebP, MP4 или WebM.', true); return; }
    if (file.size > BG_MAX_MB * 1048576) { setStatus(`Файл ${(file.size / 1048576).toFixed(1)} МБ — больше ${BG_MAX_MB} МБ.`, true); return; }

    setStatus(`Загружаю ${file.name}…`);
    try {
      const res = await fetch('/api/backgrounds', {
        method: 'POST',
        headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) },
        body: file
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `сервер ответил ${res.status}`);
      await setUrl(data.url);
      await loadLibrary();
      setStatus('');
      toast('Фон поставлен');
    } catch (err) {
      setStatus(`Не загрузилось: ${err.message}`, true);
    }
  });

  q('apply').addEventListener('click', async () => {
    const url = q('url').value.trim();
    if (!/^https?:\/\//i.test(url)) { setStatus('Ссылка должна начинаться с http:// или https://', true); return; }
    setStatus('Проверяю ссылку…');
    const ok = await probe(url);
    if (!ok) {
      setStatus('Ссылка не открывается или это не картинка/видео. Проверьте, что она ведёт прямо на файл, а не на страницу с ним.', true);
      return;
    }
    if (await setUrl(url)) { q('url').value = ''; setStatus(''); toast('Фон поставлен'); }
  });

  q('reset').addEventListener('click', async () => {
    if (await setUrl('')) toast(target === 'all' ? 'Стандартный фон' : 'У сцены снова общий фон');
  });

  let dimTimer;
  q('dimRange').addEventListener('input', (e) => {
    q('dimValue').textContent = e.target.value;
    q('dim').style.opacity = effective().url ? String(e.target.value / 100) : '0';
    clearTimeout(dimTimer);
    dimTimer = setTimeout(() => patch({ background: { dim: Number(e.target.value) } }), 250);
  });

  root.addEventListener('click', async (e) => {
    const use = e.target.closest('[data-use]');
    if (use) { if (await setUrl(use.dataset.use)) toast('Фон поставлен'); return; }
    const del = e.target.closest('[data-del]');
    if (del) {
      if (!confirm('Удалить этот файл? Если он стоит фоном, вернётся стандартный.')) return;
      await fetch(`/api/backgrounds/${encodeURIComponent(del.dataset.del)}`, { method: 'DELETE' });
      await loadLibrary();
      toast('Файл удалён');
    }
  });

  loadLibrary();

  let lastSig = '';
  return function update(next) {
    control = next;
    // Фон поменяли с другого устройства — обновим и список файлов.
    const sig = JSON.stringify(next.background || {});
    if (sig !== lastSig) { lastSig = sig; loadLibrary(); }
    render();
  };
}
