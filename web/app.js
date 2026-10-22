/* ============================================================
   Tahoe · 液态玻璃音乐台 — 交互 + 播放控制
   音频：网易云歌曲走本地代理（<audio> + Web Audio 分析）；
         界面音效（按键音 / 换页风声）实时合成。
   UI 结构：控制台（歌单长廊 + 播放条）
   ============================================================ */
'use strict';

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/* ---------------- 状态 ---------------- */

let ctx = null, masterGain, uiGain, analyser, comp, noiseBuf;
let analyser2 = null, melData = null;   // 高分辨率分析器：粒子视界的旋律跟踪用
let playing = false;
let vol = 0.7, soundOn = true;

/* ---------------- 访问身份 ---------------- */

// 登录态由服务端按会话隔离：同源请求自动带上会话 Cookie，
// 服务器据此认出「是本机机主」还是「某个访客」，前端不需要再传任何密钥。
const A = p => p;
let OWNER = false;   // 由 /api/session 的 isOwner 更新（仅用于显示本机专属按钮）

/* ---------------- 登录凭据的存放位置 ----------------
   需求（2026-10 起）：机主登录后一直保持登录，除非手动退出。
     · 机主（桌面壳 / 本机浏览器）：凭据额外存一份到 localStorage，
       应用重启后自动恢复；退出登录时连同 sessionStorage 一起清掉。
       本机是信任域，落盘可接受。
     · 局域网访客：凭据仍然只放 sessionStorage（按标签页存活），
       关浏览器即清空 —— 访客机器上不留痕。
   旧版本曾不分机主/访客把凭据放 localStorage，这里顺手清掉那份遗留。 */
const CRED_KEY = 'ne_cookie';
const credGet = () => {
  try { const v = sessionStorage.getItem(CRED_KEY); if (v) return v; } catch { /* 隐私模式 */ }
  if (!OWNER) return null;   // 访客不落盘，也就没有可恢复的一份
  try { return localStorage.getItem(CRED_KEY); } catch { return null; }
};
const credSet = v => {
  try { sessionStorage.setItem(CRED_KEY, v); } catch { /* 隐私模式 */ }
  if (!OWNER) return;        // 只有机主（本机）持久化登录态
  try { localStorage.setItem(CRED_KEY, v); } catch { /* 隐私模式 */ }
};
const credClear = () => {
  try { sessionStorage.removeItem(CRED_KEY); } catch { /* noop */ }
  try { localStorage.removeItem(CRED_KEY); } catch { /* noop */ }
};
try { localStorage.removeItem(CRED_KEY); } catch { /* 迁移旧数据 */ }

// 从服务器取回自己的凭据存起来（机主登录成功后调用，重启后 credGet 恢复）
async function rememberCred() {
  try {
    const c = await fetch(A('/api/cookie'), { cache: 'no-store' }).then(r => r.json());
    if (c.cookie) credSet(c.cookie);
  } catch { /* 服务器未运行 */ }
}

// 带超时的 fetch：库类请求一旦卡住（上游风控 / 代理抽风 / 服务器假死），
// 十几秒后给出可见错误，而不是让「正在获取…」永远转圈
async function fetchT(url, opts = {}, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}
const netErr = e => (e && e.name === 'AbortError') ? '请求超时，服务器没有响应' : '网络错误';

/* ---------------- 网易云播放（真实音频走本地代理） ---------------- */

// 播放源只剩真实歌曲一种（原来的「生成音景」整块已移除），所以不再需要 listKind 分流
const audio = new Audio();
audio.preload = 'auto';
let mediaSrc = null;                  // MediaElementSource 只能创建一次
const ne = { list: [], idx: -1, poll: null, loaded: false, currentId: null, plName: '' };
const deadSongs = new Set();   // 播放地址解析失败的歌，列表里置灰并自动跳过
let selId = null;              // ↑↓ 选中「待播放」的歌；按 id 记，扫描重排后仍指同一首

audio.addEventListener('play', () => {
  // 元素开始出声前，确保音频上下文没有被挂起（浏览器恢复/丢弃标签页后会 suspended）
  if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch { /* noop */ } }
  playing = true; document.body.classList.add('is-playing'); updatePlayUI();
});
audio.addEventListener('pause', () => {
  playing = false; document.body.classList.remove('is-playing'); updatePlayUI();
});
audio.addEventListener('ended', () => nextTrack(1));
audio.addEventListener('loadedmetadata', () => {
  tTotal.textContent = fmt(audio.duration || 0);
  seek.setAttribute('aria-valuemax', String(Math.round(audio.duration || 0)));
});
let errStreak = 0;   // 连续播放失败计数，成功播放一次即清零
audio.addEventListener('playing', () => { errStreak = 0; });
audio.addEventListener('error', () => {
  if (!ne.list.length) return;
  const code = audio.error ? audio.error.code : 0;
  if (code === 1) return;   // 被切歌打断的旧加载，不是真失败
  const s = ne.list[ne.idx];
  if (!s) return;
  // 只处理"当前意图播放的歌"的加载失败；换源后的旧错误忽略
  if (!audio.currentSrc.includes('id=' + s.id)) return;
  deadSongs.add(s.id); renderSongCards();
  errStreak++;
  if (errStreak <= 5) {
    toast('music', `「${s.name}」无法播放，自动跳过`);
    neteasePlay(ne.idx + 1, errStreak);
  } else {
    toast('music', '连续多首无法播放，已停止跳歌');
  }
});
// 后台标签页里 rAF 会被挂起，timeupdate 仍会触发，保证进度条继续走；
// 同时兜底恢复被挂起的音频上下文，避免"进度在走但没有声音"
audio.addEventListener('timeupdate', () => {
  if (!ctx) return;
  if (ctx.state === 'suspended') { try { ctx.resume(); } catch { /* noop */ } }
  updateProgressUI();
  syncLyric();
});

/* ---------------- 音频引擎 ---------------- */

function ensureCtx() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();

  masterGain = ctx.createGain();
  masterGain.gain.value = vol * vol * 0.9;
  masterGain.connect(ctx.destination);

  uiGain = ctx.createGain();
  uiGain.gain.value = soundOn ? vol * vol * 0.6 : 0;
  uiGain.connect(ctx.destination);

  analyser = ctx.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0.72;
  analyser.connect(masterGain);

  // 粒子视界要看清旋律（200Hz~2kHz），128 点频谱每格 ≈344Hz，太粗；
  // 另接一台 2048 点的分析器，每格 ≈21Hz，才追得住音高起伏。
  // 串在 comp 与 analyser 之间，不并联到 masterGain —— 并联会让信号叠加一倍。
  analyser2 = ctx.createAnalyser();
  analyser2.fftSize = 2048;
  analyser2.smoothingTimeConstant = 0.62;
  melData = new Uint8Array(analyser2.frequencyBinCount);

  comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20; comp.knee.value = 22; comp.ratio.value = 5;
  comp.attack.value = 0.012; comp.release.value = 0.3;
  comp.connect(analyser2);
  analyser2.connect(analyser);

  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

}

/* ── 合成音景整块已移除 ──
   用户要求「把首页那几个背景音乐去掉」，于是 pad 和弦 / 五声拨音 / 海浪噪声 /
   回声链，以及它们的调度器（schedulerTick / scheduleChord / startTrack / phase）
   全部删掉。音频图只保留「播放真实歌曲 + 界面音效」要用的那部分（见 ensureCtx）。

   顺带清掉的全局状态：trackBus / padBus / delayNode / started / cur /
   anchor / chordK / nextChordTime / pendingPhase / activeSources / switchToken，
   以及 NOTE / STEP / LOOP / TRACKS / MODE_TRACK / curTrack / listKind。 */

// 拖动进度：只作用于 <audio>（音景那套"重锚相位"的逻辑随之作废）
function commitSeek(p) {
  if (audio.duration) audio.currentTime = clamp(p, 0, audio.duration - 0.5);
}

// 当前曲目总时长（没在播放时 <audio>.duration 是 NaN，兜成 0）
function total() {
  return audio.duration || 0;
}

/* ---------------- 播放控制 ---------------- */

async function togglePlay() {
  ensureCtx();
  // 不 await resume：某些环境（如远程会话没有可用音频端点）里 resume 的
  // promise 会永久挂起，把后续整条链卡死。挂起状态下继续走，
  // audio.play() / 后续播放本身就会唤醒上下文。
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  if (!audio.src) {
    // 还没有当前曲目：已经打开了歌单就从第一首开始，否则提示先去登录 / 选歌
    if (ne.list.length) { neteasePlay(Math.max(0, ne.idx)); return; }
    toast('music', '先在右上角登录，再从歌单里选一首歌');
    return;
  }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

let neToken = 0;

function neteasePlay(i, auto = 0) {
  if (!ne.list.length) return;
  if (auto === 0) errStreak = 0;      // 用户主动点歌，跳歌计数清零
  const token = ++neToken;            // 新的播放请求会让在途的旧跳歌链作废
  playFrom(i, auto, token);
}

async function playFrom(i, auto, token) {
  if (auto > 6) { toast('music', '连续多首无法播放，已停止跳歌'); return; }
  i = ((i % ne.list.length) + ne.list.length) % ne.list.length;
  const s = ne.list[i];
  if (token !== neToken) return;      // 用户已点了别的歌，本链作废
  if (deadSongs.has(s.id)) { playFrom(i + 1, auto + 1, token); return; } // 已知无法播放，静默跳过
  ensureCtx();
  // 不 await resume：某些环境（如远程会话没有可用音频端点）里 resume 的
  // promise 会永久挂起，把后续整条链卡死。挂起状态下继续走，
  // audio.play() / 后续播放本身就会唤醒上下文。
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  if (token !== neToken) return;
  let j;
  try { j = await fetch(A('/api/songurl?id=' + s.id)).then(r => r.json()); }
  catch {
    if (token === neToken) toast('music', '本地服务器未运行或已关闭');
    return;
  }
  if (token !== neToken) return;      // 等待网络期间用户已切歌

  if (!j.url) {
    // 服务器可能重启过丢了登录态：先自愈再重试一次
    const s2 = await fetch(A('/api/session'), { cache: 'no-store' }).then(r => r.json()).catch(() => ({}));
    if (token !== neToken) return;
    if (!s2.loggedIn) {
      const saved = credGet();
      if (saved) {
        try {
          const r = await fetch(A('/api/cookie'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie: saved }),
          }).then(x => x.json());
          if (r.ok) j = await fetch(A('/api/songurl?id=' + s.id)).then(x => x.json());
        } catch { /* noop */ }
        if (token !== neToken) return;
      }
    }
  }
  if (!j.url) {
    deadSongs.add(s.id); renderSongCards();
    toast('music', `「${s.name}」暂无播放权限，自动跳过`);
    playFrom(i + 1, auto + 1, token);
    return;
  }
  ne.idx = i;
  ne.currentId = s.id;
  if (!mediaSrc) { mediaSrc = ctx.createMediaElementSource(audio); mediaSrc.connect(comp); }
  audio.src = A('/stream?id=' + s.id);
  audio.play().catch(() => {});
  updateTrackUI();
  highlightRow();
  toast('music', `正在播放 · ${s.name}`);
}

function nextTrack(dir) {
  if (!ne.list.length) { toast('music', '先登录并打开一个歌单'); return; }
  // ne.idx 还没定过（-1）时：往后一首从第 0 首起，往前一首从最后一首起
  const base = ne.idx < 0 ? (dir > 0 ? -1 : 0) : ne.idx;
  neteasePlay(base + dir);
}

/* ---------------- 界面 ---------------- */

const body = document.body;

/* 桌面 App（无边框 WebView2 壳）：pywebview 版 UA 带 TahoeDesktopApp，
   C++ 壳带 TahoeCppShell。body.app-ui 打开窗口控制键 / 边缘缩放热区等
   浏览器里不需要的 UI。 */
const CPP_SHELL = /TahoeCppShell/.test(navigator.userAgent);
const IS_APP = /TahoeDesktopApp/.test(navigator.userAgent) || CPP_SHELL;
if (IS_APP) body.classList.add('app-ui');
const desk = { api: null };   // pywebview js_api 句柄，pywebviewready 后可用

/* 统一的窗口操作出口：C++ 壳走 postMessage，pywebview 版走 js_api */
function deskSend(action, arg) {
  if (CPP_SHELL) {
    window.chrome.webview.postMessage(action + (arg ? ':' + arg : ''));
    return;
  }
  if (!desk.api) return;
  if (action === 'min') desk.api.minimize();
  else if (action === 'max') desk.api.toggle_max();
  else if (action === 'close') desk.api.close_win();
  else if (action === 'fs') desk.api.toggle_fs();
  else if (action === 'rz') desk.api.edge_resize(arg);
}
const wallBtnLabel = $('#wallBtnLabel'), heroPlayLabel = $('#heroPlayLabel');
const trackNameEl = $('#trackName'), trackArtistEl = $('#trackArtist');
const seek = $('#seek'), seekFill = $('#seekFill'), seekThumb = $('.seek__thumb');
const tCur = $('#tCur'), tTotal = $('#tTotal');
const artEl = $('#art'), volEl = $('#vol');
const vizEl = $('#viz'), toastsEl = $('#toasts');

const ICONS = {
  sun: '<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4L19 19M19 5l-1.6 1.6M6.6 17.4L5 19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  moon: '<path d="M20.4 14.2A8.5 8.5 0 0 1 9.8 3.6a8.5 8.5 0 1 0 10.6 10.6Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  music: '<path d="M9 18.5V6.8c0-.5.3-.9.8-1L18 4v2.3l-7 1.5v10.7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.6" cy="18.5" r="2.2" fill="currentColor"/><circle cx="15.6" cy="16.5" r="2.2" fill="currentColor"/>',
  sparkle: '<path d="M12 3.5c.9 4 2.5 5.6 6.5 6.5-4 .9-5.6 2.5-6.5 6.5-.9-4-2.5-5.6-6.5-6.5 4-.9 5.6-2.5 6.5-6.5Z" fill="currentColor"/>',
};

