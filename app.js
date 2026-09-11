/* ============================================================
   Đọc Truyện – local SPA
   ============================================================ */
'use strict';

/* ---------------- Router ---------------- */
const routes = {
    '/':            renderHome,
    '/search':      renderSearch,
    '/novel/':      renderDetail,    // /novel/:slug
    '/library':     renderLibrary,
    '/history':     renderHistory,
    '/settings':    renderSettings,
    '/thuhoaiadmin': renderAdmin,
};

function curPath() {
    let p = location.pathname;
    if (location.search) p = p + location.search;
    if (!p.startsWith('/')) p = '/' + p;
    return p || '/';
}
function nav(path) {
    if (curPath() === path) { routeTo(); return; }
    history.pushState(null, '', path);
    routeTo();
}
function routeTo() {
    const p = curPath();
    const match = matchRoute(p.split('?')[0]);
    if (!match) { renderNotFound(p); return; }
    cleanupReader();
    closeDropdowns();
    routes[match](p);
    setActiveNav(match);
    window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => routeTo());
function matchRoute(p) {
    return Object.keys(routes).find(k => (k === '/' ? p === '/' : (p === k || p.startsWith(k))));
}

function rendermk(html, id) {
    const root = document.getElementById('app');
    root.innerHTML = `<div class="page-root" id="${id}">${html}</div>`;
}
function setActiveNav(route) {
    document.querySelectorAll('.bn-item').forEach(b => {
        const r = b.dataset.route;
        b.classList.toggle('active', route === r || (route === '/' && r === '/'));
    });
}
function renderNotFound(p) {
    rendermk(`
        <div class="error-state">
            <i class="bi bi-compass"></i>
            <p>Không tìm thấy trang <b>${esc(p)}</b></p>
            <button class="btn btn-primary" onclick="nav('/')">Về trang chủ</button>
        </div>`, 'errpage');
    setActiveNav('/');
}
function closeDropdowns() {
    closeAllModalsExceptReader();
}

/* ---------------- API ---------------- */
async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
}
function cleanText(s) {
    return s.replace(/(\p{L})\/\/(\p{L})/gu, (m, a, b) => a + b);
}
function esc(s) { if (s === null || s === undefined) return ''; const d = document.createElement('div'); d.textContent = cleanText(String(s)); return d.innerHTML; }
let bannerCfg = { image: '/Banner/Banner_Shopee.png', link: 'https://s.shopee.vn/' };
async function loadBannerCfg() {
    try {
        const r = await api('/api/banner');
        if (r && r.image) bannerCfg.image = r.image;
        if (r && r.link) bannerCfg.link = r.link;
    } catch (e) {}
}
loadBannerCfg();
function isCoverOk(u) { return typeof u === 'string' && u.startsWith('/covers/') && u.length > 8; }
function fmtViews(n) {
    n = n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
}
function stars(r) {
    r = parseFloat(r) || 0;
    const full = Math.round(r);
    let s = '';
    for (let i = 1; i <= 5; i++) s += `<i class="bi ${i <= full ? 'bi-star-fill' : 'bi-star'}"></i>`;
    return s;
}

/* ---------------- Local state (prefs, library, history, progress) ---------------- */
const LS = {
    prefs: 'readnovel.prefs',
    library: 'readnovel.library',
    history: 'readnovel.history',
    progress: 'readnovel.progress',
    unlocked: 'readnovel.unlocked',
    admin: 'readnovel.adminToken',
};
const defaultPrefs = {
    theme: 'light',
    fontSize: 17,
    fontFamily: 'System',
    lineHeight: 1.8,
    width: 760,
    autoSave: true,
    autoNext: true,
    autoHideNav: true,
    tapToPlay: false,
};
function loadJSON(key, fb) { try { const v = JSON.parse(localStorage.getItem(key)); if (v !== null && v !== undefined) return v; } catch(e) {} return fb; }
function saveJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch(e) {} }
function loadSessionJSON(key, fb) { try { const v = JSON.parse(sessionStorage.getItem(key)); if (v !== null && v !== undefined) return v; } catch(e) {} return fb; }
function saveSessionJSON(key, v) { try { sessionStorage.setItem(key, JSON.stringify(v)); } catch(e) {} }

let prefs = Object.assign({}, defaultPrefs, loadJSON(LS.prefs, {}));
function savePrefs() { saveJSON(LS.prefs, prefs); applyTheme(); }

let library = loadJSON(LS.library, {});        // { slug: { status:'reading'|'completed'|'saved', addedAt, ...meta } }
function saveLibrary() { saveJSON(LS.library, library); }

let historyList = loadJSON(LS.history, []);    // [{slug, chapterUrl, chapterNum, title, cover, at}]
function saveHistory() { saveJSON(LS.history, historyList); }

let progressMap = loadJSON(LS.progress, {});   // { slug: { chapterUrl, chapterNum, pct, at, title, cover } }
function saveProgress() { saveJSON(LS.progress, progressMap); }

// unlock TTL: 1 phút (ms) — test
const UNLOCK_TTL = 60 * 1000;

function isStoryUnlocked(slug) {
    try {
        const v = JSON.parse(localStorage.getItem(LS.unlocked) || '{}');
        const ts = v[slug];
        if (!ts) return false;
        if (now() - ts > UNLOCK_TTL) { delete v[slug]; localStorage.setItem(LS.unlocked, JSON.stringify(v)); return false; }
        return true;
    } catch (e) { return false; }
}
function unlockStory(slug) {
    try {
        const v = JSON.parse(localStorage.getItem(LS.unlocked) || '{}');
        v[slug] = now();
        localStorage.setItem(LS.unlocked, JSON.stringify(v));
    } catch (e) {}
}

function now() { return Date.now(); }

/* read-chapters registry: slug -> chapters[] (cached from detail) */
const chapterRegistry = {};   // slug -> [{number,name,url}]
const novelMetaCache = {};    // slug -> meta (title,cover,...)

function applyTheme() {
    document.body.dataset.theme = prefs.theme;
    const themeIcon = document.getElementById('navThemeBtn');
    if (themeIcon) {
        themeIcon.innerHTML = prefs.theme === 'light' || prefs.theme === 'sepia'
            ? '<i class="bi bi-moon-stars"></i>' : '<i class="bi bi-brightness-high"></i>';
    }
}
function cycleTheme() {
    const order = ['light', 'sepia', 'dark', 'amoled'];
    const i = order.indexOf(prefs.theme);
    prefs.theme = order[(i + 1) % order.length];
    savePrefs();
    showToast('Theme: ' + prefs.theme);
}

/* ---------------- Toast ---------------- */
function showToast(msg, type = '') {
    const host = document.getElementById('toastHost');
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => t.remove(), 2600);
}

/* ---------------- Shared components ---------------- */
function coverCard(s, opts = {}) {
    const img = isCoverOk(s.cover)
        ? `<img src="${esc(s.cover)}" alt="${esc(s.title)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="no-img" style="display:none"><i class="bi bi-book"></i></div>`
        : `<div class="no-img"><i class="bi bi-book"></i></div>`;
    const badge = s.status === 'full' ? '<span class="badge-tag">FULL</span>' : (s.status === 'ongoing' ? '<span class="badge-tag ongoing">Đang ra</span>' : '');
    const rating = s.rating ? `<span class="rating">★ ${s.rating}</span>` : '';
    return `<article class="cover-card" onclick="nav('/novel/${esc(s.slug)}')" data-slug="${esc(s.slug)}">
        <div class="cover-wrap">${img}${badge}</div>
        <div class="cover-info">
            <h3>${esc(s.title)}</h3>
            <div class="cover-meta">${rating}<span>${fmtViews(s.views)}</span><span>·</span><span>${s.chapterCount || 0} ch</span></div>
        </div>
    </article>`;
}
function skelGrid(n = 6) {
    let c = '';
    for (let i = 0; i < n; i++) c += `<div class="skel-card"><div class="skel skel-img"></div><div class="skel skel-line"></div><div class="skel skel-line short"></div></div>`;
    return `<div class="skel-grid">${c}</div>`;
}
function coverRail(title, items, morePath) {
    if (!items || !items.length) return '';
    return `<div class="section-title"><span>${title}</span>${morePath ? `<span class="more" onclick="nav('${morePath}')">Xem tất cả ›</span>` : ''}</div>
        <div class="hrail">${items.map(coverCard).join('')}</div>`;
}

/* ============================================================
   HOME
   ============================================================ */
async function renderHome() {
    rendermk(`
        <div class="search-bar"><i class="bi bi-search"></i>
            <input id="homeSearch" placeholder="Tìm truyện nhanh..." onkeydown="if(event.key==='Enter'){goSearch(this.value)}">
            <button class="clear" onclick="this.previousElementSibling.value='';this.previousElementSibling.focus()"><i class="bi bi-x-circle"></i></button>
        </div>
        <div id="contReading"></div>
        <div id="homeFeed">${skelGrid(6)}</div>`, 'home');

    renderContinueReading();
    try {
        const d = await api('/api/home');
        const feed = document.getElementById('homeFeed');
        feed.innerHTML =
            coverRail('Phổ biến', d.popular) +
            coverRail('Mới cập nhật', d.recentlyUpdated);
    } catch (e) {
        document.getElementById('homeFeed').innerHTML = errorBox('Không tải được dữ liệu.', true);
    }
}
function goSearch(q) {
    const qq = encodeURIComponent(q.trim());
    nav(qq ? `/search?q=${qq}` : '/search');
}

function renderContinueReading() {
    const contEl = document.getElementById('contReading');
    if (!contEl) return;
    const entries = Object.entries(progressMap).filter(([,p]) => p && p.chapterUrl);
    if (!entries.length) { contEl.innerHTML = ''; return; }
    entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    const top = entries.slice(0, 5);
    contEl.innerHTML = coverRail('Tiếp tục đọc', top.map(([slug, p]) => ({
        slug, title: p.title || slug, cover: p.cover, coverId: null,
        views: 0, chapterCount: p.totalChapters || 0, status: '', rating: null,
        _sub: `Chương ${p.chapterNum}`,
    }))) + '';
    // custom sub label via chip overlay
    contEl.querySelectorAll('.cover-card').forEach(c => {
        const slug = c.dataset.slug;
        const p = progressMap[slug];
        if (p && p.chapterNum) {
            const chip = document.createElement('div');
            chip.style.cssText = 'position:absolute;top:6px;right:6px;background:var(--accent);color:var(--accent-contrast);font-size:9px;font-weight:800;padding:1px 5px;border-radius:5px;';
            chip.textContent = 'Ch ' + p.chapterNum;
            c.querySelector('.cover-wrap').appendChild(chip);
        }
        // continue reading opens directly to last chapter
        c.onclick = (e) => { e.preventDefault(); e.stopPropagation();
            const p = progressMap[c.dataset.slug];
            if (p && p.chapterUrl) openReader(p.chapterUrl);
            else nav('/novel/' + c.dataset.slug);
        };
    });
}

/* ============================================================
   SEARCH / EXPLORE
   ============================================================ */
let searchState = { q: '', genre: '', status: '', sort: 'rating', page: 1, totalPages: 1, genres: [] };
let searchTimer = null;

function parseSearchParams(p) {
    const idx = p.indexOf('?');
    const qs = idx >= 0 ? p.slice(idx + 1) : '';
    const params = new URLSearchParams(qs);
    return {
        q: params.get('q') || '',
        genre: params.get('genre') || '',
        status: params.get('status') || '',
    };
}
async function renderSearch(p) {
    const init = parseSearchParams(p);
    searchState = Object.assign({}, searchState, init, { page: 1 });
    rendermk(`
        <div class="page-head"><h1>Tìm kiếm</h1></div>
        <div class="search-bar"><i class="bi bi-search"></i>
            <input id="searchInput" placeholder="Nhập tên truyện..." value="${esc(init.q)}" oninput="scheduleSearch()">
            <button class="clear" onclick="this.previousElementSibling.value='';scheduleSearch()"><i class="bi bi-x-circle"></i></button>
        </div>
        <div class="filters" id="genreChips"></div>
        <div class="filters" id="statusChips"></div>
        <div class="filters" id="sortChips"></div>
        <div id="resultHead" class="mut"></div>
        <div id="searchResults">${skelGrid(6)}</div>
        <div class="pager" id="pager"></div>`, 'search');

    if (!searchState.genres.length) {
        api('/api/genres').then(d => {
            searchState.genres = d.folders || [];
            renderSearchChips();
        }).catch(() => renderSearchChips());
    }
    renderSearchChips();
    runSearch();
}
function renderSearchChips() {
    const genreEl = document.getElementById('genreChips');
    if (!genreEl) return;
    const statuses = [{ v: '', l: 'Tất cả trạng thái' }, { v: 'full', l: 'FULL' }, { v: 'ongoing', l: 'Đang ra' }];
    const sorts = [{ v: 'rating', l: 'Đánh giá' }, { v: 'popular', l: 'Phổ biến' }, { v: 'newest', l: 'Chương mới' }, { v: 'title', l: 'A-Z' }];
    genreEl.innerHTML = `<button class="chip ${!searchState.genre ? 'active' : ''}" onclick="setFilter('genre','')">Tất cả thể loại</button>`
        + searchState.genres.map(g => `<button class="chip ${searchState.genre === g.slug ? 'active' : ''}" onclick="setFilter('genre','${esc(g.slug)}')">${esc(g.slug === 'khac' ? 'Khác' : g.slug)}</button>`).join('');
    const st = document.getElementById('statusChips');
    st.innerHTML = statuses.map(s => `<button class="chip ${searchState.status === s.v ? 'active' : ''}" onclick="setFilter('status','${s.v}')">${s.l}</button>`).join('');
    const so = document.getElementById('sortChips');
    so.innerHTML = `<span class="chip" style="cursor:default;color:var(--text2)">Sắp xếp</span>` + sorts.map(s => `<button class="chip ${searchState.sort === s.v ? 'active' : ''}" onclick="setFilter('sort','${s.v}')">${s.l}</button>`).join('');
}
function setFilter(kind, val) {
    if (kind === 'genre') searchState.genre = val;
    if (kind === 'status') searchState.status = val;
    if (kind === 'sort') searchState.sort = val;
    searchState.page = 1;
    renderSearchChips();
    runSearch();
}
function scheduleSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        searchState.q = document.getElementById('searchInput').value.trim();
        searchState.page = 1;
        runSearch();
    }, 250);
}
async function runSearch() {
    const el = document.getElementById('searchResults');
    const head = document.getElementById('resultHead');
    const pager = document.getElementById('pager');
    const params = new URLSearchParams({ q: searchState.q, genre: searchState.genre, status: searchState.status, sort: searchState.sort, page: searchState.page, limit: 24 });
    if (!el) return;
    el.innerHTML = skelGrid(6);
    try {
        const d = await api('/api/novels?' + params.toString());
        searchState.totalPages = d.pagination.totalPages;
        if (head) head.textContent = `${d.pagination.total} kết quả (${searchState.q ? 'từ khóa "' + searchState.q + '"' : 'tất cả'})`;
        if (!d.items.length) {
            el.innerHTML = `<div class="empty-state"><i class="bi bi-search"></i><p>Không tìm thấy truyện nào</p></div>`;
            if (pager) pager.innerHTML = '';
            return;
        }
        el.innerHTML = `<div class="cover-grid">${d.items.map(coverCard).join('')}</div>`;
        renderPager(pager, searchState.page, d.pagination.totalPages, goSearchPage);
    } catch (e) {
        el.innerHTML = errorBox('Không tải được kết quả.', true);
    }
}
function goSearchPage(p) {
    searchState.page = p;
    runSearch();
    window.scrollTo(0, 0);
}
function renderPager(el, page, total, fn) {
    if (!el) return;
    if (total <= 1) { el.innerHTML = ''; return; }
    let h = `<button ${page <= 1 ? 'disabled' : ''} onclick="window['__pg'](${page - 1})">‹</button>`;
    const s = Math.max(1, page - 2), e = Math.min(total, page + 2);
    if (s > 1) h += `<button onclick="window['__pg'](1)">1</button>`;
    if (s > 2) h += `<button class="more">…</button>`;
    for (let i = s; i <= e; i++) h += `<button class="${i === page ? 'active' : ''}" onclick="window['__pg'](${i})">${i}</button>`;
    if (e < total - 1) h += `<button class="more">…</button>`;
    if (e < total) h += `<button onclick="window['__pg'](${total})">${total}</button>`;
    h += `<button ${page >= total ? 'disabled' : ''} onclick="window['__pg'](${page + 1})">›</button>`;
    window.__pg = fn;
    el.innerHTML = h;
}