function toast(type, text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="toast__icon"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[type] || ICONS.music}</svg></span><span></span>`;
  el.lastElementChild.textContent = text;
  toastsEl.appendChild(el);
  while (toastsEl.children.length > 2) toastsEl.firstElementChild.remove();
  void el.offsetWidth;
  el.classList.add('is-in');
  setTimeout(() => {
    el.classList.add('is-out');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  }, 2400);
}

// 当前曲名；还没有曲目时返回空串（播放条走空状态）
function currentName() {
  return (ne.list[ne.idx] || {}).name || '';
}

function updatePlayUI() {
  const n = currentName();
  heroPlayLabel.textContent = playing ? '暂停' : (n ? `播放${n}` : '开始播放');
  $('#playBtn').setAttribute('aria-label', playing ? '暂停' : '播放');
  highlightRow();
}

function updateTrackUI() {
  const s = ne.list[ne.idx];
  if (!s) {
    // 空状态：还没选歌 / 还没登录。播放条不装作在放什么。
    artEl.style.backgroundImage = '';
    artEl.classList.remove('has-cover');
    trackNameEl.textContent = '未播放';
    trackArtistEl.textContent = ne.list.length ? '从歌单里选一首歌' : '先在右上角登录网易云音乐';
    clearLyric();
    tTotal.textContent = fmt(0);
    seek.setAttribute('aria-valuemax', '0');
    updatePlayUI();
    return;
  }
  trackNameEl.textContent = s.name || '网易云音乐';
  trackArtistEl.textContent = (s.ar || '') + ` · 来自「${ne.plName || '歌单'}」`;
  if (s.pic) {
    artEl.style.backgroundImage = `url("${s.pic}")`;
    artEl.style.backgroundSize = 'cover';
    artEl.classList.add('has-cover');
  } else {
    artEl.style.backgroundImage = '';
    artEl.classList.remove('has-cover');
  }
  loadLyric(s);
  syncParticleCover();   // 歌词还在路上，先把封面换过去，粒子不用等
}

/* ---------------- 壁纸：跟着歌单走 ----------------

   壁纸不再是一组固定的风景图，而是**由登录后拿到的歌单生成**：
   轮播里当前居中的那张歌单 → 决定整页背景。换歌单（滚轮 / 拖动）时
   背景交叉淡入到新的一张。

   两种呈现方式，顶栏按钮 / W 键切换（选择存在 localStorage）：
     · 'cover' 模糊封面 —— 封面放大 + 高斯模糊 + 压暗铺满整页，封面感最强；
     · 'tint'  主色渐变 —— 从封面里取主色，生成一片深色环境光渐变，
                             更抽象、更统一，也不会被封面里的杂乱细节干扰。
   没有登录 / 账号里没有歌单时，退回一张**纯 CSS 生成的深色底纹**（不是照片）。

   ⚠ 配色固定 dusk（深色）：壁纸是任意封面照片，明暗完全不可控，
     只有深色底 + 浅色字才能保证在**任何**一张封面下都读得清。
     歌单卡片是唯一的例外 —— 它始终是纯白底 + 深色字（见 style.css 的 .plc），
     刻意和主题明暗解耦，因为白卡在任何壁纸上都成立。 */

const WALL_KIND_KEY = 'tahoe.wallKind';

// 无歌单时的兜底主色（冷蓝）——只影响 tintCss 的色相/饱和度
const FALLBACK_TINT = { h: 214, s: 34 };

// 兜底底纹的位图版本：粒子视界要拿它当素材（data URI 同源、不污染 canvas）
const FALLBACK_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 160">' +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0" stop-color="#16283f"/><stop offset=".55" stop-color="#0d1526"/>' +
  '<stop offset="1" stop-color="#241a3d"/></linearGradient></defs>' +
  '<rect width="240" height="160" fill="url(#g)"/></svg>');

const FALLBACK_WALL = {
  kind: 'tint', mode: 'dusk', short: '默认', name: '默认底纹',
  src: FALLBACK_SVG,
  css: tintCss(FALLBACK_TINT),
};

const bgLayers = [$('#bgLayerA'), $('#bgLayerB')];
let bgTop = 0;        // 现在盖在最上面（可见）的是哪一层
let wallToken = 0;    // 连按时用来作废「还没淡入完」的上一张

// 当前壁纸样式：'cover' 模糊封面 / 'tint' 主色渐变
let wallKind = (() => {
  try { return localStorage.getItem(WALL_KIND_KEY) === 'tint' ? 'tint' : 'cover'; }
  catch { return 'cover'; }
})();

let wallPl = null;    // 当前壁纸对应的歌单（切样式时原地重画要用）
let wallSeq = 0;      // 抽色的异步序，防止慢的那次盖掉新的

/* 主色渐变：两层柔光 + 一层深色线性底。
   做成"环境光"而不是一块死色 —— 单一纯色铺满整页会显得很平。 */
function tintCss({ h, s }) {
  const h2 = (h + 38) % 360;
  const s2 = Math.min(74, s + 14);
  const a = `hsl(${h} ${s}% 48%)`;
  const a0 = `hsl(${h} ${s}% 48% / 0)`;      // 用同色透明，不用 transparent（避免插值发黑）
  const b = `hsl(${h2} ${s2}% 40%)`;
  const b0 = `hsl(${h2} ${s2}% 40% / 0)`;
  return `radial-gradient(135% 105% at 16% 4%, ${a} 0%, ${a0} 58%),` +
         `radial-gradient(125% 115% at 88% 98%, ${b} 0%, ${b0} 62%),` +
         `linear-gradient(158deg, hsl(${h} 30% 12%) 0%, #070a12 74%, hsl(${h2} 26% 9%) 100%)`;
}

/* 从封面里取主色。实测网易云 CDN 回 Access-Control-Allow-Origin: *，
   所以 crossOrigin='anonymous' 之后 canvas 不被污染、getImageData 可读。
   万一某张图 CORS 失败 / 解码失败，resolve(null)，上层退回兜底色。 */
function extractTint(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const N = 28;
        const cv = document.createElement('canvas');
        cv.width = cv.height = N;
        const g = cv.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, N, N);
        const d = g.getImageData(0, 0, N, N).data;
        // 色相分 12 桶、按「饱和度 × 明度」加权投票。
        // 直接取平均会得到一坨灰 —— 加权投票才抓得到"这张封面看上去是什么颜色"。
        const bins = new Float32Array(12), rs = new Float32Array(12),
              gs = new Float32Array(12), bs = new Float32Array(12);
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 8) continue;
          const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
          const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), c = mx - mn;
          if (c < 0.06) continue;                 // 近灰像素不投票，否则主色被拉灰
          let hh;
          if (mx === r) hh = ((gg - b) / c) % 6;
          else if (mx === gg) hh = (b - r) / c + 2;
          else hh = (r - gg) / c + 4;
          hh = (hh * 60 + 360) % 360;
          const w = c * mx;
          const k = Math.min(11, Math.floor(hh / 30));
          bins[k] += w; rs[k] += r * w; gs[k] += gg * w; bs[k] += b * w;
        }
        let best = -1, bestW = 0;
        for (let k = 0; k < 12; k++) if (bins[k] > bestW) { bestW = bins[k]; best = k; }
        if (best < 0 || bestW <= 0) return resolve(null);
        const r = rs[best] / bestW, gg = gs[best] / bestW, b = bs[best] / bestW;
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), c = mx - mn;
        let h = 0;
        if (c > 1e-4) {
          if (mx === r) h = ((gg - b) / c) % 6;
          else if (mx === gg) h = (b - r) / c + 2;
          else h = (r - gg) / c + 4;
          h = (h * 60 + 360) % 360;
        }
        const l = (mx + mn) / 2;
        const sat = c > 1e-4 ? c / (1 - Math.abs(2 * l - 1)) : 0;
        resolve({ h: Math.round(h), s: Math.round(clamp(sat * 100, 34, 78)) });
      } catch { resolve(null); }              // canvas 被污染 / 取像素失败
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

const tintCache = new Map();    // 封面地址 → { h, s }

// 同步拿主色：没缓存就先用兜底色顶上，同时后台抽色、抽完原地重画一次
function tintOf(src) {
  const hit = tintCache.get(src);
  if (hit) return hit;
  const seq = ++wallSeq;
  extractTint(src).then(t => {
    if (!t) return;
    tintCache.set(src, t);
    if (seq === wallSeq && wallKind === 'tint' && wallPl && bigImg(wallPl.pic, 600) === src) {
      paintWall(wallForPlaylist(wallPl), true);
    }
  });
  return FALLBACK_TINT;
}

// 一张歌单对应的壁纸对象。src 始终是原始封面（粒子视界拿它当素材），
// css 才是真正铺到背景上的东西（照片 or 主色渐变）。
function wallForPlaylist(p) {
  const src = bigImg(p.pic, 600);
  return {
    kind: wallKind, mode: 'dusk', short: p.name || '歌单', name: p.name || '',
    src,
    css: wallKind === 'tint' ? tintCss(tintOf(src)) : `url("${src}")`,
  };
}

function curWall() { return wallPl ? wallForPlaylist(wallPl) : FALLBACK_WALL; }

/* 把新壁纸写进「下层」那张，用 inline z-index 提到最上，再淡入盖住旧的那张。
   旧层全程保持 opacity:1 待在下层，所以淡入过程中不会有深色底透出来的暗闪。
   animate=false 给首屏用：直接上，不淡入。 */
function paintWall(w, animate) {
  const root = document.documentElement;
  const incoming = bgLayers[1 - bgTop];
  const outgoing = bgLayers[bgTop];
  const token = ++wallToken;

  incoming.style.backgroundImage = w.css;
  // 模糊 + 压暗只给照片层加：渐变本身就是平滑的，再模糊一遍纯属浪费 GPU
  incoming.classList.toggle('is-photo', w.kind === 'cover');
  incoming.style.zIndex = '2';
  outgoing.style.zIndex = '1';

  const swap = () => {
    if (token !== wallToken) return;   // 期间又切了一张，这次作废
    incoming.classList.add('is-on');
    outgoing.classList.remove('is-on');
    bgTop = 1 - bgTop;
    root.dataset.mode = w.mode;        // 固定 dusk，这里只是兜一层保险
  };

  if (!animate) { swap(); return; }
  // 照片要先解码完再淡入，否则第一帧还是空的就开始淡，会闪一下深色底；
  // 渐变是即时的，等一帧让初始样式落地就够了。
  if (w.kind !== 'cover') { requestAnimationFrame(swap); return; }
  const pre = new Image();
  pre.onload = swap;
  pre.onerror = swap;                  // 解码失败也别把界面卡住
  pre.src = w.src;
}

function updateWallUI() {
  const btn = $('#wallBtn');
  const isTint = wallKind === 'tint';
  const label = isTint ? '主色' : '封面';
  wallBtnLabel.textContent = label;
  btn.dataset.kind = wallKind;         // 图标跟着样式切（见 style.css）
  btn.setAttribute('aria-label', `壁纸样式：${isTint ? '主色渐变' : '模糊封面'}`);
  btn.title = `壁纸样式：${isTint ? '主色渐变' : '模糊封面'}（点击或按 W 切换）`;
}

/* W / 顶栏按钮：切换壁纸的**呈现方式**（模糊封面 ↔ 主色渐变）。
   换"哪一张壁纸"是滚轮 / 拖动换歌单，这里只管样式 —— 两者正交，互不干扰。 */
function switchWall() {
  wallKind = wallKind === 'tint' ? 'cover' : 'tint';
  try { localStorage.setItem(WALL_KIND_KEY, wallKind); } catch { /* noop */ }
  updateWallUI();
  paintWall(curWall(), true);
  whoosh();
  toast('sparkle', wallKind === 'tint' ? '壁纸：封面主色渐变' : '壁纸：模糊封面');
  syncParticleCover();                 // 换样式后粒子素材也跟着换
}

/* 轮播「最靠中间的那张」变了 → 停手 260ms 后把壁纸换成它的封面 / 主色。
   防抖是必须的：拖动时 centerIdx 会一路变，逐张换壁纸既费解码又晃眼。 */
let wallSyncT = 0;
function syncWallToCenter() {
  clearTimeout(wallSyncT);
  wallSyncT = setTimeout(() => {
    const p = ((plCache && plCache.items) || [])[carousel.centerIdx];
    if (!p || !p.pic) { resetWall(); return; }
    if (wallPl && String(wallPl.id) === String(p.id) && wallPl.pic === p.pic) return;
    wallPl = p;
    paintWall(wallForPlaylist(p), true);
    updateWallUI();
    syncParticleCover();
  }, 260);
}

// 没有歌单可依（未登录 / 空账号 / 退出登录）→ 回到纯 CSS 底纹
function resetWall() {
  if (!wallPl) return;
  wallPl = null;
  paintWall(FALLBACK_WALL, true);
  updateWallUI();
}

/* ---------------- 横幅上的一句随机歌词 ----------------

   首屏横幅原来写死一句品牌语（「把湖面，装进一块玻璃里。」），
   现在换成**一句随机歌词**，每次进页面换一句。

   两级来源：
     ① 内置的这批歌词 —— 在解析期就定下来（不会闪占位文案）、离线可用，
        也是未登录时唯一的来源；
     ② 登录之后从账号里随机挑一首歌、拉它的真歌词换上去。
        只换一次，而且带过渡 —— 拉不到就保持内置那句，静默跳过。
   大字是歌词本身，小字是出处（歌手 · 歌名）。 */

const LYRIC_POOL = [
  { t: '我曾经跨过山和大海', s: '朴树 · 平凡之路' },
  { t: '也穿过人山人海', s: '朴树 · 平凡之路' },
  { t: '我听见风来自地铁和人海', s: '孙燕姿 · 遇见' },
  { t: '我排着队拿着爱的号码牌', s: '孙燕姿 · 遇见' },
  { t: '我怀念的是无话不说', s: '孙燕姿 · 我怀念的' },
  { t: '我要一步一步往上爬', s: '周杰伦 · 蜗牛' },
  { t: '最美的不是下雨天', s: '周杰伦 · 不能说的秘密' },
  { t: '你说把爱渐渐放下会走更远', s: '周杰伦 · 蒲公英的约定' },
  { t: '再给我两分钟', s: '周杰伦 · 最长的电影' },
  { t: '每一次都在徘徊孤单中坚强', s: '张韶涵 · 隐形的翅膀' },
  { t: '后来我总算学会了如何去爱', s: '刘若英 · 后来' },
  { t: '有些人一旦错过就不再', s: '刘若英 · 后来' },
  { t: '我愿意为你被放逐天际', s: '王菲 · 我愿意' },
  { t: '但愿人长久千里共婵娟', s: '王菲 · 但愿人长久' },
  { t: '因为爱情不会轻易悲伤', s: '陈奕迅 / 王菲 · 因为爱情' },
  { t: '陪你把沿路感想活出了答案', s: '陈奕迅 · 陪你度过漫长岁月' },
  { t: '我还是从前那个少年', s: '梦然 · 少年' },
  { t: '我曾将青春翻涌成她', s: '买辣椒也用券 · 起风了' },
  { t: '夜空中最亮的星能否听清', s: '逃跑计划 · 夜空中最亮的星' },
  { t: '我祈祷拥有一颗透明的心灵', s: '逃跑计划 · 夜空中最亮的星' },
  { t: '生活不止眼前的苟且', s: '许巍 · 生活不止眼前的苟且' },
  { t: '还有诗和远方的田野', s: '许巍 · 生活不止眼前的苟且' },
  { t: '明天你好含着泪微笑', s: '牛奶咖啡 · 明天，你好' },
  { t: '越长大越孤单', s: '牛奶咖啡 · 越长大越孤单' },
  { t: '世界这么大还是遇见你', s: '程响 · 世界这么大还是遇见你' },
  { t: '我们的爱过了就不再回来', s: 'F.I.R. · 我们的爱' },
  { t: '当你孤单你会想起谁', s: '张栋梁 · 当你孤单你会想起谁' },
  { t: '如果大海能够唤回曾经的爱', s: '张雨生 · 大海' },
  { t: '我的未来不是梦', s: '张雨生 · 我的未来不是梦' },
  { t: '我想要怒放的生命', s: '汪峰 · 怒放的生命' },
  { t: '多少人曾爱慕你年轻时的容颜', s: '水木年华 · 一生有你' },
  { t: '月亮代表我的心', s: '邓丽君 · 月亮代表我的心' },
  { t: '越过山丘虽然已白了头', s: '李宗盛 · 山丘' },
  { t: '你我皆凡人生在人世间', s: '李宗盛 · 凡人歌' },
  { t: '突然好想你你会在哪里', s: '五月天 · 突然好想你' },
  { t: '我和我最后的倔强', s: '五月天 · 倔强' },
  { t: '逆风的方向更适合飞翔', s: '五月天 · 倔强' },
  { t: '明天你是否会想起', s: '老狼 · 同桌的你' },
  { t: '当你老了头发白了', s: '赵照 · 当你老了' },
  { t: '风继续吹不忍远离', s: '张国荣 · 风继续吹' },
  { t: '我就是我是颜色不一样的烟火', s: '张国荣 · 我' },
  { t: '原谅我这一生不羁放纵爱自由', s: 'Beyond · 海阔天空' },
  { t: '喜欢你那双眼动人', s: 'Beyond · 喜欢你' },
  { t: '一生所爱隐约在白云外', s: '卢冠廷 · 一生所爱' },
  { t: '岁月是一场有去无回的旅行', s: '金玟岐 · 岁月神偷' },
  { t: '你曾是少年', s: 'S.H.E · 你曾是少年' },
];

const heroEyebrowEl = $('#heroEyebrow'), heroTitleEl = $('#heroTitle');
let heroLyric = null;

function pickHeroLyric() {
  const pool = LYRIC_POOL;
  let i = Math.floor(Math.random() * pool.length);
  // 别和上一句撞 —— 连着两次一样，比"随机"更像卡住了
  if (pool.length > 1 && heroLyric && pool[i].t === heroLyric.t) i = (i + 1) % pool.length;
  return pool[i];
}

// animate=true 用于"换词"：先淡出上移、落定后再淡入（见 style.css 的 .is-swapping）
function setHeroLyric(l, animate) {
  if (!heroTitleEl) return;
  heroLyric = l;
  const apply = () => {
    heroTitleEl.textContent = l.t;
    if (heroEyebrowEl) heroEyebrowEl.textContent = l.s || '歌词 · 随机一句';
  };
  if (!animate) { apply(); return; }
  heroTitleEl.classList.add('is-swapping');
  if (heroEyebrowEl) heroEyebrowEl.classList.add('is-swapping');
  setTimeout(() => {
    apply();
    heroTitleEl.classList.remove('is-swapping');
    if (heroEyebrowEl) heroEyebrowEl.classList.remove('is-swapping');
  }, 260);
}

// 首屏就定下来：这段在解析期同步跑完，占位文案不会被画出来
setHeroLyric(pickHeroLyric(), false);

// 从 LRC 里挑一句"像歌词"的：跳过时间标签、空行，以及太短/太长的行
// （太短的像语气词，太长的会把横幅顶成三行）
function pickLyricLine(lrc) {
  const lines = parseLrc(lrc).map(l => l.text.trim())
    .filter(t => t && !/^[\[(]/.test(t) && t.length >= 6 && t.length <= 24);
  return lines.length ? lines[Math.floor(Math.random() * lines.length)] : '';
}

/* 登录后从账号里随机捞一句真歌词换上去。
   这条链路纯粹是锦上添花：任何一步失败都静默跳过，保持内置那句。 */
let heroRealTried = false;
async function upgradeHeroLyricFromAccount() {
  if (heroRealTried) return;
  heroRealTried = true;
  const items = (plCache && plCache.items) || [];
  if (!items.length) return;
  try {
    const pl = items[Math.floor(Math.random() * items.length)];
    const pj = await fetchT(A(pl.liked ? '/api/liked' : '/api/playlist?id=' + encodeURIComponent(pl.id)))
      .then(r => r.json());
    const tracks = Array.isArray(pj.tracks) ? pj.tracks : [];
    if (!tracks.length) return;
    const s = tracks[Math.floor(Math.random() * tracks.length)];
    const lj = await fetchT(A('/api/lyric?id=' + s.id)).then(r => r.json());
    const line = pickLyricLine(lj.lrc || '');
    if (!line) return;
    setHeroLyric({ t: line, s: [s.ar, s.name].filter(Boolean).join(' · ') }, true);
  } catch { /* 拉不到就保持内置那句 */ }
}

/* ---------------- 按键音 / 风声反馈 ---------------- */

function blip(freq = 1350) {
  if (!ctx || !soundOn) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(freq, t);
  o.frequency.exponentialRampToValueAtTime(freq * 0.72, t + 0.07);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.05, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  o.connect(g); g.connect(uiGain);
  o.start(t); o.stop(t + 0.1);
}

function whoosh() {
  if (!ctx || !soundOn) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource(); src.buffer = noiseBuf;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
  bp.frequency.setValueAtTime(420, t);
  bp.frequency.exponentialRampToValueAtTime(2600, t + 0.26);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.06, t + 0.08);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  src.connect(bp); bp.connect(g); g.connect(uiGain);
  src.start(t); src.stop(t + 0.32);
}

/* ---------------- 事件绑定 ---------------- */

// 所有按钮：按下瞬间给出声音反馈（因果同帧）
document.addEventListener('pointerdown', e => {
  const b = e.target.closest('button');
  if (!b) return;
  ensureCtx();
  if (b.id === 'wallBtn') whoosh(); else blip();
}, true);

// 鼠标点完按钮就把焦点交还 document。否则按钮会一直持有焦点，
// 之后按空格 / 回车会被这个按钮的原生 click 抢走（快捷键看起来像失灵）。
// e.detail > 0 说明这次 click 来自鼠标；键盘（Tab + 回车）触发的是 0，那时要保留焦点。
document.addEventListener('click', e => {
  if (e.detail === 0) return;
  const b = e.target.closest('button');
  if (b) b.blur();
}, true);

$('#wallBtn').addEventListener('click', switchWall);
$('#playBtn').addEventListener('click', togglePlay);
$('#heroPlayBtn').addEventListener('click', togglePlay);
$('#heroNextBtn').addEventListener('click', () => nextTrack(1));
$('#prevBtn').addEventListener('click', () => nextTrack(-1));
$('#nextBtn').addEventListener('click', () => nextTrack(1));

volEl.addEventListener('input', () => {
  vol = volEl.value / 100;
  volEl.style.setProperty('--v', volEl.value + '%');
  if (ctx) {
    masterGain.gain.setTargetAtTime(vol * vol * 0.9, ctx.currentTime, 0.05);
    uiGain.gain.setTargetAtTime(soundOn ? vol * vol * 0.6 : 0, ctx.currentTime, 0.05);
  }
});

$('#soundBtn').addEventListener('click', () => {
  soundOn = !soundOn;
  $('#soundBtn').setAttribute('aria-pressed', String(soundOn));
  if (ctx) uiGain.gain.setTargetAtTime(soundOn ? vol * vol * 0.6 : 0, ctx.currentTime, 0.03);
  if (soundOn) blip(1600);
  toast('sparkle', soundOn ? '按键音效已开启' : '按键音效已关闭');
});

// 进度条：Pointer Capture，1:1 跟手，松手落定
let scrubFrac = null;
const fracFrom = e => {
  const r = seek.getBoundingClientRect();
  return clamp((e.clientX - r.left) / r.width, 0, 1);
};
seek.addEventListener('pointerdown', e => {
  seek.setPointerCapture(e.pointerId);
  scrubFrac = fracFrom(e);
  seek.classList.add('is-scrubbing');
});
seek.addEventListener('pointermove', e => { if (scrubFrac !== null) scrubFrac = fracFrom(e); });
const endScrub = () => {
  if (scrubFrac === null) return;
  const p = scrubFrac * total();
  scrubFrac = null;
  seek.classList.remove('is-scrubbing');
  commitSeek(p);
};
seek.addEventListener('pointerup', endScrub);
seek.addEventListener('pointercancel', endScrub);

// 键盘
const pos = () => (scrubFrac !== null ? scrubFrac * total() : (audio.currentTime || 0));

addEventListener('keydown', e => {
  if (e.repeat) return;
  // 焦点在输入框 / 按钮 / 链接上时不抢按键：空格和回车在那些元素上本来就有原生行为
  const ae = document.activeElement;
  if (ae && (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(ae.tagName) || ae.isContentEditable)) return;
  if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') {
    e.preventDefault(); spaceAction();       // 空格和回车都是播放 / 暂停
  }
  else if (e.code === 'KeyW') switchWall();
  else if (e.code === 'KeyM') nextTrack(1);
  else if (e.code === 'Escape') {
    if (window.ParticleStage && ParticleStage.isOpen()) setParticleOpen(false);
    else if (loginPop.classList.contains('is-open')) setLoginOpen(false);
    else if (songOpen) setSongOpen(false);   // 歌单详情页滑回歌单墙
  }
  else if (e.code === 'ArrowUp') { e.preventDefault(); stepList(-1); }
  else if (e.code === 'ArrowDown') { e.preventDefault(); stepList(1); }
  else if (e.code === 'Home' && songOpen && ne.list.length) { e.preventDefault(); selId = ne.list[0].id; applySel(true); }
  else if (e.code === 'End' && songOpen && ne.list.length) { e.preventDefault(); selId = ne.list[ne.list.length - 1].id; applySel(true); }
  else if (e.code === 'ArrowRight') commitSeek(pos() + 5);
  else if (e.code === 'ArrowLeft') commitSeek(pos() - 5);
});

// ↑↓ 在卡片墙上移动「待播放」光标：只选中不播放，空格确认后才播。
// 散点没有行列，按列表序一次走 3 首，并把那首歌平移到画面正中。
function stepList(dir) {
  if (!ne.list.length) return;
  if (!songOpen) setSongOpen(true);   // 光标要落到卡片上，先进详情页
  const base = selId != null
    ? ne.list.findIndex(t => t.id === selId)
    : (ne.idx >= 0 ? ne.idx : -1);
  const i = (base + dir * 3 + ne.list.length) % ne.list.length;
  selId = ne.list[i].id;
  applySel(true);
  blip(1150);
}

// 把选中态画到卡片上：选中卡套主题色描边并滚到可视区中央
function applySel(scroll = false) {
  let selCard = null;
  for (const li of songWall.querySelectorAll('.scard')) {
    const i = Number(li.dataset.i);
    const on = selId != null && ne.list[i] && ne.list[i].id === selId;
    li.classList.toggle('is-sel', on);
    if (on) selCard = li;
  }
  if (scroll && selCard) {
    if (selCard.hidden) { libSearch.value = ''; applyFilter(); }  // 选中卡被搜索过滤掉时先放开过滤
    panToCard(selId);   // 散点没有滚动条：把选中的歌平移到画面正中
  }
}

// 空格：有选中的歌就播它（选中的正是当前曲则变成播放/暂停），没有就照旧切换
function spaceAction() {
  if (selId != null && ne.list.length) {
    const i = ne.list.findIndex(t => t.id === selId);
    if (i >= 0) {
      const resume = ne.idx === i;
      selId = null;
      applySel();
      if (resume) togglePlay(); else neteasePlay(i);
      return;
    }
  }
  togglePlay();
}

/* ---------------- 面板开关：歌单（下方，对齐主视觉） ----------------
   歌词抽屉已移除（歌词现在只服务粒子视界，没有独立面板）。
   播放条上原本的「词」按钮、L 键、Esc 收起都一并去掉了。 */

const listBtn = $('#listBtn');

function setListOpen(open) {
  body.classList.toggle('list-closed', !open);
  listBtn.setAttribute('aria-expanded', String(open));
}

listBtn.addEventListener('click', () => {
  if (songOpen) { setSongOpen(false); return; }   // 详情页里点「音乐列表」= 回歌单墙
  setListOpen(body.classList.contains('list-closed'));
});

// 玻璃卡片上的液态高光跟随光标；光标离开时把透镜滑出下缘，不在原地冻住
for (const el of document.querySelectorAll('.glass--liquid, .panel')) {
  el.addEventListener('pointermove', e => {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', (e.clientX - r.left).toFixed(1) + 'px');
    el.style.setProperty('--my', (e.clientY - r.top).toFixed(1) + 'px');
  });
  el.addEventListener('pointerleave', () => {
    el.style.setProperty('--my', '120%');
  });
}

/* ---------------- 控制台尺寸 ---------------- */

// 面板常驻，控制台高度固定占位 → 舞台据此留白，主视觉不会被压住。
// 顺便量出播放条与顶栏的高度：歌词抽屉和登录浮层要按它们定位（底部对齐播放条等）。
const consoleEl = $('#console');
const topbarEl = document.querySelector('.topbar');
const barEl = consoleEl.querySelector('.console__bar');

function measureConsole() {
  const root = document.documentElement.style;
  root.setProperty('--console-h', consoleEl.offsetHeight + 'px');
  if (barEl) root.setProperty('--bar-h', barEl.offsetHeight + 'px');
  if (topbarEl) root.setProperty('--topbar-h', topbarEl.offsetHeight + 'px');
}
if (window.ResizeObserver) new ResizeObserver(measureConsole).observe(consoleEl);
addEventListener('resize', measureConsole);

/* ---------------- 登录浮层（右上角按钮呼出） ---------------- */

const loginPop = $('#loginPop'), loginBody = $('#loginBody');
const loginBtn = $('#loginBtn'), loginBtnLabel = $('#loginBtnLabel');
let acct = { loggedIn: false, nickname: '', avatar: '', isOwner: false };

function setLoginOpen(open) {
  loginPop.classList.toggle('is-open', open);
  loginPop.setAttribute('aria-hidden', String(!open));
  loginBtn.setAttribute('aria-expanded', String(open));
  if (open) renderLogin();
  else stopPoll();          // 浮层收起来就别再轮询二维码了
}

loginBtn.addEventListener('click', () => setLoginOpen(!loginPop.classList.contains('is-open')));

// 点浮层外面收起（capture 阶段，先于按钮自身的 click 判断）
document.addEventListener('pointerdown', e => {
  if (!loginPop.classList.contains('is-open')) return;
  if (loginPop.contains(e.target) || loginBtn.contains(e.target)) return;
  setLoginOpen(false);
}, true);

// 把会话信息同步到按钮和浮层
function applyAcct(s) {
  OWNER = !!s.isOwner;   // 每次会话响应都同步（扫码/Cookie 登录流程不走 initLibrary）
  acct = {
    loggedIn: !!s.loggedIn,
    nickname: s.nickname || '',
    avatar: s.avatar || '',
    isOwner: !!s.isOwner,
  };
  loginBtnLabel.textContent = acct.loggedIn ? (acct.nickname || '已登录') : '登录';
  body.classList.toggle('is-logged', acct.loggedIn);
  const searchWrap = $('#libSearchWrap');
  if (searchWrap) searchWrap.hidden = !acct.loggedIn;   // 顶栏搜索跟着登录态走
  if (loginPop.classList.contains('is-open')) renderLogin();
}