/* ============================================================
   NOVEL DETAIL
   ============================================================ */
async function renderDetail(p) {
    const slug = p.replace('/novel/', '').replace(/\/$/, '').split('?')[0];
    rendermk(`<div class="page-head"><button class="btn btn-outline btn-sm" onclick="nav('/search')">‹ Tìm kiếm</button></div>
        <div id="detailBody">${skelRows(3)}</div>`, 'detail');
    try {
        const s = await api('/api/novel/' + encodeURIComponent(slug));
        novelMetaCache[slug] = s;
        chapterRegistry[slug] = s.chapters || [];
        renderDetailBody(s);
    } catch (e) {
        document.getElementById('detailBody').innerHTML = errorBox('Không mở được truyện này.', true);
    }
}
function skelRows(n = 2) {
    let c = '';
    for (let i = 0; i < n; i++) c += `<div class="bag skel-row" style="background:var(--card);border-radius:var(--radius);padding:16px;box-shadow:var(--shadow)"><div class="skel skel-img"></div><div class="skel-body"><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line short"></div></div></div>`;
    return c;
}
function renderDetailBody(s) {
    const readSet = getReadSet(s.slug);
    const readCount = readSet.size;
    const lib = library[s.slug];
    const img = isCoverOk(s.cover)
        ? `<img class="detail-cover" src="${esc(s.cover)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="no-img" style="display:none"><i class="bi bi-book"></i></div>`
        : `<div class="no-img"><i class="bi bi-book"></i></div>`;

    let statusTxt = s.status === 'full' ? 'Hoàn thành' : 'Đang ra';
    let stLabel = s.status === 'full' ? '<span class="genre-tag" style="background:var(--ok-soft);color:var(--ok)">✔ Hoàn thành</span>' : '<span class="genre-tag" style="background:var(--accent-soft);color:var(--accent)">● Đang ra</span>';

    const libBtn = lib
        ? `<button class="btn btn-outline" onclick="toggleLibrary('${esc(s.slug)}',this)"><i class="bi bi-bookmark-check"></i> Trong thư viện</button>`
        : `<button class="btn btn-outline" onclick="toggleLibrary('${esc(s.slug)}',this)"><i class="bi bi-bookmark-plus"></i> Thêm thư viện</button>`;

    document.getElementById('detailBody').innerHTML = `
        <div class="detail-hero">
            ${img}
            <div class="detail-main">
                <h1 class="detail-title">${esc(s.title)}</h1>
                <div class="detail-tags">${s.genres && s.genres.length ? s.genres.map(g => `<span class="genre-tag">${esc(g)}</span>`).join('') : ''}${stLabel}</div>
                <div class="detail-stats">
                    <span><b>${s.rating || '–'}★</b>${stars(s.rating)}</span>
                    <span><b>${fmtViews(s.views || 0)}</b> lượt xem</span>
                    <span><b>${(s.chapters || []).length}</b> chương</span>
                    <span><b>${readCount > 0 ? readCount + '/' + (s.chapters || []).length : '—'}</b> đã đọc</span>
                </div>
                <div class="detail-actions">
                    <button class="btn btn-primary" onclick="startReading('${esc(s.slug)}')"><i class="bi bi-play-fill"></i> Đọc từ đầu</button>
                    <button class="btn btn-outline" onclick="openLatest('${esc(s.slug)}')">Chương mới nhất</button>
                    ${libBtn}
                </div>
            </div>
        </div>
        <div class="detail-desc closed" id="descBox">
            <h2>Giới thiệu</h2>
            <p>${esc(s.desc || 'Chưa có mô tả.')}</p>
            <button class="btn btn-sm btn-outline" style="margin-top:10px" onclick="document.getElementById('descBox').classList.toggle('closed')">Đọc thêm / thu gọn</button>
        </div>
        <div class="chapter-panel">
            <div class="head"><h2>Danh sách chương</h2><span class="mut">${(s.chapters || []).length} chương</span></div>
            <div class="chp-search"><i class="bi bi-search" style="color:var(--text2)"></i><input id="chpSearch" placeholder="Tìm chương..." oninput="filterChapters(this.value)"></div>
            <div class="chp-list" id="chpList"></div>
            <button class="loadmore" id="chpMore" style="display:none" onclick="showMoreChapters()">Hiện thêm chương</button>
        </div>`;
    renderChapterList(s.slug, s.chapters || []);
}

let _chpState = { slug: '', chapters: [], shown: 60 };
function renderChapterList(slug, chapters) {
    _chpState = { slug, chapters, shown: 60 };
    const html = chapters.slice(0, _chpState.shown).map(ch => renderChpItem(slug, ch)).join('') ||
        '<div class="chp-empty">Chưa có chương nào</div>';
    document.getElementById('chpList').innerHTML = html;
    document.getElementById('chpMore').style.display = chapters.length > _chpState.shown ? 'block' : 'none';
}
function renderChpItem(slug, ch) {
    const read = getReadSet(slug).has(ch.number);
    const prog = progressMap[slug];
    const isCur = prog && prog.chapterNum === ch.number;
    return `<div class="chp-item ${read ? 'read' : ''} ${isCur ? 'current' : ''}" onclick="openReader('${esc(ch.url)}')">
        <span class="chp-no">Ch ${ch.number}</span>
        <span class="chp-name">${esc(ch.name)}</span>
        ${isCur ? '<span class="chp-read">đang đọc</span>' : (read ? '<span class="chp-read"><i class="bi bi-check"></i></span>' : '')}
    </div>`;
}
function filterChapters(q) {
    q = q.trim().toLowerCase();
    const slug = _chpState.slug;
    const chs = _chpState.chapters.filter(ch =>
        !q || String(ch.number).includes(q.replace(/^chuong|^ch|\s+/g, '')) || (ch.name || '').toLowerCase().includes(q));
    document.getElementById('chpList').innerHTML = chs.map(ch => renderChpItem(slug, ch)).join('') || '<div class="chp-empty">Không có chương khớp</div>';
    document.getElementById('chpMore').style.display = 'none';
}
function showMoreChapters() {
    _chpState.shown += 120;
    renderChapterList(_chpState.slug, _chpState.chapters);
}

function getReadSet(slug) {
    const h = historyList.filter(x => x.slug === slug);
    return new Set(h.map(x => x.chapterNum));
}
function startReading(slug) {
    const prog = progressMap[slug];
    const chs = chapterRegistry[slug] || [];
    if (prog && prog.chapterUrl) openReader(prog.chapterUrl);
    else if (chs.length) openReader(chs[0].url);
    else nav('/novel/' + slug);
}
function openLatest(slug) {
    const chs = chapterRegistry[slug] || [];
    if (chs.length) openReader(chs[chs.length - 1].url);
    else nav('/novel/' + slug);
}
function toggleLibrary(slug, btn) {
    const meta = novelMetaCache[slug] || {};
    if (library[slug]) {
        delete library[slug];
        showToast('Đã bỏ khỏi thư viện', 'ok');
        if (btn) btn.innerHTML = '<i class="bi bi-bookmark-plus"></i> Thêm thư viện';
    } else {
        library[slug] = { status: 'saved', addedAt: now(), title: meta.title || slug, cover: meta.cover };
        showToast('Đã thêm vào thư viện', 'ok');
        if (btn) btn.innerHTML = '<i class="bi bi-bookmark-check"></i> Trong thư viện';
    }
    saveLibrary();
    if (curPath().startsWith('/library')) renderLibrary();
}