// 浮层内容随登录态切换：没登录 → 扫码；已登录 → 账号卡片
function renderLogin() {
  if (!acct.loggedIn) { showQR(); return; }
  loginBody.innerHTML = `
    <div class="acct">
      <div class="acct__ava"></div>
      <div>
        <div class="acct__name">${esc(acct.nickname || '网易云音乐')}</div>
        <div class="acct__sub">已登录 · ${acct.isOwner ? '服务器本机账号' : '你自己的账号'}</div>
      </div>
    </div>
    <span class="qr-alt">
      <button type="button" class="btn btn--ghost" id="acctRefresh">刷新歌单</button>
      <button type="button" class="btn btn--ghost" id="acctLogout">退出登录</button>
    </span>`;
  // 头像用 JS 赋 background-image，避免把外部 URL 拼进 style 属性里
  const ava = loginBody.querySelector('.acct__ava');
  if (ava && /^https:\/\//.test(acct.avatar)) ava.style.backgroundImage = `url("${acct.avatar}")`;
  $('#acctRefresh').addEventListener('click', () => { setLoginOpen(false); plCache = null; loadPlWall(); });
  $('#acctLogout').addEventListener('click', () => { setLoginOpen(false); logout(); });
}

/* ---------------- 音乐库（页面中部的歌单长廊） ---------------- */

const songPage = $('#songPage'), songWall = $('#songWall'), songBgImg = $('#songBgImg');
const songTitle = $('#songTitle'), songSub = $('#songSub');
const libSearch = $('#libSearch'), libSearchWrap = $('#libSearchWrap'), libEmpty = $('#libEmpty');
const searchPop = $('#searchPop');
let searchSeq = 0, searchDebT = 0, searchHot = -1, searchRows = [];   // 云端联想状态
const plWall = $('#plWall'), galViewport = $('#galViewport');

$('#lanBtn').addEventListener('click', showLAN);
$('#rescanBtn').addEventListener('click', showRescan);
$('#songBack').addEventListener('click', () => setSongOpen(false));

/* ── 歌单详情页：点开歌单后进入的全屏页面 ──
   背景是歌单封面的程序化派生（放大 + 高斯模糊 + 压暗），
   歌曲渲染成一张张带播放按钮的卡片（renderSongCards）。 */
let songOpen = false;

function setSongOpen(open) {
  if (songOpen === open) return;
  songOpen = open;
  if (!open) stopGlide();
  songPage.classList.toggle('is-open', open);
  songPage.setAttribute('aria-hidden', String(!open));
  body.classList.toggle('songs-open', open);
  if (!open) applyFilter();   // 回长廊：按当前关键词重新压暗歌单卡（清掉详情页的歌过滤残留）
  blip(open ? 1240 : 980);
}

// 详情页背景：CDN 发给列表的是 120y120 小图，背景换成大图再交给 CSS 模糊。
// 清空时不能 removeAttribute('src')：没有 src 的 <img> 会被当成加载失败的图片
// （截图工具的图片检查、以及部分浏览器的破图占位都会命中），
// 所以统一退回一张 1×1 透明 GIF。index.html 里初值也是这张。
const BLANK_IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
function setSongBg(url) {
  if (!url) { songBgImg.classList.remove('is-in'); songBgImg.src = BLANK_IMG; return; }
  const src = String(url).replace(/param=\d+y\d*/, 'param=500y500');
  if (songBgImg.getAttribute('src') === src) return;
  songBgImg.classList.remove('is-in');
  songBgImg.onload = () => songBgImg.classList.add('is-in');
  songBgImg.src = src;
}

// 当前打开的歌单 id（'' = 我喜欢的音乐）与歌单目录缓存
let curPlId = rememberedPl() || '';
let plCache = null;

function rememberedPl() {
  try { return localStorage.getItem('ne_plid') || ''; } catch { return ''; }
}

// quiet=true 用于页面启动时的自动载入：结果直接看得见，不必再弹提示
async function initLibrary(quiet = false) {
  plWall.innerHTML = '<p class="panel__note">正在连接网易云音乐…</p>';
  let s;
  try {
    s = await fetchT(A('/api/session'), { cache: 'no-store' }).then(r => r.json());
  } catch {
    plWall.innerHTML = '<p class="panel__note">本地服务器未运行或没有响应。<br>双击网站目录的 <strong>启动音乐站.bat</strong>，<br>或执行 <strong>python server.py</strong> 后刷新本页。</p>';
    return;
  }
  OWNER = !!s.isOwner;
  $('#lanBtn').hidden = !OWNER;
  $('#rescanBtn').hidden = !OWNER;
  applyAcct(s);
  if (s.loggedIn) { loadPlWall(quiet); return; }

  // 服务端内存登录态没了时，用记住的凭据自动恢复：
  // 机主先翻 sessionStorage，再翻 localStorage（credGet）；访客只有 sessionStorage
  const saved = credGet();
  if (saved) {
    plWall.innerHTML = '<p class="panel__note">正在恢复登录…</p>';
    let r = { ok: false };
    try {
      r = await fetchT(A('/api/cookie'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie: saved }),
      }).then(x => x.json());
    } catch { /* 服务器未运行 */ }
    if (r.ok) {
      const s2 = await fetch(A('/api/session'), { cache: 'no-store' }).then(x => x.json()).catch(() => ({}));
      if (s2.loggedIn) { applyAcct(s2); loadPlWall(quiet); return; }
    }
    credClear(); // 记忆的登录态已失效
  }
  showLoggedOut();
}

// 未登录时长廊里不再放登录 UI，只留一句指向右上角按钮的提示
function showLoggedOut() {
  libSearchWrap.hidden = true;
  // 比长廊里其它状态（加载中 / 出错 / 空歌单）多一行：它要同时交代
  // 「为什么空」和「怎么办」，所以拆成主信息 + 操作说明两级，而不是一段三行
  plWall.innerHTML =
    '<div class="panel__empty">' +
      '<p class="panel__empty-lead">还没有登录网易云音乐</p>' +
      '<p class="panel__empty-desc">点右上角的 <strong>登录</strong>，扫码或粘贴 Cookie，<br>登录<strong>你自己的账号</strong>。</p>' +
    '</div>';
  songWall.innerHTML = '';
  resetWall();     // 壁纸是从歌单生成的，没歌单了就退回纯 CSS 底纹
}

async function logout() {
  try { await fetch(A('/api/logout'), { method: 'POST' }); } catch { /* 服务器未运行 */ }
  credClear();
  ne.list = []; ne.idx = -1; ne.currentId = null; ne.loaded = false; selId = null;
  ne.plName = ''; curPlId = ''; plCache = null;
  try { localStorage.removeItem('ne_plid'); } catch { /* 隐私模式等 */ }
  deadSongs.clear();
  try { audio.pause(); } catch { /* noop */ } audio.removeAttribute('src');
  setSongOpen(false);
  applyAcct({ loggedIn: false, isOwner: OWNER });   // isOwner 与登录无关，别在这里误清
  toast('music', '已退出登录');
  initLibrary(true);
}

async function showQR() {
  loginBody.innerHTML = '<p class="panel__note">正在获取登录二维码…</p>';
  let k;
  try { k = await fetchT(A('/api/qr/key')).then(r => r.json()); }
  catch { loginBody.innerHTML = '<p class="panel__note">获取登录码失败，请确认服务器已运行。</p>'; return; }
  if (!k.key) { loginBody.innerHTML = '<p class="panel__note">获取登录码失败，请点下方按钮重试。</p>'; return; }
  loginBody.innerHTML = `
    <div class="panel__note">
      <img class="qr" alt="网易云音乐登录二维码" src="${A('/api/qr/img?key=' + encodeURIComponent(k.key))}">
      用网易云音乐 App 首页右上角的<strong>「扫一扫」</strong><br>
      登录<strong>你自己的账号</strong><br>
      <span id="qrStatus">等待扫码…</span>
      <span class="qr-alt">
        <button type="button" id="qrRefresh">刷新二维码</button> ·
        <button type="button" id="ckLink">改用 Cookie 登录</button>
      </span>
    </div>`;
  $('#qrRefresh').addEventListener('click', showQR);
  $('#ckLink').addEventListener('click', showCookieLogin);
  stopPoll();
  ne.poll = setInterval(async () => {
    let c;
    try { c = await fetch(A('/api/qr/check?key=' + encodeURIComponent(k.key))).then(r => r.json()); }
    catch { return; }
    const st = $('#qrStatus');
    if (!st) return;
    if (c.code === 802) st.textContent = '已扫码，请在手机上确认…';
    else if (c.code === 800) { stopPoll(); showQR(); } // 过期，换新码
    else if (c.code === 803) {
      stopPoll();
      toast('music', '网易云音乐已登录');
      const s2 = await fetch(A('/api/session'), { cache: 'no-store' }).then(r => r.json()).catch(() => ({}));
      applyAcct(s2);
      rememberCred();   // 扫码登录成功即落盘，重启免重扫
      setLoginOpen(false);
      loadPlWall();
    } else if (c.risk) {
      stopPoll();          // 风控是账号级的，继续轮询只会让风控更严
      showRisk(c.code, c.message);
    } else if (c.code !== 801) {
      st.textContent = `未知状态码 ${c.code}，试试下方 Cookie 登录`;
    }
  }, 2500);
}

function stopPoll() {
  if (ne.poll) { clearInterval(ne.poll); ne.poll = null; }
}

// 8821 / -462 是网易云对「账号 + 环境」下的风控：要求真人做行为验证码。
// 第三方服务端拿不到验证码，重试多少次都没用，所以直接把用户引到 Cookie 登录。
function showRisk(code, message) {
  loginBody.innerHTML = `
    <div class="panel__note panel__note--left">
      <p class="risk__head">
        <span class="risk__badge">风控</span>
        网易云要求「行为验证码」
        <span class="risk__code">${esc(String(code))}</span>
      </p>
      <p>扫码确认时被网易云拦截：<strong>${esc(message || '需要行为验证码验证')}</strong><br>
         验证码只能在网易云官方页面由真人完成，本站无法绕过。</p>
      <p><strong>推荐改用 Cookie 登录，一次就能进：</strong></p>
      <span class="qr-alt">
        <button type="button" class="btn btn--primary" id="riskCookie">改用 Cookie 登录</button>
        <button type="button" class="btn btn--ghost" id="riskRetry">重新扫码</button>
      </span>
      <p class="risk__tip">
        另外两个办法：等几小时到一天再扫（风控会自行解除）；<br>
        或关掉电脑上的代理 / VPN 后重启服务再试。
      </p>
    </div>`;
  $('#riskCookie').addEventListener('click', showCookieLogin);
  $('#riskRetry').addEventListener('click', showQR);
}

function showCookieLogin() {
  stopPoll();
  loginBody.innerHTML = `
    <div class="panel__note panel__note--left">
      <p class="ck__title">用 Cookie 登录<span class="risk__badge risk__badge--ok">不受风控影响</span></p>
      <ol class="ck__steps">
        <li>浏览器打开 <a class="ck__link" href="https://music.163.com" target="_blank" rel="noopener noreferrer">music.163.com</a>，登录<strong>你自己的账号</strong></li>
        <li>按 <strong>F12</strong> → <strong>Application</strong>（应用）→ <strong>Cookies → music.163.com</strong></li>
        <li>找到 <strong>MUSIC_U</strong>，双击 Value 全选复制，粘贴到下面点「登录」</li>
      </ol>
      <input id="ckInput" class="ck-input" type="text" spellcheck="false" autocomplete="off" placeholder="粘贴 MUSIC_U 的值，或整段 Cookie">
      <span class="qr-alt">
        <button type="button" class="btn btn--primary" id="ckSave">登录</button>
        <button type="button" class="btn btn--ghost" id="ckBack">返回扫码</button>
      </span>
      <p class="risk__tip">凭据只存在你浏览器和服务器上，不会外发。</p>
    </div>`;
  $('#ckSave').addEventListener('click', async () => {
    const v = $('#ckInput').value.trim();
    if (!v) return;
    $('#ckSave').textContent = '登录中…';
    let r;
    try { r = await fetch(A('/api/cookie'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookie: v }) }).then(x => x.json()); }
    catch { r = { ok: false, error: '服务器未运行' }; }
    if (r.ok) {
      toast('music', '网易云音乐已登录');
      const s2 = await fetch(A('/api/session'), { cache: 'no-store' }).then(x => x.json()).catch(() => ({}));
      applyAcct(s2);
      rememberCred();   // Cookie 登录成功即落盘，重启免重贴
      setLoginOpen(false);
      loadPlWall();
    } else { $('#ckSave').textContent = '登录'; toast('music', r.error || '登录失败'); }
  });
  $('#ckBack').addEventListener('click', showQR);
  // 聚焦输入框时浏览器会自动滚动，把上面的步骤顶出可视区，这里压回去
  try { $('#ckInput').focus({ preventScroll: true }); } catch { $('#ckInput').focus(); }
  loginBody.scrollTop = 0;
}

async function loadPlaylist(id = null, quiet = false) {
  const liked = id == null;
  libEmpty.hidden = true;
  songWall.innerHTML = `<p class="panel__note">正在获取「${liked ? '我喜欢的音乐' : '歌单'}」…</p>`;
  setListOpen(true);
  let j;
  try {
    j = await fetchT(A(liked ? '/api/liked' : '/api/playlist?id=' + encodeURIComponent(id))).then(r => r.json());
  } catch (e) { j = { error: netErr(e) }; }
  if (j.error || !Array.isArray(j.tracks)) {
    songWall.innerHTML = `<p class="panel__note">${esc(j.error || '获取失败')}<br>` +
      `<button class="btn btn--ghost" type="button">重新连接</button> ` +
      `<button class="btn btn--ghost" type="button">返回歌单墙</button></p>`;
    const bs = songWall.querySelectorAll('.btn');
    bs[0].addEventListener('click', () => loadPlaylist(id));
    bs[1].addEventListener('click', () => setSongOpen(false));
    return;
  }
  curPlId = (j.id && j.id !== 'liked') ? String(j.id) : '';
  try { localStorage.setItem('ne_plid', curPlId); } catch { /* 隐私模式等 */ }
  ne.plName = j.name || '歌单';
  ne.list = j.tracks;
  ne.loaded = true;
  // 正在播的歌若也在新歌单里，光标跟上；不在则不指任何行
  ne.idx = ne.currentId != null ? ne.list.findIndex(t => t.id === ne.currentId) : -1;
  selId = null;
  songTitle.textContent = ne.plName;
  songSub.textContent = `共 ${j.count} 首`;
  // 歌单封面若预载失败/缺失，用第一首歌的封面补上详情页背景
  if (!songBgImg.getAttribute('src') && ne.list[0] && ne.list[0].pic) setSongBg(ne.list[0].pic);
  libSearchWrap.hidden = false;
  libSearch.value = '';
  renderSongCards();
  ringWall();   // 歌单墙同步高亮刚打开的这一张
  rememberCred();   // 登录态确认可用时刷新存档（重启后 credGet 自动恢复）
  startScan(quiet);
  if (!quiet) toast('music', `已载入「${ne.plName}」· ${j.count} 首`);
}

// 点歌单墙上的卡片：进入全屏详情页，背景先用缓存里的封面铺上，加载在路上完成
function openPlaylist(id) {
  const liked = id == null;
  const meta = ((plCache && plCache.items) || []).find(p => p.liked ? liked : String(p.id) === String(id));
  songTitle.textContent = meta ? meta.name : (liked ? '我喜欢的音乐' : '歌单');
  songSub.textContent = '正在载入…';
  if (meta && meta.pic) setSongBg(meta.pic);
  setSongOpen(true);
  loadPlaylist(id);
}

/* ---------------- 歌单墙：账号里的全部歌单，横向卡片长廊 ---------------- */

async function loadPlWall(quiet = false) {
  plWall.innerHTML = '<p class="panel__note">正在获取歌单列表…</p>';
  let j;
  if (plCache && Date.now() - plCache.at < 300000) {
    j = { playlists: plCache.items };
  } else {
    try { j = await fetchT(A('/api/playlists')).then(r => r.json()); }
    catch (e) { j = { error: netErr(e) }; }
    if (Array.isArray(j.playlists)) plCache = { at: Date.now(), items: j.playlists };
  }
  if (j.error || !Array.isArray(j.playlists)) {
    plWall.innerHTML = `<p class="panel__note">${esc(j.error || '获取失败')}<br>` +
      `<button class="btn btn--ghost" type="button">重试</button></p>`;
    plWall.querySelector('.btn').addEventListener('click', () => loadPlWall());
    return;
  }
  renderPlWall(j.playlists);
  setListOpen(true);
  if (!quiet && j.playlists.length) toast('music', `已载入 ${j.playlists.length} 个歌单`);
  // 歌单到手了，顺手把横幅那句内置歌词换成账号里的真歌词（拿不到就算了）
  if (j.playlists.length) upgradeHeroLyricFromAccount();
}

function renderPlWall(items = (plCache && plCache.items) || []) {
  if (!items.length) {
    plWall.innerHTML = '<p class="panel__note">账号里还没有歌单</p>';
    carousel.n = 0; carousel.cards = [];
    return;
  }
  plWall.innerHTML = items.map((p, i) => `
    <button class="plc${String(p.id) === curPlId ? ' is-cur' : ''}" type="button"
            data-id="${esc(String(p.id))}" data-liked="${p.liked ? 1 : 0}"
            title="${esc(p.name)}" style="--d:${Math.min(i, 10)}">
      <span class="plc__cover">
        ${p.pic ? `<img loading="lazy" src="${esc(bigImg(p.pic, 600))}" alt="">` : ''}
        ${p.liked ? '<span class="plc__fav">喜欢</span>' : ''}
        <span class="plc__live" aria-hidden="true"><i></i><i></i><i></i></span>
      </span>
      <span class="plc__name">${esc(p.name)}</span>
      <span class="plc__sub">${p.mine ? '创建的歌单' : '收藏的歌单'} · ${p.count} 首</span>
    </button>`).join('');
  for (const el of plWall.querySelectorAll('.plc')) {
    el.classList.add('is-in');   // 呼入：--d 已写在行内，卡片沿长廊依次滑开
    el.addEventListener('click', () => {
      if (wallDragged) return;   // 拖拽长廊松手后的那次 click 不是点卡片
      openPlaylist(el.dataset.liked === '1' ? null : el.dataset.id);
    });
  }
  // 挂上轮播，并把「当前打开（或上次记住）的那张」摆在正中；没有就摆第一张
  const cards = [...plWall.querySelectorAll('.plc')];
  const at = cards.findIndex(el => el.dataset.id === curPlId);
  carouselMount(at >= 0 ? at : 0);
  applyFilter();   // 重渲后按当前关键词重新压暗（搜索框有内容时）

  // 键盘 Tab 到某张卡时把它带到正中。
  // 长廊是 overflow: clip，落在视口外的卡既看不见、浏览器也没法滚动到它，
  // 所以必须由轮播自己把获得焦点的那张移进来。
  cards.forEach((el, i) => el.addEventListener('focus', () => {
    if (wallDragged) return;   // 拖拽结束的那次 focus 不要抢走吸附
    carousel.posT = clamp(i, 0, carousel.n - 1);
    carouselRun();
  }));
}

// 歌单的「当前」描边跟着打开状态走，不重渲染整面墙
function ringWall() {
  for (const el of plWall.querySelectorAll('.plc')) {
    el.classList.toggle('is-cur', el.dataset.id === curPlId);
  }
}

/* ---------------- 玻璃面板滚动时的帧率保护 ----------------

   玻璃的 ::before / ::after 是两层 backdrop-filter。只要滚动发生在它们
   **内部**，浏览器每一帧都要把这两层滤镜重算一遍（而且没法走合成线程滚动）。
   实测拖拽时只有 16fps，两层都摘掉立刻回到 60fps —— 完整数据在 style.css
   那段注释里。

   歌单长廊以前是这里最大的受益者（横向拖拽就发生在玻璃内部）；长廊改成
   居中轮播、且不再有玻璃底板之后，只剩登录浮层的二维码列表还在玻璃里滚，
   机制仍然保留。

   这里在滚动进行中给**正在滚的那个面板**挂 is-scrolling，由 CSS 临时摘掉
   那两层模糊，停手 180ms 后摘掉标记。用 document 上的捕获监听而不是逐个面板
   绑定：scroll 不冒泡，但捕获阶段能收到所有滚动容器的滚动，以后新增面板
   不用再改这里。 */

let glassScrollTimer = null;
let glassScrolling = null;

const endGlassScroll = () => {
  if (glassScrolling) glassScrolling.classList.remove('is-scrolling');
  glassScrolling = null;
};

// 挂上保护并在 ms 后自动摘下。歌单长廊改成 transform 轮播、且不再有玻璃底板
// 之后，已经没有手势需要手动兜底了（原先长廊拖到尽头时 scrollLeft 不变、
// scroll 事件不来，得在这里补一次），现在只由上面的 scroll 监听驱动。
const holdGlassScrolling = (panel, ms = 180) => {
  if (!panel) return;
  if (panel !== glassScrolling) {
    endGlassScroll();          // 换了个面板在滚：上一个立刻恢复
    glassScrolling = panel;
  }
  panel.classList.add('is-scrolling');
  clearTimeout(glassScrollTimer);
  glassScrollTimer = setTimeout(endGlassScroll, ms);
};

document.addEventListener('scroll', e => {
  const el = e.target;
  if (!el || el.nodeType !== 1 || typeof el.closest !== 'function') return;
  holdGlassScrolling(el.closest('.glass'));
}, { capture: true, passive: true });

/* ---------------- 歌单墙：居中式轮播 ----------------

   一个浮点位置 pos（单位＝第几张，可以是小数）推出全部表现：
     · 轨道整体平移，让 pos 那张卡正好落在视口中心；
     · 每张卡的缩放与透明度按它到 pos 的距离衰减 —— 越靠中间越大越实，
       两侧依次缩小、变淡（渐变退场），正中那张另打 is-center 抬高投影。
   鼠标左右拖动直接改 pos（1:1 跟手，越界走橡皮筋），松手按速度投影后
   吸附到最近一张；滚轮往下 → pos 增大 → 卡片整体往左（下一张滑进正中），
   往上 → 往右。

   为什么不用 scrollLeft：它只能等速平移，做不出"越靠中间越大"，
   吸附 / 惯性 / 滚轮换轴方向也都得另想办法。换成 transform 之后，
   位置、缩放、吸附、惯性全部由同一个 pos 推出来。 */

const carousel = {
  cards: [], n: 0,
  pos: 0, posT: 0,          // 当前位置 / 目标位置（单位＝张）
  pitch: 0, cardW: 0, vw: 0,
  raf: 0, last: 0, snapT: 0,
  centerIdx: -1,            // 现在被标成"正中"的是第几张（只在变化时写 DOM）
};

/* 居中轮播的景深参数 —— 中心那张最大最实，两侧按距离衰减。
   缩放与透明度各用一条幂曲线、各配一个衰减距离：
     · 缩放衰减快（3 张到底）、幂次高 → 中间明显比邻居大（"谁在中间"靠大小就看得出来）；
     · 透明度衰减慢（5 张到底）、幂次低 → 一屏 4~5 张都看得清，
       只是越往外越淡，而不是两三张就黑掉。一屏要"数得出 4 个歌单"，
       靠的就是这条曲线别太陡（太陡的话第 4 张已经认不出来了）。
   实测（d = 离中心多少张）：
     d=0 → scale 1.00 / opacity 1.00
     d=1 → scale 0.79 / opacity 0.85
     d=2 → scale 0.63 / opacity 0.71
     d=3 → scale 0.56 / opacity 0.57
     d=4 → scale 0.56 / opacity 0.43 */
const SCALE_MIN = 0.56;
const SCALE_FALLOFF = 3.0;
const SCALE_POW = 1.6;
const OPACITY_MIN = 0.30;
const OPACITY_FALLOFF = 5.0;
const OPACITY_POW = 1.05;

// 越界阻尼：拖出边界时跟手程度递减，而不是硬停
function rubberband(over) {
  const k = 0.55;
  return (over * k) / (1 + k * over);
}
function rubberPos(p) {
  const hi = carousel.n - 1;
  if (p < 0) return -rubberband(-p);
  if (p > hi) return hi + rubberband(p - hi);
  return p;
}

function carouselMeasure() {
  const c = carousel;
  c.cards = [...plWall.querySelectorAll('.plc')];
  c.n = c.cards.length;
  if (!c.n) return;
  c.vw = galViewport.clientWidth;
  c.cardW = c.cards[0].offsetWidth;      // offsetWidth 是布局宽，不带 scale
  c.pitch = c.n > 1 ? c.cards[1].offsetLeft - c.cards[0].offsetLeft : c.cardW;
  if (!c.pitch) c.pitch = c.cardW + 20;
}

function carouselApply() {
  const c = carousel;
  if (!c.n || !c.pitch) return;
  const p = rubberPos(c.pos);
  const x = c.vw / 2 - (p * c.pitch + c.cardW / 2);
  plWall.style.transform = `translate3d(${x.toFixed(2)}px, 0, 0)`;
  for (let i = 0; i < c.n; i++) {
    const d = Math.abs(i - p);
    const es = Math.pow(Math.max(0, 1 - d / SCALE_FALLOFF), SCALE_POW);
    const eo = Math.pow(Math.max(0, 1 - d / OPACITY_FALLOFF), OPACITY_POW);
    const el = c.cards[i].style;
    el.setProperty('scale', (SCALE_MIN + (1 - SCALE_MIN) * es).toFixed(4));
    el.setProperty('opacity', (OPACITY_MIN + (1 - OPACITY_MIN) * eo).toFixed(3));
  }
  // 给"最靠中间"的那张打标记（只在这一张变化时写一次 DOM，不逐帧写）。
  // 橡皮筋越界时 p 可能略小于 0 / 大于 n-1，Math.round 后落在数组外，用存在性兜住。
  const ci = Math.round(p);
  if (ci !== c.centerIdx) {
    if (c.cards[c.centerIdx]) c.cards[c.centerIdx].classList.remove('is-center');
    c.centerIdx = ci;
    if (c.cards[ci]) c.cards[ci].classList.add('is-center');
    syncWallToCenter();    // 壁纸跟着"最靠中间的那张歌单"走（内部防抖）
  }
}

function carouselStop() {
  if (carousel.raf) { cancelAnimationFrame(carousel.raf); carousel.raf = 0; }
}

// 把 pos 缓动到 posT。时间常数 85ms：跟得上手、收尾又不生硬。
function carouselRun() {
  const c = carousel;
  if (c.raf) return;
  c.last = performance.now();
  const step = now => {
    const dt = Math.min(64, now - c.last); c.last = now;
    const d = c.posT - c.pos;
    if (Math.abs(d) < 0.0008) { c.pos = c.posT; carouselApply(); c.raf = 0; return; }
    c.pos += d * (1 - Math.exp(-dt / 85));
    carouselApply();
    c.raf = requestAnimationFrame(step);
  };
  c.raf = requestAnimationFrame(step);
}

// 挂载（渲染完卡片后调用）：量尺寸并把指定那张居中
function carouselMount(idx = 0) {
  const c = carousel;
  carouselStop();
  carouselMeasure();
  c.centerIdx = -1;    // 卡片是刚重建的，旧的"正中"标记已随旧节点销毁，必须作废
  if (!c.n) { c.pos = c.posT = 0; return; }
  c.pos = c.posT = clamp(idx, 0, c.n - 1);
  carouselApply();
}

let carouselResizeRaf = 0;
addEventListener('resize', () => {
  if (!carousel.n || carouselResizeRaf) return;
  carouselResizeRaf = requestAnimationFrame(() => {
    carouselResizeRaf = 0;
    if (!carousel.n) return;
    carouselMeasure();
    carouselApply();
  });
});

let wallDragged = false;
{
  // 封面 <img> 默认可原生拖拽（drag & drop），会抢占指针流触发 pointercancel，
  // 轮播的跟手拖动就会中途死掉 —— 一律拦掉
  plWall.addEventListener('dragstart', e => e.preventDefault());
  let drag = null;

  plWall.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!carousel.n) return;
    carouselStop();
    clearTimeout(carousel.snapT);
    drag = { x0: e.clientX, x: e.clientX, pos0: carousel.pos, id: e.pointerId, t: performance.now(), v: 0 };
    wallDragged = false;
  });

  plWall.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const c = carousel;
    const dx = e.clientX - drag.x0;   // 相对手势起点，1:1 跟手；x0 不许动
    if (!wallDragged && Math.abs(dx) > 6) {
      wallDragged = true;
      plWall.classList.add('is-dragging');
      try { plWall.setPointerCapture(drag.id); } catch { /* noop */ }
    }
    if (!wallDragged) return;
    // 往右拖 → 卡片往右 → pos 减小；越界不夹紧，交给 rubberPos 做阻尼
    c.posT = c.pos = drag.pos0 - dx / c.pitch;
    carouselApply();
    // 记录松手前的速度（px/s），只采最近一小段，甩尾才算数
    const now = performance.now(), dt = now - drag.t;
    if (dt > 12) { drag.v = (drag.x - e.clientX) / dt * 1000; drag.t = now; drag.x = e.clientX; }
  });

  const wallUp = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const c = carousel;
    const { v } = drag;
    drag = null;
    plWall.classList.remove('is-dragging');
    // 按速度投影落点再吸附：甩一下能连跳两三张，轻推只走一格
    const proj = wallDragged
      ? clamp((v / c.pitch / 1000) * 0.998 / (1 - 0.998) * 0.55, -3, 3)
      : 0;
    c.posT = clamp(Math.round(c.pos + proj), 0, c.n - 1);
    carouselRun();
    setTimeout(() => { wallDragged = false; }, 0);   // click 在本轮事件之后触发，先别急着清标记
  };
  plWall.addEventListener('pointerup', wallUp);
  plWall.addEventListener('pointercancel', wallUp);

  // 竖向滚轮换位：往下滚 → 卡片整体往左（pos 增大，右侧的下一张滑进正中），
  // 往上滚 → 往右。停手 160ms 后吸附到最近一张，免得停在两张之间。
  plWall.addEventListener('wheel', e => {
    if (!e.deltaY || e.ctrlKey) return;
    e.preventDefault();
    const c = carousel;
    if (!c.n) return;
    const k = e.deltaMode === 1 ? 0.055 : 0.0035;   // 行模式 / 像素模式
    c.posT = clamp(c.posT + e.deltaY * k, 0, c.n - 1);
    carouselRun();
    clearTimeout(c.snapT);
    c.snapT = setTimeout(() => {
      c.posT = clamp(Math.round(c.posT), 0, c.n - 1);
      carouselRun();
    }, 160);
  }, { passive: false });
}