/* ============================================================
   LIBRARY
   ============================================================ */
let libTab = 'all';
async function renderLibrary() {
    rendermk(`
        <div class="page-head"><h1>Thư viện</h1></div>
        <div class="seg">
            <button class="${libTab === 'all' ? 'active' : ''}" onclick="setLibTab('all')">Tất cả</button>
            <button class="${libTab === 'saved' ? 'active' : ''}" onclick="setLibTab('saved')">Đã lưu</button>
            <button class="${libTab === 'reading' ? 'active' : ''}" onclick="setLibTab('reading')">Đang đọc</button>
            <button class="${libTab === 'completed' ? 'active' : ''}" onclick="setLibTab('completed')">Hoàn thành</button>
        </div>
        <div id="libList"></div>`, 'library');
    renderLibList();
}
function setLibTab(t) { libTab = t; renderLibrary(); }
function renderLibList() {
    const el = document.getElementById('libList');
    let slugs = Object.keys(library);
    if (libTab === 'saved') slugs = slugs.filter(s => !progressMap[s]);
    if (libTab === 'reading') slugs = slugs.filter(s => progressMap[s]);
    if (libTab === 'completed') slugs = slugs.filter(s => { const lib = library[s]; return lib && lib.status === 'completed'; });
    if (!slugs.length) {
        el.innerHTML = `<div class="empty-state"><i class="bi bi-bookmark"></i><p>Chưa có gì trong thư viện.<br>Bấm "Thêm thư viện" ở trang truyện.</p></div>`;
        return;
    }
    el.innerHTML = `<div class="stack">${slugs.map(slug => { const lib = library[slug]; return libItemCard(lib, slug); }).join('')}</div>`;
}
function libItemCard(lib, slug) {
    const prog = progressMap[slug];
    const sub = prog ? `Chương ${prog.chapterNum}` : (lib.status === 'completed' ? 'Hoàn thành' : 'Đã lưu');
    const img = isCoverOk(lib.cover)
        ? `<img class="li-cover" src="${esc(lib.cover)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="no-img li-cover" style="display:none"><i class="bi bi-book"></i></div>`
        : `<div class="no-img li-cover"><i class="bi bi-book"></i></div>`;
    return `<div class="list-item" onclick="openLibItem('${esc(slug)}')">
        ${img}
        <div class="li-body">
            <div class="li-title">${esc(lib.title || slug)}</div>
            <div class="li-sub">${esc(sub)}</div>
        </div>
        <div class="li-actions">
            <button class="icon-btn-sm" onclick="event.stopPropagation();markCompleted('${esc(slug)}',this)" title="Đánh dấu hoàn thành"><i class="bi bi-check2-square"></i></button>
            <button class="icon-btn-sm danger" onclick="event.stopPropagation();removeFromLib('${esc(slug)}')" title="Xóa"><i class="bi bi-trash"></i></button>
        </div>
    </div>`;
}
function openLibItem(slug) {
    const prog = progressMap[slug];
    if (prog && prog.chapterUrl) openReader(prog.chapterUrl);
    else nav('/novel/' + slug);
}
function markCompleted(slug) {
    if (library[slug]) { library[slug].status = 'completed'; saveLibrary(); }
    showToast('Đã đánh dấu hoàn thành', 'ok');
    renderLibList();
}
function removeFromLib(slug) { delete library[slug]; saveLibrary(); renderLibList(); showToast('Đã xóa'); }

/* ============================================================
   HISTORY
   ============================================================ */