/* ---------------- 可播放性扫描：死歌置底 ---------------- */

function applyDead(ids) {
  if (!ids || !ids.length) return;
  let added = false;
  for (const id of ids) { const nid = Number(id); if (!deadSongs.has(nid)) { deadSongs.add(nid); added = true; } }
  if (!added) return;
  const curId = ne.currentId;
  ne.list = [
    ...ne.list.filter(t => !deadSongs.has(t.id)),
    ...ne.list.filter(t => deadSongs.has(t.id)),
  ];
  ne.idx = curId != null ? ne.list.findIndex(t => t.id === curId) : -1;
  renderSongCards(false);   // 扫描期间会反复重排，这里不重放交错动画
}

let scanTimer = null;

let scanQuiet = false;

function startScan(force = false, quiet = false) {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  scanQuiet = quiet;
  if (force) deadSongs.clear();
  fetch(A('/api/scan'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ne.list.map(t => t.id), force }),
  }).then(r => r.json()).then(j => {
    applyDead(j.dead);
    if (j.running) {
      if (songOpen) songSub.textContent = `扫描中 0/${j.total}…`;
      scanTimer = setInterval(pollScan, 1500);
    } else {
      scanDone(j);
    }
  }).catch(() => {});
}

function pollScan() {
  fetch(A('/api/scan')).then(r => r.json()).then(j => {
    applyDead(j.dead);
    if (j.running) {
      if (songOpen) songSub.textContent = `扫描中 ${j.done}/${j.total}…`;
    } else {
      clearInterval(scanTimer); scanTimer = null;
      scanDone(j);
    }
  }).catch(() => { clearInterval(scanTimer); scanTimer = null; });
}

function scanDone(j) {
  const n = (j.dead || []).length;
  if (songOpen) songSub.textContent = `共 ${ne.list.length} 首`;
  if (n && !scanQuiet) toast('music', `扫描完成 · ${n} 首无法播放已置底`);
}

// 网易云 CDN 的 ?param= 尺寸后缀：列表接口发的是 120y120 小图，卡片与背景换大图。
// 卡片不设独立播放钮：点封面/整卡即播放（交互见下方拖拽巡游控制器）。
function bigImg(url, n) {
  return String(url || '').replace(/param=\d+y\d*/, 'param=' + n + 'y' + n);
}

/* ---------------- 拖拽巡游 + 居中聚焦 ----------------
   按住拖动 = 在海报墙上巡游（1:1 跟手，松手带惯性滑行），滚轮同样平移；
   被滑到画面正中的那首歌自动放大提亮（is-focus），其余卡片按景深缩小退暗。
   正中卡同时写入「待播放」选中（selId）—— 空格/回车直接播放它，
   拖到中间就是选歌。拖完松手的那次 click 会被吃掉，不会误播。 */

let currentLay = null, prevLaySig = null, fieldEl = null;
let focusId = null, focusEl = null;
const pan = { x: 0, y: 0, dragMoved: false };

function panBounds() {
  const h = songWall.clientHeight;
  const fh = currentLay ? currentLay.fieldH : 0;
  return {
    x0: currentLay ? currentLay.x0 : 0,
    x1: currentLay ? Math.max(currentLay.x0, currentLay.x1) : 0,
    y0: currentLay ? currentLay.y0 : 0,
    y1: currentLay ? Math.max(currentLay.y0, currentLay.y1) : Math.max(0, fh - h),
  };
}

function applyPan() {
  if (fieldEl) fieldEl.style.transform = `translate3d(${(-pan.x).toFixed(1)}px, ${(-pan.y).toFixed(1)}px, 0)`;
  updateScales();
}

/* 缩放场：每张卡按「卡片中心 → 视口中心」的距离连续缩放——
   参考图的三档大小：正中 ≈2.6 倍，隔一个列距回到 ≈1（二次衰减：
   邻位掉到 ≈1.5 倍、再远迅速收底，出「小/中/大」的阶梯感）。
   距离随 pan 每帧变化，rAF 逐帧写入本身就是过渡，所以 .scard 不挂
   transform transition（挂了每帧都要追动画，反而糊）。只写差值
   超过 0.004 的卡；视野外的回到 1 之后零成本跳过。 */
let scaleEls = new Map();                    // id → 卡片元素，renderSongCards 时重建
function updateScales() {
  if (!currentLay || !fieldEl) return;
  const cx = pan.x + songWall.clientWidth / 2;
  const cy = pan.y + songWall.clientHeight / 2;
  const R = (currentLay.pitch || 310) * 2.4;   // 缩放场半径 ≈ 2.4 列距：邻位中卡明显、约两列外回基准
  for (const [id, p] of currentLay.pos) {
    const el = scaleEls.get(id);
    if (!el) continue;
    const dx = p.x + p.w / 2 - cx;
    const dy = p.y + (p.h || p.w + 68) / 2 - cy;   // 与 updateFocus 同一个卡中心
    const d = Math.hypot(dx, dy);
    if (d > R + p.w) {
      if (el._cs !== 1) { el.style.setProperty('--cs', '1'); el._cs = 1; }
      continue;
    }
    const t = Math.max(0, 1 - d / R);
    const k = 1 + 1.6 * t * t;
    if (el._cs === undefined || Math.abs(el._cs - k) > 0.004) {
      el.style.setProperty('--cs', k.toFixed(3));
      el._cs = k;
    }
  }
}

let focusRaf = 0;
let glide = null, glideRaf = 0;

function queueFocus() { if (!focusRaf) focusRaf = requestAnimationFrame(updateFocus); }

function updateFocus() {
  focusRaf = 0;
  if (!currentLay || !ne.list.length || !songOpen) return;
  const cx = pan.x + songWall.clientWidth / 2;
  const cy = pan.y + songWall.clientHeight / 2;
  let best = null, bestD = Infinity;
  for (const [id, p] of currentLay.pos) {
    const dx = p.x + p.w / 2 - cx;
    const dy = p.y + (p.h || p.w + 68) / 2 - cy;   // 卡片中心 = 封面中心 + 文本区一半（h 随卡宽）
    const d = dx * dx * 1.6 + dy * dy;       // 横向权重略高：优先对齐中轴
    if (d < bestD) { bestD = d; best = id; }
  }
  if (best == null) return;
  if (best !== focusId) {
    if (focusEl) focusEl.classList.remove('is-focus');
    focusId = best;
    focusEl = songWall.querySelector(`.scard[data-id="${best}"]`);
    if (focusEl) focusEl.classList.add('is-focus');
    if (selId !== best) { selId = best; applySel(); }   // 正中卡 = 「待播放」选中
  }
}

// 点选后的滑行：rAF 逐帧 easeInOutCubic——起步加速、中段滑行、缓缓停住，
// 手感等同"按住拖动后松手的惯性滑行"，而不是一步到位的瞬移。
// 时长随距离伸缩（420ms~1050ms），拖动/滚轮可随时抓住打断。
function panToCard(id) {
  const p = currentLay && currentLay.pos.get(id);
  if (!p || !fieldEl) return;
  const b = panBounds();
  const tx = clamp(p.x + p.w / 2 - songWall.clientWidth / 2, b.x0, b.x1);
    const ty = clamp(p.y + (p.h || p.w + 68) / 2 - songWall.clientHeight / 2, b.y0, b.y1);
  stopGlide();
  const dist = Math.hypot(tx - pan.x, ty - pan.y);
  glide = { x0: pan.x, y0: pan.y, tx, ty, t0: performance.now(), dur: clamp(dist / 1.3, 380, 850) };
  glideRaf = requestAnimationFrame(glideStep);
  queueFocus();
}

function glideStep(ts) {
  if (!glide) return;
  const p = Math.min((ts - glide.t0) / glide.dur, 1);
  const e = -(Math.cos(Math.PI * p) - 1) / 2;                          // easeInOutSine：柔起步缓停
  pan.x = glide.x0 + (glide.tx - glide.x0) * e;
  pan.y = glide.y0 + (glide.ty - glide.y0) * e;
  applyPan(); queueFocus();
  if (p < 1) { glideRaf = requestAnimationFrame(glideStep); }
  else { glideRaf = 0; glide = null; }
}

function stopGlide() {
  if (glideRaf) { cancelAnimationFrame(glideRaf); glideRaf = 0; }
  glide = null;
}

{
  let drag = null, inertiaRaf = 0;
  const stopInertia = () => { if (inertiaRaf) { cancelAnimationFrame(inertiaRaf); inertiaRaf = 0; } };

  songWall.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    stopInertia();
    stopGlide();                        // 手一按上就"抓住"正在滑行的墙
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, t: performance.now(), vx: 0, vy: 0 };
    pan.dragMoved = false;
  });
  songWall.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!pan.dragMoved && Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 6) {
      pan.dragMoved = true;
      try { songWall.setPointerCapture(e.pointerId); } catch { /* noop */ }
    }
    if (!pan.dragMoved) return;
    const b = panBounds();
    pan.x = clamp(pan.x - (e.clientX - drag.lx), b.x0, b.x1);
    pan.y = clamp(pan.y - (e.clientY - drag.ly), b.y0, b.y1);
    const now = performance.now(), dt = now - drag.t;
    if (dt > 12) { drag.vx = (drag.lx - e.clientX) / dt * 1000; drag.vy = (drag.ly - e.clientY) / dt * 1000; drag.t = now; }
    drag.lx = e.clientX; drag.ly = e.clientY;
    applyPan(); queueFocus();
  });
  const endDrag = e => {
    if (!drag || e.pointerId !== drag.id) return;
    let { vx, vy } = drag;                 // 惯性里要衰减，必须是 let
    drag = null;
    if (!pan.dragMoved) return;
    // 惯性：按松手速度滑行、指数衰减；滑到边界就停在那儿
    let last = performance.now();
    const step = ts => {
      const dt = Math.min(ts - last, 50); last = ts;
      const b = panBounds();
      pan.x = clamp(pan.x + vx * dt / 1000, b.x0, b.x1);
      pan.y = clamp(pan.y + vy * dt / 1000, b.y0, b.y1);
      const k = Math.exp(-dt / 260);
      vx *= k; vy *= k;
      applyPan(); queueFocus();
      const hitX = pan.x === b.x0 || pan.x === b.x1, hitY = pan.y === b.y0 || pan.y === b.y1;
      if (Math.hypot(vx, vy) > 40 && !(hitX && hitY)) inertiaRaf = requestAnimationFrame(step);
      else inertiaRaf = 0;
    };
    if (Math.hypot(vx, vy) > 200) inertiaRaf = requestAnimationFrame(step);
  };
  songWall.addEventListener('pointerup', endDrag);
  songWall.addEventListener('pointercancel', endDrag);
  // 拖完松手的那次 click 落在卡片上不是点歌，是拖拽的收尾 —— capture 阶段吃掉
  songWall.addEventListener('click', e => {
    if (pan.dragMoved) { e.stopPropagation(); e.preventDefault(); pan.dragMoved = false; }
  }, true);
  // 滚轮 / 触控板：竖滚平移场子，横滚（触控板）平移横向
  songWall.addEventListener('wheel', e => {
    if (!songOpen) return;
    e.preventDefault();
    stopInertia();
    stopGlide();
    const b = panBounds();
    pan.x = clamp(pan.x + (e.deltaX || 0), b.x0, b.x1);
    pan.y = clamp(pan.y + e.deltaY * (e.deltaMode === 1 ? 24 : 1), b.y0, b.y1);
    applyPan(); queueFocus();
  }, { passive: false });
  // 窗口宽度变了：散点按宽度铺排，宽度差超过 80px 就防抖重排一次
  let rszT = 0;
  addEventListener('resize', () => {
    if (!songOpen) return;
    clearTimeout(rszT);
    rszT = setTimeout(() => {
      if (Math.abs(songWall.clientWidth - lastWallW) < 80) return;
      renderSongCards(false);
    }, 250);
  });
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ---------------- 卡片墙的散点布局 ----------------
   按歌单顺序逐行铺放（顺序不打乱）：偶数行对齐网格，奇数行右移半格
   交错成砖墙节奏，再叠一点点种子抖动保持海报感。横向到最右多排一列
   探出屏幕；上下各留约半个视口的呼吸位 —— 第一首和最后一首都能拖到
   画面正中聚焦。抖动用歌单 id 做种子：同一歌单每次进来布局一致。 */

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function scatterLayout(plKey, ids, wallW, wallH) {
  const rand = mulberry32(hashSeed(plKey || 'empty'));
  const narrow = wallW < 760;
  // ── 卡片尺寸两档：缩小窗口 / 放大窗口各一档（阈值 1600：还原 ≈1150 用小档、
  // 最大化 ≈2000 用大档，切换靠 resize 重排）；字体随卡宽走（style.css 按 --cw 比例）。
  // 只调这两个数即可改两档大小；列距/行距/抖动全按基准推算。每行 10 张。
  const SONG_CARD_BASE = narrow ? 148 : (wallW >= 1600 ? 136 : 104);
  const cols = narrow ? Math.max(2, Math.ceil(wallW / 236) + 1) : 10;
  const pitchX = narrow ? 236 : Math.round(SONG_CARD_BASE * 2.21);
  const cardW = SONG_CARD_BASE;
  const textH = Math.max(50, Math.round(cardW * 0.45));   // 文本区高度随卡宽（字体同比例）
  const jitX = narrow ? 40 : Math.max(6, Math.round(pitchX * 0.08));
  const jitY = narrow ? 20 : Math.max(4, Math.round(pitchX * 0.04));
  // 行距要装得下正中的大卡（2.6 倍宽 + 文本区）；参考图里上下行贴得很近
  const rowPitch = narrow ? 340 : Math.max(Math.round(SONG_CARD_BASE * 3.4), Math.round((SONG_CARD_BASE * 2.6 + textH) * 1.06));
  const padX = Math.max(60, Math.round(wallW * 0.42));       // 左右呼吸位：任意一首都能居中聚焦
  const padY = Math.max(60, Math.round(wallH * 0.42));
  const pos = new Map();
  ids.forEach((id, i) => {
    const row = Math.floor(i / cols), col = i % cols, odd = row % 2 === 1;
    const x = padX + col * pitchX + (odd ? pitchX * 0.5 : 0) + 6 + rand() * jitX;
    const y = padY + row * rowPitch + (odd ? 26 : 0) + rand() * jitY - jitY / 2;
    const zd = rand();
    pos.set(id, { x: Math.round(x), y: Math.round(y), w: cardW, h: cardW + textH, layer: zd < .38 ? 0 : zd < .72 ? 1 : 2 });
  });
  const rows = Math.max(1, Math.ceil(ids.length / cols));
  const fieldW = Math.round(padX * 2 + cols * pitchX + pitchX * 0.5 + 40);
  const fieldH = Math.round(padY * 2 + rows * rowPitch + 40);
  const x0 = -padX - 10, x1 = Math.max(x0, fieldW - wallW - 10);
  const y0 = -10, y1 = Math.max(y0, fieldH - wallH - 10);
  const sig = plKey + '|' + ids.length + '|' + (ids[0] ?? '') + '|' + (ids[ids.length >> 1] ?? '') + '|' + (ids[ids.length - 1] ?? '');
  return {
    pos, fieldW, fieldH, x0, x1, y0, y1, sig, pitch: pitchX,
    initX: clamp(padX + 26 - wallW / 2, x0, x1),          // 开场：第一首歌停在正中
    initY: clamp(padY + 170 - wallH / 2, y0, y1),
  };
}

// animate=false 用于扫描后重排：卡片会整批重挂，再走一次交错反而像在刷新
let lastWallW = 0;

function renderSongCards(animate = true) {
  const wallW = songWall.clientWidth || innerWidth;
  const wallH = songWall.clientHeight || 700;
  lastWallW = wallW;
  const lay = scatterLayout(curPlId || 'liked', ne.list.map(s => s.id), wallW, wallH);
  const layersHTML = ['', '', ''];
  ne.list.forEach((s, i) => {
    const p = lay.pos.get(s.id) || { x: 10, y: 10, w: 180, layer: 1 };
    layersHTML[p.layer] += `
    <div class="scard${i === ne.idx ? ' is-cur' : ''}${deadSongs.has(s.id) ? ' is-dead' : ''}"
        data-i="${i}" data-id="${s.id}" style="--d:${Math.min(i % 30, 18)}; --cw:${p.w}px; left:${p.x}px; top:${p.y}px">
      <span class="scard__cover">
        ${s.pic ? `<img loading="lazy" src="${esc(bigImg(s.pic, 300))}" alt="">` : ''}
        ${s.fee === 1 ? '<span class="scard__vip">VIP</span>' : ''}
        <span class="scard__live" aria-hidden="true"><i></i><i></i><i></i></span>
      </span>
      <span class="scard__name">${esc(s.name)}</span>
      <span class="scard__artist">${esc(s.ar)}</span>
      <span class="scard__meta">${i + 1} · ${fmt(s.dt)}</span>
    </div>`;
  });
  songWall.innerHTML =
    `<div class="scards" style="height:${lay.fieldH}px">` +
    layersHTML.map((html, d) => `<div class="scards__layer" data-depth="${d}">${html}</div>`).join('') +
    '</div>';
  for (const li of songWall.querySelectorAll('.scard')) {
    scaleEls.set(Number(li.dataset.id), li);
    li.addEventListener('click', () => {
      const id = ne.list[Number(li.dataset.i)].id;
      if (focusId === id) {          // 已在正中的歌：再点一次才真正播放
        selId = null;
        applySel();
        neteasePlay(Number(li.dataset.i));
        enterParticleFor(Number(li.dataset.i));   // 点歌即进粒子视界：封面立刻化成该曲的粒子
      } else {                       // 不在正中：第一击先把这首歌滑到中间选中
        selId = id;
        applySel(true);
        blip(1150);
      }
    });
    if (animate) li.classList.add('is-in');   // 呼入：--d 已写在行内，动画自行依次铺开
  }
  libEmpty.hidden = true;
  $('#lanBtn').hidden = !OWNER;
  $('#rescanBtn').hidden = !OWNER;
  fieldEl = songWall.querySelector('.scards');
  currentLay = lay;
  stopGlide();
  if (lay.sig !== prevLaySig) {      // 换歌单 / 顺序变化（如死歌置底）才回原点；扫描重渲保持视角
    pan.x = lay.initX; pan.y = lay.initY;
  }
  prevLaySig = lay.sig;
  focusId = null; focusEl = null;    // 卡片整批重挂：旧节点已销毁，聚焦标记让 updateFocus 重新落位
  applyPan();
  updateFocus();
  highlightRow();
  applyFilter();
}

/* ---------------- 卡片墙的散点布局 ----------------
   参照 folia-major 的海报墙：每首歌一个独立位置，随机散布、左右出血
   （大小随窗口伸缩、按到视口中心的距离连续缩放，见 scatterLayout / updateScales）。，且投放顺序按
   歌 id 排序：同一歌单每次进来布局一致（能形成记忆），扫描把死歌挪到
   列表末尾也不会让任何卡片跳位。巡游/聚焦交互见上方的拖拽平移控制器。 */

function highlightRow() {
  if (!ne.list.length) return;
  for (const li of songWall.querySelectorAll('.scard')) {
    const isCur = Number(li.dataset.i) === ne.idx;
    li.classList.toggle('is-cur', isCur);
    li.classList.toggle('is-playing', isCur && playing);
  }
  applySel();
}

function showRescan() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (songOpen) songSub.textContent = '重新扫描中…';
  startScan(true, false);
}

function showLAN() {
  // 画廊现在只有歌单墙一个视图，二维码固定画回墙上
  plWall.innerHTML = `
    <div class="panel__note">
      <img class="qr" alt="局域网访问二维码" src="/api/lan/qr">
      同一 Wi-Fi 下的手机 / 平板扫码打开，<br>
      各自用<strong>自己的网易云账号</strong>登录后播放自己的歌单<br>
      <span class="lanurl" id="lanUrl"></span><br>
      提示「不安全」是自签证书：Android 点<strong>高级 → 继续前往</strong>，iPhone 点<strong>访问此网站</strong><br>
      也可安装证书一劳永逸：<a class="btn btn--ghost" href="/cert.pem" download="tahoe-music.crt">下载证书</a><br>
      打不开？在地址栏输入 <strong>http://本机IP</strong>（不带端口，会自动跳到 https）
      <span class="qr-alt">
        <button type="button" class="btn btn--ghost" id="lanBack">返回</button>
      </span>
    </div>`;
  fetch(A('/api/lan')).then(r => r.json()).then(j => {
    const el = $('#lanUrl');
    if (el) el.textContent = j.url || '';
  }).catch(() => {});
  $('#lanBack').addEventListener('click', () => renderPlWall());
}

// 搜索：主界面（歌单长廊）过滤歌单卡，详情页过滤歌曲卡。
// 歌曲卡的过滤不直接切 hidden —— 那样是"啪"地消失；让它先演完退场再真正隐藏，
// 恢复的卡则重新挂一次入场动画（移除 class → 强制重排 → 加回，等价于 skill 里的 cloneNode 重触发）。
function applyFilter() {
  const q = libSearch.value.trim().toLowerCase();
  if (!body.classList.contains('songs-open')) { filterPlWall(q); return; }
  if (!ne.loaded) { libEmpty.hidden = true; return; }
  let visible = 0;
  let k = 0;
  for (const li of songWall.querySelectorAll('.scard')) {
    const s = ne.list[Number(li.dataset.i)] || {};
    const hit = !q ||
      (s.name || '').toLowerCase().includes(q) ||
      (s.ar || '').toLowerCase().includes(q);
    if (hit) {
      visible++;
      if (li.hidden || li.classList.contains('is-out')) {
        clearTimeout(li._exitT);
        li.classList.remove('is-out', 'is-in');
        li.hidden = false;
        li.style.setProperty('--d', Math.min(k++, 10));
        void li.offsetWidth;                 // 强制重排，让浏览器忘记上一轮动画
        li.classList.add('is-in');
      }
    } else if (!li.hidden && !li.classList.contains('is-out')) {
      li.classList.add('is-out');
      li._exitT = setTimeout(() => {
        li.hidden = true;
        li.classList.remove('is-out');
      }, 240);
    }
  }
  libEmpty.hidden = visible > 0 || !q;
}

// 主界面（歌单长廊）的搜索：不跳页 —— 不匹配的歌单卡压暗、不可点（长廊轮播
// 每帧写 opacity 且按序号摆位，压暗用 filter、绝不能隐藏），匹配的照常可点。
// 返回第一个匹配的序号，供回车居中跳转（见下方 libSearch 的 keydown）。
function filterPlWall(q) {
  let first = -1;
  [...plWall.querySelectorAll('.plc')].forEach((el, i) => {
    const hit = !q || el.title.toLowerCase().includes(q);
    el.classList.toggle('is-dim', !!q && !hit);
    if (q && hit && first < 0) first = i;
  });
  return first;
}

libSearch.addEventListener('input', () => {
  libSearchWrap.classList.toggle('has-q', !!libSearch.value);
  applyFilter();
  // 云端联想：网易云全库搜歌，防抖 350ms，下拉里点一行即播
  const q = libSearch.value.trim();
  clearTimeout(searchDebT);
  if (!q) { closeSearchPop(); return; }
  searchDebT = setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const j = await fetch(A('/api/search?kw=' + encodeURIComponent(q)), { cache: 'no-store' }).then(r => r.json());
      if (seq !== searchSeq || !libSearch.value.trim()) return;   // 已改成别的词/已清空
      renderSearchPop(j.songs || []);
    } catch { closeSearchPop(); }     // 服务器没起就当没有联想
  }, 350);
});

/* 网易云全库搜索下拉：结果行结构与歌单行一致，点一行就追加进当前队列
   （没有队列就临时建一个），走同一条播放管线 —— URL/歌词/粒子全通。 */
function closeSearchPop() {
  searchPop.hidden = true;
  searchPop.innerHTML = '';
  searchRows = [];
  searchHot = -1;
}

function renderSearchPop(songs) {
  searchRows = songs;
  searchHot = -1;
  searchPop.hidden = false;
  searchPop.innerHTML = songs.length
    ? '<p class="searchpop__head">网易云 · 点一行即播</p>' + songs.map((s, i) => `
      <button class="searchpop__row" type="button" data-i="${i}">
        ${s.pic ? `<img loading="lazy" src="${esc(bigImg(s.pic, 120))}" alt="">` : '<img alt="">'}
        <span class="tt"><span class="nm">${esc(s.name)}</span><span class="ar">${esc(s.ar || '未知歌手')}</span></span>
        <span class="du">${fmt(s.dt)}</span>
      </button>`).join('')
    : '<p class="searchpop__empty">网易云里没有找到匹配的歌曲</p>';
  for (const el of searchPop.querySelectorAll('.searchpop__row')) {
    el.addEventListener('click', () => playSearchSong(searchRows[Number(el.dataset.i)]));
  }
}

function searchHotMove(dir) {
  if (!searchRows.length) return;
  searchHot = (searchHot + dir + searchRows.length) % searchRows.length;
  for (const el of searchPop.querySelectorAll('.searchpop__row')) {
    el.classList.toggle('is-hot', Number(el.dataset.i) === searchHot);
  }
  const hot = searchPop.querySelector('.searchpop__row.is-hot');
  if (hot) hot.scrollIntoView({ block: 'nearest' });
}

function playSearchSong(s) {
  closeSearchPop();
  libSearch.value = '';
  libSearchWrap.classList.remove('has-q');
  applyFilter();
  libSearch.blur();
  const dup = ne.list.findIndex(t => t.id === s.id);
  const idx = dup >= 0 ? dup : ne.list.length;
  if (dup < 0) {
    ne.list.push(s);
    ne.loaded = true;
    if (songOpen) renderSongCards(false);   // 详情页开着就把这张卡也补进去
  }
  neteasePlay(idx);
}

// 点搜索框外面收起联想（capture 阶段，先于行点击也无所谓——行在框内，不会命中）
document.addEventListener('pointerdown', e => {
  if (searchPop.hidden || libSearchWrap.contains(e.target)) return;
  closeSearchPop();
}, true);

// 搜索框内：Esc 先收联想、再清空退出；回车播联想高亮行（没有联想才跳卡片匹配）；
// ↑↓ 在联想行间移动高亮
libSearch.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!searchPop.hidden) { closeSearchPop(); return; }
    libSearch.value = '';
    libSearchWrap.classList.remove('has-q');
    applyFilter();
    libSearch.blur();
  } else if (e.key === 'ArrowDown') {
    if (!searchPop.hidden) { e.preventDefault(); searchHotMove(1); }
  } else if (e.key === 'ArrowUp') {
    if (!searchPop.hidden) { e.preventDefault(); searchHotMove(-1); }
  } else if (e.key === 'Enter') {
    if (!searchPop.hidden && searchRows.length) {
      playSearchSong(searchRows[Math.max(searchHot, 0)]);
      return;
    }
    if (!body.classList.contains('songs-open')) {
      const first = filterPlWall(libSearch.value.trim().toLowerCase());
      if (first >= 0 && carousel.n > 0) {
        carousel.posT = clamp(first, 0, carousel.n - 1);
        carouselRun();
        blip(1150);
      }
    } else {
      const first = [...songWall.querySelectorAll('.scard')]
        .find(li => !li.hidden && !li.classList.contains('is-out'));
      if (first) {
        selId = ne.list[Number(first.dataset.i)].id;
        applySel(true);
        blip(1150);
      }
    }
  }
});

$('#searchClear').addEventListener('click', () => {
  libSearch.value = '';
  libSearchWrap.classList.remove('has-q');
  closeSearchPop();
  applyFilter();
  libSearch.focus();
});

// 歌名/歌手来自外部数据，插入 DOM 前必须转义
function esc(t) {
  const d = document.createElement('div');
  d.textContent = t == null ? '' : String(t);
  return d.innerHTML;
}

/* ---------------- 歌词（只服务粒子视界） ----------------

   以前这里还维护右侧抽屉的 DOM，以及逐行浮现 / 退场的一整套动画。
   抽屉和「词」按钮都移除之后，歌词只剩一个用途：告诉粒子视界当前唱到第几句。
   所以这一块不再碰任何 DOM —— 只维护 lyr.lines（纯数据）和 lyr.idx，
   视界那边由 syncParticleView() 一次性同步过去。 */

const lyr = { songId: 0, lines: [], idx: -1 };

function parseLrc(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const times = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)].map(m => +m[1] * 60 + +m[2]);
    const content = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const t of times) out.push({ t, text: content });
  }
  return out.sort((a, b) => a.t - b.t);
}

async function loadLyric(s) {
  lyr.songId = s.id;
  lyr.lines = []; lyr.idx = -1;
  syncParticleView();     // 换歌瞬间先把旧歌词清掉，避免串词

  let j = {};
  try { j = await fetch(A('/api/lyric?id=' + s.id)).then(r => r.json()); } catch { /* 取不到就当纯音乐 */ }
  if (lyr.songId !== s.id) return;      // 取词期间已切歌

  const lrc = parseLrc(j.lrc || '');
  if (!lrc.length) { syncParticleView(); return; }   // 纯音乐：没有可同步的句子
  const tlMap = new Map(parseLrc(j.tlrc || '').map(l => [l.t.toFixed(2), l.text]));
  lyr.lines = lrc.map(l => ({ t: l.t, text: l.text, tl: tlMap.get(l.t.toFixed(2)) || '' }));
  syncLyric();
  syncParticleView();
}