function renderHistory() {
    rendermk(`
        <div class="page-head"><h1>Lịch sử đọc</h1>
            ${historyList.length ? `<button class="btn btn-outline btn-sm" onclick="clearHistory()">Xóa tất cả</button>` : ''}
        </div>
        <div id="hisList"></div>`, 'history');
    if (!historyList.length) {
        document.getElementById('hisList').innerHTML = `<div class="empty-state"><i class="bi bi-clock-history"></i><p>Chưa có lịch sử đọc.</p></div>`;
        return;
    }
    const sorted = [...historyList].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 100);
    document.getElementById('hisList').innerHTML = `<div class="stack">` + sorted.map(h => {
        const img = isCoverOk(h.cover)
            ? `<img class="li-cover" src="${esc(h.cover)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="no-img li-cover" style="display:none"><i class="bi bi-book"></i></div>`
            : `<div class="no-img li-cover"><i class="bi bi-book"></i></div>`;
        const t = new Date(h.at).toLocaleString('vi-VN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        return `<div class="list-item" onclick="openReader('${esc(h.chapterUrl)}')">
            ${img}
            <div class="li-body">
                <div class="li-title">${esc(h.title)}</div>
                <div class="li-sub">Chương ${h.chapterNum}</div>
                <div class="li-time">${t}</div>
            </div>
        </div>`;
    }).join('') + `</div>`;
}
function clearHistory() { historyList = []; saveHistory(); renderHistory(); showToast('Đã xóa lịch sử', 'ok'); }

/* ============================================================
   SETTINGS
   ============================================================ */
function renderSettings() {
    rendermk(`
        <div class="page-head"><h1>Cài đặt</h1></div>
        <div class="settings-group">
            <div class="sg-head">Giao diện</div>
            <div class="settings-row"><div><div class="sr-label">Theme</div></div>
                <div class="seg-mini" id="themeSeg">
                    ${[['light', 'Sáng'], ['sepia', 'Nâu'], ['dark', 'Tối'], ['amoled', 'AMOLED']].map(([v, l]) =>
                        `<button class="${prefs.theme === v ? 'active' : ''}" onclick="setPref('theme','${v}')">${l}</button>`).join('')}
                </div>
            </div>
            <div class="settings-row"><div><div class="sr-label">Ẩn thanh công cụ khi đọc</div><div class="sr-sub">Tự ẩn topbar & nút điều hướng</div></div>
                <div class="toggle-wrap"><span class="toggle ${prefs.autoHideNav ? 'on' : ''}" onclick="setPref('autoHideNav',${!prefs.autoHideNav})"></span></div>
            </div>
            <div class="settings-row"><div><div class="sr-label">Tự lưu vị trí đọc</div></div>
                <div class="toggle-wrap"><span class="toggle ${prefs.autoSave ? 'on' : ''}" onclick="setPref('autoSave',${!prefs.autoSave})"></span></div>
            </div>
        </div>
        <div class="settings-group">
            <div class="sg-head">Đọc</div>
            <div class="settings-row"><div><div class="sr-label">Cỡ chữ</div></div>
                <div class="stepper"><button onclick="stepFont(-1)">−</button><span id="fsVal">${prefs.fontSize}</span><button onclick="stepFont(1)">+</button></div>
            </div>
            <div class="settings-row"><div><div class="sr-label">Font chữ</div></div>
                <select id="fontSel" onchange="setPref('fontFamily',this.value)" style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:7px 10px">
                    ${[['System', 'Mặc định'], ['Georgia','Georgia (serif)'], ['Times New Roman','Times New Roman'], ['Verdana','Verdana'], ['"Segoe UI"','Segoe UI'], ['monospace','Mono']].map(([v, l]) =>
                        `<option ${prefs.fontFamily === v ? 'selected' : ''} value="${v}">${l}</option>`).join('')}
                </select>
            </div>
            <div class="settings-row"><div><div class="sr-label">Giãn dòng</div></div>
                <div class="stepper"><button onclick="stepLH(-0.2)">−</button><span id="lhVal">${prefs.lineHeight.toFixed(1)}</span><button onclick="stepLH(0.2)">+</button></div>
            </div>
            <div class="settings-row"><div><div class="sr-label">Độ rộng nội dung</div></div>
                <div class="stepper"><button onclick="stepWidth(-40)">−</button><span id="wdVal">${prefs.width}px</span><button onclick="stepWidth(40)">+</button></div>
            </div>
            <div class="settings-row"><div><div class="sr-label">Tự sang chương tiếp</div><div class="sr-sub">Khi cuộn hết chương</div></div>
                <div class="toggle-wrap"><span class="toggle ${prefs.autoNext ? 'on' : ''}" onclick="setPref('autoNext',${!prefs.autoNext})"></span></div>
            </div>
        </div>
        <div class="settings-group">
            <div class="sg-head">Dữ liệu</div>
            <div class="settings-row" onclick="nav('/thuhoaiadmin')"><div><div class="sr-label"><i class="bi bi-shield-lock"></i> Trang quản trị</div><div class="sr-sub">Banner Shopee, đăng truyện, đồng bộ dữ liệu</div></div><div class="mut">›</div></div>
            <div class="settings-row" onclick="clearAllLocal()"><div class="sr-label" style="color:#e5484d">Xóa dữ liệu local (thư viện, lịch sử, tiến độ)</div></div>
        </div>`, 'settings');
}
function setPref(k, v) { prefs[k] = v; savePrefs(); if (k === 'theme') { rerenderSettingsSeg(); applyTheme(); } renderSettingsFromPrefs(); if (curPath().startsWith('/settings')) { } }
function rerenderSettingsSeg() {
    const seg = document.getElementById('themeSeg'); if (!seg) return;
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.getAttribute('onclick').includes(`'${prefs.theme}'`)));
}
function renderSettingsFromPrefs() {
    const fs = document.getElementById('fsVal'); if (fs) fs.textContent = prefs.fontSize;
    const lh = document.getElementById('lhVal'); if (lh) lh.textContent = prefs.lineHeight.toFixed(1);
    const wd = document.getElementById('wdVal'); if (wd) wd.textContent = prefs.width + 'px';
}
function stepFont(d) { prefs.fontSize = Math.min(30, Math.max(13, prefs.fontSize + d)); savePrefs(); renderSettingsFromPrefs(); }
function stepLH(d) { prefs.lineHeight = Math.min(2.8, Math.max(1.2, +(prefs.lineHeight + d).toFixed(1))); savePrefs(); renderSettingsFromPrefs(); }
function stepWidth(d) { prefs.width = Math.min(1000, Math.max(500, prefs.width + d)); savePrefs(); renderSettingsFromPrefs(); }
function clearAllLocal() {
    if (!confirm('Xóa toàn bộ dữ liệu local? Hành động này không hoàn tác được.')) return;
    localStorage.removeItem(LS.library); localStorage.removeItem(LS.history); localStorage.removeItem(LS.progress); localStorage.removeItem(LS.unlocked);
    library = {}; historyList = []; progressMap = {};
    showToast('Đã xóa dữ liệu local', 'ok');
    renderSettings();
}

/* ============================================================
   ADMIN (protected)
   ============================================================ */
let adminToken = localStorage.getItem(LS.admin) || '';
let adminSSE = null;

function renderAdmin() {
    rendermk(`
        <div class="page-head"><h1>Quản trị</h1></div>
        <div id="adminRoot"></div>`, 'admin');
    const root = document.getElementById('adminRoot');
    if (!adminToken) {
        root.innerHTML = `
            <div class="admin-login">
                <h2>🔒 Đăng nhập Admin</h2>
                <input type="password" id="adminPw" placeholder="Mật khẩu" onkeydown="if(event.key==='Enter')doAdminLogin()">
                <button class="btn btn-primary" style="width:100%" onclick="doAdminLogin()">Đăng nhập</button>
                <div class="secret">User cần mật khẩu quản trị để đồng bộ & tải dữ liệu.</div>
            </div>`;
        return;
    }
    root.innerHTML = `
        <div class="admin-section">
            <h3><i class="bi bi-megaphone"></i> Banner mở khóa chương</h3>
            <label class="cfg-label" for="cfgBannerImage">Ảnh banner (đường dẫn file)</label>
            <input class="cfg-input" type="text" id="cfgBannerImage" placeholder="/Banner/Banner_Shopee.png">
            <label class="cfg-label" for="cfgBannerLink">Link banner (mở ra khi bấm)</label>
            <input class="cfg-input" type="text" id="cfgBannerLink" placeholder="https://s.shopee.vn/">
            <button class="btn btn-primary" style="width:100%" onclick="saveBannerConfig()">Lưu banner</button>
        </div>
        <div class="admin-section">
            <h3><i class="bi bi-pencil-square"></i> Đăng truyện mới</h3>
            <label class="cfg-label" for="publishUrl">URL hoặc slug truyện (kiwiiudammy.com)</label>
            <input class="cfg-input" type="text" id="publishUrl" placeholder="https://kiwiiudammy.com/ten-truyen.html  hoặc  ten-truyen">
            <button class="btn btn-primary" style="width:100%" onclick="adminPublish()">Đăng truyện</button>
            <div class="mut" style="margin-top:8px;font-size:12px">Nhập link truyện từ kiwiiudammy.com để tải toàn bộ chapter + ảnh bìa về web.</div>
        </div>
        <div class="admin-section">
            <h3><i class="bi bi-database"></i> Đồng bộ & Tải dữ liệu</h3>
            <div class="admin-btns">
                <button class="btn btn-primary" onclick="adminSync()">Sync danh sách</button>
                <button class="btn btn-outline" onclick="adminCheck()">Kiểm tra cập nhật (không tải)</button>
                <button class="btn btn-primary" onclick="adminFetchAll()">Tải toàn bộ dt + chapters</button>
                <button class="btn btn-outline" onclick="adminFetchCovers()">Tải ảnh cover</button>
                <button class="btn btn-outline" onclick="adminLogout()">Đăng xuất</button>
            </div>
            <div class="progress-shell hidden" id="adminProgress">
                <div class="progress-track"><div class="progress-fill" id="adminFill"></div></div>
                <div class="progress-text" id="adminText"></div>
            </div>
            <div id="adminReport"></div>
        </div>`;
    // show last status
    adminStatus();
    loadBannerConfigForm();
}
async function loadBannerConfigForm() {
    try {
        const r = await api('/api/admin/config', { headers: adminHeaders() });
        const b = (r && r.banner) || {};
        const im = document.getElementById('cfgBannerImage');
        const lk = document.getElementById('cfgBannerLink');
        if (im) im.value = b.image || '';
        if (lk) lk.value = b.link || '';
    } catch (e) { adminSessionExpired(e); }
}
async function saveBannerConfig() {
    const image = (document.getElementById('cfgBannerImage').value || '').trim();
    const link = (document.getElementById('cfgBannerLink').value || '').trim();
    try {
        const r = await api('/api/admin/config', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, adminHeaders()), body: JSON.stringify({ banner: { image, link } }) });
        const b = (r && r.banner) || {};
        if (b.image) bannerCfg.image = b.image;
        if (b.link) bannerCfg.link = b.link;
        showToast('Đã lưu banner', 'ok');
    } catch (e) { adminSessionExpired(e) || showToast('Lưu banner thất bại', 'err'); }
}
async function doAdminLogin() {
    const pw = document.getElementById('adminPw').value;
    try {
        const r = await api('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
        adminToken = r.token;
        localStorage.setItem(LS.admin, adminToken);
        showToast('Đăng nhập thành công', 'ok');
        renderAdmin();
    } catch (e) {
        showToast('Sai mật khẩu', 'err');
    }
}
function adminLogout() {
    adminToken = '';
    localStorage.removeItem(LS.admin);
    showToast('Đã đăng xuất');
    renderAdmin();
}
function adminHeaders() { return { 'x-admin-token': adminToken }; }
function adminSessionExpired(e) {
    if (e && e.message && /HTTP\s*401/.test(e.message)) {
        adminToken = '';
        localStorage.removeItem(LS.admin);
        renderAdmin();
        return true;
    }
    return false;
}
async function adminStatus() {
    try {
        const s = await api('/api/local/status', { headers: adminHeaders() });
        const txt = document.getElementById('adminText');
        if (txt) txt.textContent = `Tổng: ${s.total} truyện | Đã fetch: ${s.fetched} | Sync lần cuối: ${s.lastSync ? new Date(s.lastSync).toLocaleString('vi-VN') : 'chưa'}`;
        if (s.syncRunning) { showAdminProgress(true); }
    } catch (e) { /* not authed */ }
}
function showAdminProgress(show, text = '', pct = 0) {
    const box = document.getElementById('adminProgress');
    if (!box) return;
    if (show) box.classList.remove('hidden'); else box.classList.add('hidden');
    if (text !== undefined) document.getElementById('adminText').textContent = text;
    document.getElementById('adminFill').style.width = pct + '%';
}
async function adminSync() {
    showAdminProgress(true, 'Đang sync danh sách...', 5);
    try {
        const r = await api('/api/local/sync', { method: 'POST', headers: adminHeaders() });
        showAdminProgress(false);
        showToast(r.error ? 'Sync: ' + r.error : 'Sync xong', r.error ? 'err' : 'ok');
        if (!r.error) adminStatus();
    } catch (e) { showAdminProgress(false); showToast('Sync lỗi', 'err'); }
}
async function adminCheck() {
    adminSSE = watchAdminSSE('/api/local/sync-check', (d) => {
        if (d.page) showAdminProgress(true, `Đang kiểm tra: ${d.page}/${d.total} | Mới: ${d.new} | Cập nhật: ${d.updated}`, d.total ? d.page / d.total * 100 : 0);
    }, async () => { showAdminProgress(false); await loadAdminReport(); showToast('Xong kiểm tra', 'ok'); });
}
async function adminFetchAll() {
    adminSSE = watchAdminSSE('/api/local/fetch-all', (d) => {
        showAdminProgress(true, `Tải: ${d.detailDone}/${d.total} truyện | ${d.chapterDone} chapters | ${d.errors} lỗi`, d.total ? d.detailDone / d.total * 100 : 0);
    }, () => { showAdminProgress(false); showToast('Đã tải xong', 'ok'); adminStatus(); });
}
async function adminFetchCovers() {
    adminSSE = watchAdminSSE('/api/local/fetch-covers', (d) => {
        showAdminProgress(true, `Cover: ${d.done}/${d.total} | ${d.errors} lỗi`, d.total ? d.done / d.total * 100 : 0);
    }, () => { showAdminProgress(false); showToast('Đã tải cover xong', 'ok'); });
}
function watchAdminSSE(url, onData, onDone) {
    if (adminSSE) { adminSSE.close(); adminSSE = null; }
    showAdminProgress(true, 'Đang chạy...', 2);
    const es = new EventSource(url + (url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(adminToken));
    es.onmessage = (e) => {
        let d = {}; try { d = JSON.parse(e.data); } catch (err) {}
        if (onData) onData(d);
        if (d.complete) { es.close(); adminSSE = null; if (onDone) onDone(); }
        if (d.error) { es.close(); adminSSE = null; showAdminProgress(false); showToast(d.error, 'err'); }
    };
    es.onerror = () => { es.close(); adminSSE = null; showAdminProgress(false); showToast('Mất kết nối', 'err'); };
    return es;
}
async function loadAdminReport() {
    const el = document.getElementById('adminReport');
    if (!el) return;
    try {
        const r = await api('/api/local/check-report', { headers: adminHeaders() });
        if (r.error) { el.innerHTML = `<div class="check-report mut">${esc(r.error)}</div>`; return; }
        const nw = (r.new || []), up = (r.updated || []);
        el.innerHTML = `<div class="check-report">
            <div class="mut">Kiểm tra lúc ${new Date(r.checkedAt).toLocaleString('vi-VN')} · Mới: <b>${nw.length}</b> · Cập nhật: <b>${up.length}</b> · Không đổi: <b>${r.unchanged || 0}</b></div>
            <div class="check-cols">
                <div class="check-col"><h4>Mới (${nw.length})</h4><ul>${nw.map(s => `<li><span class="badge new">NEW</span>${esc(s.title)} <span class="mut">– ${s.chapterCount} ch</span></li>`).join('') || '<li>Không có</li>'}</ul></div>
                <div class="check-col"><h4>Cập nhật (${up.length})</h4><ul>${up.map(s => `<li><span class="badge upd">UPD</span>${esc(s.title)}<div class="mut">${esc(s.diffs.join(' · '))}</div></li>`).join('') || '<li>Không có</li>'}</ul></div>
            </div>
            ${nw.length || up.length ? `<button class="btn btn-primary" style="width:100%;margin-top:10px" onclick="adminFetchSpecified()">Tải ${nw.length + up.length} truyện cần cập nhật về</button>` : ''}
        </div>`;
    } catch (e) {}
}
async function adminPublish() {
    const input = (document.getElementById('publishUrl').value || '').trim();
    if (!input) { showToast('Nhập URL hoặc slug truyện', 'err'); return; }
    let slug = input;
    if (input.includes('/')) {
        try {
            const p = input.includes('http') ? new URL(input).pathname : input;
            slug = p.replace(/\.html?$/, '').split('?')[0].split('/').filter(Boolean).pop() || '';
        } catch (e) { showToast('URL không hợp lệ', 'err'); return; }
    }
    slug = slug.replace(/\.html?$/, '').split('/').filter(Boolean).pop() || slug;
    if (!slug) { showToast('Không xác định được slug', 'err'); return; }
    try {
        const res = await fetch('/api/local/fetch-specified', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, adminHeaders()), body: JSON.stringify({ slugs: [slug] }) });
        const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
        showAdminProgress(true, 'Đang tải...', 1);
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n\n'); buf = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                let d = {}; try { d = JSON.parse(line.slice(6)); } catch (e) {}
                if (d.complete) { showAdminProgress(false); showToast(`Đã đăng truyện: ${d.chapterDone} chương`, 'ok'); adminStatus(); const el = document.getElementById('publishUrl'); if (el) el.value = ''; }
                else if (d.detailDone) showAdminProgress(true, `Đang tải: ${d.chapterDone} chương...`, 5 + d.detailDone / d.total * 90);
                else if (d.error) { showAdminProgress(false); showToast(d.error, 'err'); }
            }
        }
    } catch (e) { showAdminProgress(false); showToast('Lỗi', 'err'); }
}
async function adminFetchSpecified() {
    try {
        const r = await api('/api/local/check-report', { headers: adminHeaders() });
        if (r.error) return;
        const slugs = [...(r.new || []).map(s => s.slug), ...(r.updated || []).map(s => s.slug)];
        if (!slugs.length) return;
        const res = await fetch('/api/local/fetch-specified', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, adminHeaders()), body: JSON.stringify({ slugs }) });
        const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
        showAdminProgress(true, 'Đang tải...', 1);
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n\n'); buf = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                let d = {}; try { d = JSON.parse(line.slice(6)); } catch (e) {}
                if (d.complete) { showAdminProgress(false); showToast(`Tải xong ${d.detailDone} truyện`, 'ok'); adminStatus(); loadAdminReport(); }
                else if (d.detailDone) showAdminProgress(true, `Tải: ${d.detailDone}/${d.total} | ${d.chapterDone} ch | ${d.errors} lỗi`, d.total ? d.detailDone / d.total * 100 : 0);
                else if (d.error) { showAdminProgress(false); showToast(d.error, 'err'); }
            }
        }
    } catch (e) { showAdminProgress(false); showToast('Lỗi', 'err'); }
}

/* ============================================================
   READER  (cốt lõi)
   ============================================================ */
let reader = {
    open: false,
    slug: '',
    chapters: [],
    idx: -1,             // current chapter index within chapters[]
    url: '',
    content: '',
    title: '',
    preloadedIdx: -1,    // idx of preloaded chapter
    preloaded: null,
    saveTimer: null,
    tocOpen: false,
    menuOpen: false,
    navHidden: false,
};

function isReaderOpen() { return reader.open; }

function openReader(url) {
    reader.open = true;
    document.getElementById('readerOverlay').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    document.getElementById('readerSkeleton').classList.remove('hidden');
    document.getElementById('readerContent').innerHTML = '';
    setReaderProgress(0);
    if (!reader.scrollAttached) {
        document.getElementById('readerContent').addEventListener('scroll', onReaderScroll, { passive: true });
        reader.scrollAttached = true;
    }
    reader.navHidden = false;
    document.getElementById('readerOverlay').classList.remove('nav-hidden');
    loadChapter(url);
    updateReaderTitle();
}
function updateReaderTitle() {
    const el = document.getElementById('readerTitle');
    const prog = progressMap[reader.slug];
    if (prog && prog.title) el.textContent = prog.title;
    else el.textContent = reader.title || 'Đọc truyện';
}
function exitReader() {
    reader.open = false;
    document.getElementById('readerOverlay').classList.add('hidden');
    document.body.style.overflow = '';
    closeReaderMenu(); closeReaderToc();
    const ad = document.getElementById('readerAdBanner');
    if (ad) ad.remove();
    document.getElementById('readerContent').innerHTML = '';
    // refresh detail page markers if visible
    const p = curPath();
    if (p.startsWith('/novel/')) { /* re-render chapter markers */ const slug = p.replace('/novel/', '').replace(/\/$/, ''); if (chapterRegistry[slug]) renderChapterList(slug, chapterRegistry[slug]); }
}
function closeAllModalsExceptReader() {
    // nothing to close on route change; reader only opens on explicit nav
}
async function loadChapter(url) {
    showReaderSkeleton(true);
    document.getElementById('readerPrev').disabled = true;
    document.getElementById('readerNext').disabled = true;
    try {
        const ch = await api('/api/local/chapter?url=' + encodeURIComponent(url));
        reader.url = url;
        reader.content = ch.content || '';
        reader.title = ch.title || '';
        reader.slug = url.replace(/\/$/, '').split('/').slice(-2)[0];

        // resolve chapter list for this story
        if (!chapterRegistry[reader.slug]) {
            try { const d = await api('/api/novel/' + encodeURIComponent(reader.slug)); chapterRegistry[reader.slug] = d.chapters || []; novelMetaCache[reader.slug] = d; } catch (e) { chapterRegistry[reader.slug] = []; }
        }
        const chs = chapterRegistry[reader.slug];
        reader.chapters = chs;
        reader.idx = chs.findIndex(c => c.url === url);
        if (reader.idx < 0) reader.idx = 0;

        renderChapter(reader.content, reader.title);
        showReaderSkeleton(false);
        setNavButtons();
        updateReaderTitle();
        applyReaderPrefs();
        reader.autoSeq = 0;
        showAdBanner(reader.idx);

        // record history + progress
        recordReading(reader.slug, reader.idx);

        // preload next chapter
        if (reader.idx + 1 < chs.length) preloadChapter(reader.idx + 1);
    } catch (e) {
        showReaderSkeleton(false);
        document.getElementById('readerContent').innerHTML = errorBox('Không tải được chương này.', true, () => loadChapter(url));
    }
}
function showReaderSkeleton(show) {
    document.getElementById('readerSkeleton').classList.toggle('hidden', !show);
    document.getElementById('readerContent').style.display = show ? 'none' : '';
    if (show) {
        document.getElementById('readerSkeleton').innerHTML =
            '<div class="skel rs-line" style="width:60%;margin:10px auto 20px;height:22px"></div>' +
            Array.from({ length: 12 }).map(() => `<div class="skel rs-line" style="${Math.random()>0.5?'width:100%':'width:'+(70+Math.random()*28)+'%'}"></div>`).join('');
    }
}
function adHost(u) { try { return new URL(u, 'http://x').host || String(u); } catch (e) { return String(u); } }
function adBannerHtml(chIdx) {
    if (chIdx < 1 || isStoryUnlocked(reader.slug)) return '';
    const img = esc(bannerCfg.image), host = adHost(bannerCfg.link), link = esc(bannerCfg.link);
    return `<div class="ad-unlock" id="readerAdBanner" onclick="unlockAndGo(event, '${link}')" role="button" tabindex="0" aria-label="Mở khóa chương truyện" style="cursor:pointer;">
        <span class="ad-unlock-banner">
            <img class="ad-unlock-img" src="${img}" alt="Banner nhà tài trợ" loading="eager">
        </span>
        <span class="ad-unlock-title"><i class="bi bi-unlock-fill"></i> Mở Khóa Chương Truyện</span>
        <span class="ad-unlock-text">Mời quý độc giả Click vào banner hoặc link để ủng hộ nhóm dịch và tiếp tục đọc chương này miễn phí.</span>
        <span class="ad-unlock-note">Bạn chỉ cần thực hiện 1 lần để mở khóa toàn bộ chương truyện!</span>
        <span class="ad-unlock-link">👉 Mở Khóa Chương Truyện: ${host}</span>
    </div>`;
}
function showAdBanner(chIdx) {
    const html = adBannerHtml(chIdx);
    if (!html) return;
    const existing = document.getElementById('readerAdBanner');
    if (existing) existing.remove();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    document.body.appendChild(wrapper.firstElementChild);
}
function unlockAndGo(e, link) {
    if (!reader.slug) return;
    unlockStory(reader.slug);
    const btn = document.getElementById('readerAdBanner');
    if (btn) btn.remove();
    showToast('Đã mở khóa toàn bộ chương truyện', 'ok');
    window.open(link, '_blank', 'noopener,noreferrer');
}
function renderChapter(content, title) {
    const el = document.getElementById('readerContent');
    const paras = content.split(/\n{2,}|\n/).filter(Boolean);
    el.innerHTML = `
        <div class="reader-chapter-title">${esc(title)}<small>${esc(reader.title)}</small></div>
        <div class="reader-para">${paras.map(p => `<p>${esc(p)}</p>`).join('')}</div>
        <div style="height:40px"></div>`;
    el.scrollTop = 0;
    // restore
    const prog = progressMap[reader.slug];
    if (prog && prog.chapterUrl === reader.url && prog.pct > 0) {
        requestAnimationFrame(() => {
            const h = el.scrollHeight - el.clientHeight;
            el.scrollTop = Math.min(h, h * (prog.pct || 0));
        });
    }
}
function setNavButtons() {
    const prev = document.getElementById('readerPrev');
    const next = document.getElementById('readerNext');
    prev.disabled = !(reader.idx > 0);
    next.disabled = !(reader.idx + 1 < reader.chapters.length);
}
function preloadChapter(idx) {
    if (reader.preloadedIdx === idx && reader.preloaded) return;
    const ch = reader.chapters[idx];
    if (!ch) return;
    fetch('/api/local/chapter?url=' + encodeURIComponent(ch.url))
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d) { reader.preloaded = d; reader.preloadedIdx = idx; } })
        .catch(() => {});
}
function recordReading(slug, idx) {
    const ch = reader.chapters[idx];
    if (!ch) return;
    const meta = novelMetaCache[slug] || {};
    const total = reader.chapters.length;
    // history (dedupe by slug+chapterNum, keep latest)
    const num = ch.number || idx + 1;
    historyList = historyList.filter(h => !(h.slug === slug && h.chapterNum === num));
    historyList.unshift({ slug, chapterUrl: ch.url, chapterNum: num, title: meta.title || slug, cover: meta.cover, at: now() });
    if (historyList.length > 500) historyList.length = 500;
    saveHistory();
    // progress
    if (prefs.autoSave) {
        if (!progressMap[slug]) progressMap[slug] = {};
        progressMap[slug] = Object.assign({}, progressMap[slug], {
            chapterUrl: ch.url, chapterNum: num, totalChapters: total, title: meta.title || slug, cover: meta.cover, at: now(),
        });
        saveProgress();
    }
    // auto-mark completed if last chapter
    if (idx >= total - 1 && library[slug]) { library[slug].status = 'completed'; saveLibrary(); }
}
let _scrollStorage = 0;
function onReaderScroll() {
    if (!reader.open) return;
    const el = document.getElementById('readerContent');
    const max = el.scrollHeight - el.clientHeight;
    const pct = max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0;
    setReaderProgress(pct * 100);

    if (prefs.autoHideNav) {
        const delta = el.scrollTop - _scrollStorage;
        _scrollStorage = el.scrollTop;
        if (Math.abs(delta) >= 2) setReaderNavHidden(false);
    }

    if (prefs.autoSave && pct > 0) {
        clearTimeout(reader.saveTimer);
        reader.saveTimer = setTimeout(() => {
            const pg = progressMap[reader.slug];
            if (pg) { pg.pct = pct; pg.at = now(); saveProgress(); }
        }, 400);
    }

    if (prefs.autoNext && pct >= 0.98 && reader.idx + 1 < reader.chapters.length) {
        const t = Date.now();
        if (!reader.autoSeq || t - reader.autoSeq > 1500) {
            reader.autoSeq = t;
            readerNav(1);
        }
    }
}
function setReaderProgress(pct) {
    const el = document.getElementById('readerProgressFill');
    if (el) el.style.width = Math.min(100, Math.max(0, pct)) + '%';
}
function setReaderNavHidden(hide) {
    if (reader.navHidden === hide) return;
    reader.navHidden = hide;
    document.getElementById('readerOverlay').classList.toggle('nav-hidden', hide);
}
function readerNav(dir) {
    const ni = reader.idx + dir;
    if (ni < 0 || ni >= reader.chapters.length) return;
    if (reader.preloadedIdx === ni && reader.preloaded) {
        reader.content = reader.preloaded.content;
        reader.title = reader.preloaded.title;
        reader.url = reader.chapters[ni].url;
        renderChapter(reader.content, reader.title);
        showReaderSkeleton(false);
        reader.idx = ni;
        recordReading(reader.slug, ni);
        setNavButtons();
        updateReaderTitle();
        showAdBanner(reader.idx);
        if (reader.idx + 1 < reader.chapters.length) preloadChapter(reader.idx + 1);
    } else {
        loadChapter(reader.chapters[ni].url);
    }
    closeReaderMenu(); closeReaderToc();
}
function readerGoto(idx) {
    if (idx < 0 || idx >= reader.chapters.length) return;
    loadChapter(reader.chapters[idx].url);
    closeReaderToc();
}
function renderToc() {
    const panel = document.getElementById('readerTocPanel');
    if (!panel) return;
    const cur = reader.idx;
    const readSet = reader.slug ? getReadSet(reader.slug) : new Set();
    panel.innerHTML = `<h3>Mục lục</h3>` + reader.chapters.map((ch, i) => {
        const num = ch.number || i + 1;
        const curCls = i === cur ? 'current' : '';
        const readCls = readSet.has(num) && i !== cur ? 'read' : '';
        return `<div class="toc-item ${curCls} ${readCls}" onclick="readerGoto(${i})"><span class="toc-no">${num}</span><span>${esc(ch.name)}</span></div>`;
    }).join('');
}
function toggleToc() {
    closeReaderMenu();
    const panel = document.getElementById('readerTocPanel');
    const open = panel.classList.contains('hidden');
    if (open) { renderToc(); panel.classList.remove('hidden'); } else closeReaderToc();
}
function closeReaderToc() {
    document.getElementById('readerTocPanel').classList.add('hidden');
    const bd = document.querySelector('.backdrop'); if (bd) bd.remove();
}
function toggleReaderMenu() {
    closeReaderToc();
    const menu = document.getElementById('readerMenu');
    const open = menu.classList.contains('hidden');
    if (open) { renderReaderMenu(); menu.classList.remove('hidden'); } else closeReaderMenu();
}
function renderReaderMenu() {
    const menu = document.getElementById('readerMenu');
    const themes = [['light', 'Sáng'], ['sepia', 'Nâu'], ['dark', 'Tối'], ['amoled', 'AMOLED']];
    menu.innerHTML = `
        <div class="rg"><label>Theme</label><div class="seg-mini">${themes.map(([v, l]) => `<button class="${prefs.theme === v ? 'active' : ''}" onclick="setReaderTheme('${v}')">${l}</button>`).join('')}</div></div>
        <div class="rg"><label>Cỡ chữ</label><div class="stepper"><button onclick="setReader('fontSize',${prefs.fontSize}-1)">−</button><span>${prefs.fontSize}</span><button onclick="setReader('fontSize',${prefs.fontSize}+1)">+</button></div></div>
        <div class="rg"><label>Font</label><select onchange="setReader('fontFamily',this.value)" style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:6px 8px">
            ${[['System','Mặc định'],['Georgia','Georgia'],['Times New Roman','Times'],['Verdana','Verdana'],['"Segoe UI"','Segoe UI'],['monospace','Mono']].map(([v,l]) => `<option ${prefs.fontFamily===v?'selected':''} value="${v}">${l}</option>`).join('')}
        </select></div>
        <div class="rg"><label>Giãn dòng</label><div class="stepper"><button onclick="setReader('lineHeight',+(prefs.lineHeight-0.2).toFixed(1))">−</button><span>${prefs.lineHeight.toFixed(1)}</span><button onclick="setReader('lineHeight',+(prefs.lineHeight+0.2).toFixed(1))">+</button></div></div>
        <div class="rg"><label>Độ rộng</label><div class="stepper"><button onclick="setReader('width',prefs.width-40)">−</button><span>${prefs.width}</span><button onclick="setReader('width',prefs.width+40)">+</button></div></div>
        <div class="rg"><label>Tự sang chương</label><div class="toggle-wrap"><span class="toggle ${prefs.autoNext?'on':''}" onclick="setReader('autoNext',${!prefs.autoNext})"></span></div></div>
        <div class="rg"><label>Tự lưu</label><div class="toggle-wrap"><span class="toggle ${prefs.autoSave?'on':''}" onclick="setReader('autoSave',${!prefs.autoSave})"></span></div></div>
        <div class="rg"><label>Ẩn thanh công cụ</label><div class="toggle-wrap"><span class="toggle ${prefs.autoHideNav?'on':''}" onclick="setReader('autoHideNav',${!prefs.autoHideNav})"></span></div></div>`;
}
function setReaderTheme(t) { prefs.theme = t; savePrefs(); applyTheme(); renderReaderMenu(); }
function setReader(k, v) {
    prefs[k] = v;
    if (k === 'fontSize') prefs.fontSize = Math.min(30, Math.max(13, v));
    if (k === 'lineHeight') prefs.lineHeight = Math.min(2.8, Math.max(1.2, v));
    if (k === 'width') prefs.width = Math.min(1000, Math.max(460, v));
    savePrefs();
    applyReaderPrefs();
    renderReaderMenu();
}
function applyReaderPrefs() {
    document.getElementById('readerContent').style.setProperty('--fs', prefs.fontSize + 'px');
    document.getElementById('readerContent').style.setProperty('--lh', prefs.lineHeight);
    document.getElementById('readerContent').style.setProperty('--ff', prefs.fontFamily === 'System' ? '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif' : prefs.fontFamily);
    document.querySelector('.reader-para')?.style.setProperty('max-width', prefs.width + 'px');
    document.querySelector('.reader-chapter-title')?.style.setProperty('max-width', prefs.width + 'px');
}
function closeReaderMenu() { document.getElementById('readerMenu').classList.add('hidden'); }

function errorBox(msg, retry, fn) {
    if (retry && fn) window.__retryFn = fn;
    return `<div class="error-state"><i class="bi bi-exclamation-triangle"></i><p>${esc(msg)}</p>${retry ? `<button class="btn btn-primary" onclick="window.__retryFn ? window.__retryFn() : location.reload()">Thử lại</button>` : ''}</div>`;
}

/* keyboard shortcuts */
document.addEventListener('keydown', (e) => {
    if (!reader.open) return;
    if (e.key === 'Escape') { closeReaderMenu(); closeReaderToc(); return; }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowRight' || e.key === ' ') readerNav(1);
    if (e.key === 'ArrowLeft') readerNav(-1);
});

/* cleanup & init */
function cleanupReader() {
    // called on hashchange; reader stays open if it opened this way
}
window.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    routeTo();
    window.addEventListener('scrollend', () => {});
});