function syncLyric() {
  if (!lyr.lines.length) return;
  // 提前 0.4s 切到下一句：粒子视界里"唱到哪句出哪句"，词要略早于实际开唱
  // 浮现，观感才跟拍、不像慢半拍。
  const t = audio.currentTime + 0.4;
  let i = 0;
  while (i < lyr.lines.length && lyr.lines[i].t <= t) i++;
  i = Math.max(0, i - 1);
  if (i === lyr.idx) return;
  lyr.idx = i;
  if (window.ParticleStage) ParticleStage.setActive(i);
}

// 没有可同步的歌词（纯音乐 / 还没播歌）：清空即可
function clearLyric() {
  lyr.lines = []; lyr.idx = -1;
  syncParticleView();
}

/* ---------------- 粒子视界（封面 → 高斯粒子 + 旋律歌词） ----------------
   视图本体在 particles.js：WebGL 高斯溅射 + 歌词 DOM。
   这里只负责三件事：告诉它用哪张封面、把歌词同步过去、管开关与快捷键。

   进入方式有两条：
     ① 在歌单详情页点某首歌播放时自动进入（"点歌即进"，见 enterParticleFor）；
     ② 点底部播放条的封面（见 toggleParticleFromArt）—— 正在听的时候不必退回歌单页。
   Esc / 右上角关闭按钮 / 再点一次封面都能退出。

   封面一律走同源：网易云的专辑图经 /api/cover 由服务端代取，
   否则 canvas 读像素会被跨域污染（tainted），粒子根本建不起来。 */

// 当前该拿什么当封面：有歌用专辑图；没歌就用当前壁纸兜底（粒子视界照样能开）
function coverSrcFor() {
  const s = ne.list[ne.idx];
  return s ? A('/api/cover?id=' + s.id + '&size=640') : curWall().src;
}

function particleMeta() {
  const s = ne.list[ne.idx];
  if (s) return { title: s.name || '网易云音乐', sub: [s.ar, s.al].filter(Boolean).join(' · ') };
  return { title: '未在播放', sub: '从歌单里选一首歌' };
}

function syncParticleCover() {
  if (!window.ParticleStage || !ParticleStage.isOpen()) return;
  const m = particleMeta();
  ParticleStage.setCover(coverSrcFor(), { title: m.title, sub: m.sub });
}

// 封面 / 曲名 / 歌词任意一处变了都汇到这里，免得三处各写一份
function syncParticleView() {
  if (!window.ParticleStage || !ParticleStage.isOpen()) return;
  const m = particleMeta();
  ParticleStage.setCover(coverSrcFor(), { title: m.title, sub: m.sub });
  if (lyr.lines.length) {
    ParticleStage.setLyrics(lyr.lines.map(l => ({ t: l.t, text: l.text })), m.title);
    ParticleStage.setActive(lyr.idx);
  } else {
    ParticleStage.setLyrics([], '');
  }
}

let particleListRestore = true;   // 进视界前歌单的开关状态，退出时还原

function setParticleOpen(open) {
  if (!window.ParticleStage) return;
  if (open) {
    ensureCtx();   // 按键音与频谱分析都要用，顺便把挂起的上下文唤醒
    if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch { /* noop */ } }
    particleListRestore = !body.classList.contains('list-closed');
    setListOpen(false);   // 播放条要浮到视界上层，歌单先收起
    ParticleStage.open();
    syncParticleView();
    syncNavTabs();
    whoosh();
  } else {
    ParticleStage.close();
    setListOpen(particleListRestore);
    blip(980);
  }
  syncNavTabs();
}

$('#pClose').addEventListener('click', () => setParticleOpen(false));

/* 点歌即进粒子视界：从歌单详情页点某首歌播放时调用。
   注意 neteasePlay 是异步的 —— ne.idx 要等取到 songurl 才更新，所以这里
   不等它：先用点击的这首歌本身（i）把封面喂给视界，避免闪一下上一首。
   ne.idx 更新后 updateTrackUI → syncParticleCover 会再校一次，二者一致。 */
function enterParticleFor(i) {
  if (!window.ParticleStage) return;
  const s = ne.list[i];
  const cover = s ? A('/api/cover?id=' + s.id + '&size=640') : coverSrcFor();
  const meta = s
    ? { title: s.name || '网易云音乐', sub: [s.ar, s.al].filter(Boolean).join(' · ') }
    : particleMeta();
  ensureCtx();
  if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch { /* noop */ } }
  particleListRestore = !body.classList.contains('list-closed');
  setListOpen(false);
  ParticleStage.open({ cover, title: meta.title, sub: meta.sub });
  syncNavTabs();
  whoosh();
}

/* 第二条进入粒子视界的入口：点底部播放条的封面。
   已经开着就当开关用 —— 再点一下退出，不用去够右上角的关闭键。
   正在放网易云歌曲就进这一首（复用"点歌即进"那条路，封面/曲名/歌词都对得上）；
   还没有在播的歌就走通用入口，封面用当前壁纸（见 coverSrcFor）。 */
function toggleParticleFromArt() {
  if (!window.ParticleStage) return;
  if (ParticleStage.isOpen()) { setParticleOpen(false); return; }
  if (ne.list[ne.idx]) enterParticleFor(ne.idx);
  else setParticleOpen(true);
}

$('#art').addEventListener('click', toggleParticleFromArt);

/* ---------------- 时钟 ---------------- */

function tickClock() {
  const d = new Date();
  $('#clockTime').textContent =
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  $('#clockDate').textContent =
    `${d.getMonth() + 1}月${d.getDate()}日 星期${'日一二三四五六'[d.getDay()]}`;
}
tickClock();
setInterval(tickClock, 1000);

/* ---------------- 顶部导航胶囊 + 桌面 App 窗口桥 ---------------- */

const navTabs = {
  amb: $('#navAmbience'),
  lib: $('#navLibrary'),
  stage: $('#navStage'),
};
const helpPop = $('#helpPop'), navHelp = $('#navHelp');

// 三个标签的高亮跟随视图状态；粒子开合不改 body class 时也要能刷新，
// 所以 setParticleOpen / enterParticleFor 里会手动补一次
function syncNavTabs() {
  const pOpen = !!(window.ParticleStage && ParticleStage.isOpen());
  const songs = body.classList.contains('songs-open');
  const listOpen = !body.classList.contains('list-closed');
  navTabs.stage.classList.toggle('is-active', pOpen);
  navTabs.lib.classList.toggle('is-active', !pOpen && (songs || listOpen));
  navTabs.amb.classList.toggle('is-active', !pOpen && !songs && !listOpen);
}
new MutationObserver(syncNavTabs).observe(body, { attributes: true, attributeFilter: ['class'] });
syncNavTabs();

navTabs.amb.addEventListener('click', () => {          // 音景：回到壁纸 + 液态音景主视图
  if (window.ParticleStage && ParticleStage.isOpen()) setParticleOpen(false);
  if (songOpen) setSongOpen(false);
  setListOpen(false);
});
navTabs.lib.addEventListener('click', () => {          // 歌单：进歌单墙（未登录先去扫码）
  if (window.ParticleStage && ParticleStage.isOpen()) setParticleOpen(false);
  if (!acct.loggedIn) { setLoginOpen(true); return; }
  if (songOpen) setSongOpen(false);
  setListOpen(true);
});
navTabs.stage.addEventListener('click', () => {        // 视界：粒子舞台开关
  if (window.ParticleStage && ParticleStage.isOpen()) { setParticleOpen(false); return; }
  if (ne.list[ne.idx]) enterParticleFor(ne.idx);
  else setParticleOpen(true);
});
navHelp.addEventListener('click', () => { helpPop.hidden = !helpPop.hidden; });
document.addEventListener('pointerdown', e => {
  if (helpPop.hidden || helpPop.contains(e.target) || navHelp.contains(e.target)) return;
  helpPop.hidden = true;
}, true);

/* 无边框窗口控制：最小化 / 最大化 / 关闭 / 全屏、边缘缩放热区（.rz），
   统一走 deskSend（C++ 壳=postMessage，pywebview 版=js_api）。 */
$('#winMin').addEventListener('click', () => deskSend('min'));
$('#winMax').addEventListener('click', () => deskSend('max'));
$('#winClose').addEventListener('click', () => deskSend('close'));
document.querySelectorAll('.rz').forEach(z => z.addEventListener('pointerdown', e => {
  e.preventDefault();
  deskSend('rz', z.dataset.rz);
}));
document.querySelectorAll('.pywebview-drag-region').forEach(el =>
  el.addEventListener('dblclick', () => deskSend('max')));

if (CPP_SHELL) {
  // C++ 壳通过 postMessage 回传最大化状态，驱动 body.app-max（隐藏缩放热区）
  window.chrome.webview.addEventListener('message', e => {
    try {
      const d = e.data;
      if (d && typeof d === 'object' && 'max' in d) body.classList.toggle('app-max', !!d.max);
    } catch (err) { /* 非 JSON 消息忽略 */ }
  });
} else {
  const bindDesk = () => {
    if (window.pywebview && window.pywebview.api) desk.api = window.pywebview.api;
  };
  if (window.pywebview && window.pywebview.api) bindDesk();
  else window.addEventListener('pywebviewready', bindDesk);

  // 最大化状态下顶栏拖拽不移动窗口（拦在 pywebview 注入的 body 监听之前）
  document.addEventListener('mousedown', e => {
    if (!body.classList.contains('app-max')) return;
    if (e.target.closest && e.target.closest('.pywebview-drag-region')) e.stopPropagation();
  }, true);
}

/* ---------------- 渲染循环：频谱 + 进度 ---------------- */

const NBARS = 16;
const bars = [];
for (let i = 0; i < NBARS; i++) {
  const s = document.createElement('span');
  vizEl.appendChild(s);
  bars.push(s);
}
const freqData = new Uint8Array(64);
const levels = new Float32Array(NBARS);
/* 静止时的"波形剪影"：不播放时不是一条平线（那看着像条断掉的虚线），
   而是一排高低错落的短柱，像被暂停住的频谱；
   播放时真实频谱在这个基础上把每根往上推。 */
const REST = Float32Array.from({ length: NBARS },
  (_, i) => 0.20 + 0.16 * (0.5 + 0.5 * Math.sin(i * 1.9 + 0.6)));
let lastTimeLabel = '';

/* ---- 粒子视界要的音频特征：分频能量 + 总能量 + 节拍 ----
   在 2048 点频谱上按频段取均值：低频 30–200、中频 200–2k（旋律主体）、
   高频 2k–9k（亮度/空气感）。节拍用低频对"自身近 1 秒滑动均值"的突起来判，
   比固定阈值稳，慢歌快歌都不用调参。 */
const bassHist = new Float32Array(48);
let bassHistN = 0, bassHistI = 0, bassSum = 0, lastBeatAt = 0;
const pAudio = { level: 0, bass: 0, mid: 0, treble: 0, beat: 0 };

function analyseForParticles(now) {
  if (!analyser2 || !ctx || !playing) {
    pAudio.level = pAudio.bass = pAudio.mid = pAudio.treble = pAudio.beat = 0;
    return pAudio;
  }
  analyser2.getByteFrequencyData(melData);
  const binHz = ctx.sampleRate / analyser2.fftSize;
  const n = melData.length;

  const band = (lo, hi) => {
    const a = Math.max(1, Math.round(lo / binHz));
    const b = Math.min(n - 1, Math.round(hi / binHz));
    let s = 0;
    for (let i = a; i <= b; i++) s += melData[i];
    return s / ((b - a + 1) * 255);
  };

  pAudio.bass = band(30, 200);
  pAudio.mid = band(200, 2000);
  pAudio.treble = band(2000, 9000);
  // 总能量偏中低频加权，否则镲片一响整幅粒子就乱跳
  pAudio.level = pAudio.bass * 0.42 + pAudio.mid * 0.46 + pAudio.treble * 0.12;

  bassSum -= bassHist[bassHistI];
  bassHist[bassHistI] = pAudio.bass;
  bassSum += pAudio.bass;
  bassHistI = (bassHistI + 1) % bassHist.length;
  if (bassHistN < bassHist.length) bassHistN++;
  const avg = bassSum / bassHistN;

  if (pAudio.bass > avg * 1.34 + 0.035 && now - lastBeatAt > 240) {
    lastBeatAt = now;
    pAudio.beat = 1;
  } else {
    pAudio.beat = 0;
  }
  return pAudio;
}

function frame(now) {
  requestAnimationFrame(frame);
  const ts = now || performance.now();
  const live = analyser && playing;
  if (live) analyser.getByteFrequencyData(freqData);

  let sum = 0;
  for (let i = 0; i < NBARS; i++) {
    let v = 0;
    if (live) {
      const bi = 2 + Math.floor(Math.pow(i / NBARS, 1.5) * 46);
      v = freqData[bi] / 255;
    }
    levels[i] = Math.max(v, levels[i] * 0.86);
    sum += levels[i];
    bars[i].style.transform = `scaleY(${(REST[i] + levels[i] * (1 - REST[i])).toFixed(3)})`;
  }

  // 封面随音乐呼吸
  const avg = sum / NBARS;
  artEl.style.transform = `scale(${(1 + avg * 0.06).toFixed(4)})`;

  // 粒子视界开着时才做这套分析，省掉常态下的开销
  if (window.ParticleStage && ParticleStage.isOpen()) {
    ParticleStage.setAudio(analyseForParticles(ts));
  }

  // 进度（拖拽中优先显示手指位置）
  updateProgressUI();
}

function updateProgressUI() {
  const tot = total();
  const p = scrubFrac !== null ? scrubFrac * tot : (audio.currentTime || 0);
  const pct = tot ? p / tot * 100 : 0;
  seekFill.style.clipPath = `inset(0 ${100 - pct}% 0 0 round 999px)`;
  seekThumb.style.left = pct + '%';
  seek.setAttribute('aria-valuenow', String(Math.round(p)));

  const label = fmt(p);
  if (label !== lastTimeLabel) {
    lastTimeLabel = label;
    tCur.textContent = label;
  }
}
frame();

/* ---------------- 初始化 ---------------- */

measureConsole();
tTotal.textContent = fmt(0);
volEl.style.setProperty('--v', volEl.value + '%');
updateTrackUI();
paintWall(FALLBACK_WALL, false);   // 首屏：纯 CSS 底纹，不用等任何图片
updateWallUI();

// 歌单到位后壁纸会自动换成封面（见 carouselApply → syncWallToCenter），
// 所以这里不再需要预取任何壁纸资源。

// 面板常驻，歌单在入场动画之后再开始拉取，避免和首屏动画抢帧
setTimeout(() => initLibrary(true), 420);
