/* ============================================================
   Tahoe · 粒子视界 — Mineradio 风格的电影粒子舞台
   ------------------------------------------------------------
   视觉语言对齐 Mineradio（github.com/XxHuberrr/Mineradio-paused）：
   封面化作一片高斯粒子尘埃，架在「电影镜头」下——机位之间长时间
   推拉摇移、慢慢扫过，配合歌词舞台做出"现场感"。

   采样仍走「模糊亮度 + 中心先验」的伪深度（前身是 SHARP 思路的
   浏览器端单图重建），渲染原语是 gl.POINTS + exp(-r²) 软光斑。

   这一版刻意与旋律解耦：粒子只受时间与手势驱动——
   · 多频慢漂移（光束里的灰尘）+ 全队形 ~18s 的极慢呼吸
   · 镜头导演按时间在机位间推拉摇移，叠加手持微晃
   · 一道舞台灯缓缓横扫、微尘慢闪，现场感来自灯光而非音乐
   音频特征只喂给歌词层（setAudio → driveLyrics），粒子不读。

   本文件只负责「视图」：封面 → 高斯 → 上屏。
   歌词数据由 app.js 推入（setLyrics / setActive）。
   ============================================================ */
'use strict';

const ParticleStage = (function () {

  /* ══════════════ 常量 ══════════════ */

  const FOV = 44 * Math.PI / 180;
  const MAX_DPR = 1.5;          // 粒子是加法混合的软光斑，超采样收益很低，压住省电
  const PLANE = 2.0;            // 封面在世界空间里的宽度
  const Z_SPAN = 0.95;          // 深度方向总厚度（世界单位）
  const NEAR = 0.05, FAR = 40;

  /* ══════════════ 状态 ══════════════ */

  let root, viewEl, canvas, gl = null, glFail = false;
  let titleEl, subEl, hintEl, lyrBody, badgeEl, zoomValEl;

  let inited = false, opened = false, raf = 0, ctxLost = false;

  let prog = null, uni = {}, attrs = {}, vbo = null, count = 0;

  let dpr = 1, cw = 1, ch = 1, sizeK = 1, aspect = 1;

  // 相机：镜头导演的长镜头 + 指针视差 + 可拖拽 + 可滚轮缩放
  const cam = { yaw: 0, pitch: 0, radius: 3.3, baseRadius: 3.3, dragYaw: 0, dragPitch: 0 };
  /* dollySmooth：把镜头机位自身的推拉（shot.dolly）单独平滑。
     为什么要拆出来：cam.radius 原本是一条"级联平滑"——
        zoomFactor →(dt*5.5)→ zoomApplied →(dt*1.8)→ cam.radius
     两级串起来的时间常数 ≈ 0.18s + 0.55s ≈ 0.73s，双击复位要 ~4s 才
     回到 1.0（实测过），滚轮手感明显发黏。而第二级存在的唯一理由，
     是让镜头切机位时 dolly 变化得柔和 —— 它本来就不是为缩放服务的。
     拆开后：cam.radius = baseRadius（只由 zoomApplied 定，单级平滑）
                        × dollySmooth（只由 shot.dolly 定，单级平滑）
     缩放和镜头各走各的单级平滑，既快又不互相拖累。 */
  let dollySmooth = 1;
  let drag = null;
  const ptr = { x: 0, y: 0, sx: 0.5, sy: 0.5, inside: false };

  /* ══════════════ 滚轮缩放 ══════════════
     思路：不改相机机位（那是导演的活），而是先按"封面顶满画面"求出中立距离
     fitFloor，再让滚轮去除一个 zoomFactor（0.42~2.6）。
       >1 = 距离变小 = 拉近放大，<1 = 退远缩小，=1 = 当前正好装下整张封面。
     （注意是 fitFloor / zoomFactor —— radius 越大画面越小，所以除不是乘。）
     机位的 dolly（0.80~1.06）只作用在 fitFloor 之上，所以放大后即便切到
     最近的机位也不会重新把封面裁掉——缩放尺度始终由用户说了算。 */
  const ZOOM_MIN = 0.42, ZOOM_MAX = 2.6;
  let fitFloor = 3.3, zoomFactor = 1, zoomApplied = 1;
  let zoomAt = 0;               // 停手时刻，用来在超时后慢慢归位
  let zoomHudTimer = 0;
  let lastLyricZoom = -1;       // 上一帧写给歌词的缩放值（量化去重，避免每帧重排样式）
  let lastLyrIn = null;         // 上一帧写入的入场方向（fadeInUp / fadeInDown，去重）
  let lastLyrPitch = null;      // 上一帧的俯仰角（度），用来判断"面正在往上还是往下走"
  let lastLyrW = -1;            // 上一帧歌词可用宽度（1px 量化去重）
  let lyrBudgetW = 0;           // 歌词容器当前实际像素宽（由 resizeLyricText 写）
  let lastWrapW = -1;           // 上次断行所用的宽度（变化 >6px 才重排）
  const ZOOM_IDLE_MS = 6000;    // 停手多久开始自动归位（0 表示关掉自动归位）
  let zoomShowOnce = true;      // 首次进入视界时演示一次缩放，让人知道能滚

  function zoomHud() {
    if (!root) return;
    root.style.setProperty('--zoom', zoomFactor.toFixed(3));
    if (zoomValEl) zoomValEl.textContent = Math.round(zoomFactor * 100) + '%';
    root.classList.add('is-zooming');
    clearTimeout(zoomHudTimer);
    zoomHudTimer = setTimeout(() => root.classList.remove('is-zooming'), 1100);
  }

  /* ══════════════ 镜头导演 ══════════════
     Mineradio 的「电影镜头」：一组机位之间缓慢推拉摇移，每个镜头
     停十几秒再滑向下一个。纯时间驱动，不读任何音频特征；
     拖拽/双击复位是手势，叠加在导演机位之上。 */
  const SHOTS = [
    { yaw: 0.00,  pitch: 0.00,  dolly: 1.00 },   // 正面全景
    { yaw: 0.26,  pitch: 0.07,  dolly: 0.86 },   // 右前 3/4 近景
    { yaw: -0.30, pitch: -0.06, dolly: 0.92 },   // 左前微仰
    { yaw: 0.12,  pitch: 0.13,  dolly: 0.80 },   // 低角度特写
    { yaw: -0.22, pitch: 0.05,  dolly: 1.06 },   // 左前远景
    { yaw: 0.33,  pitch: -0.09, dolly: 0.95 },   // 右前掠过
  ];
  const SHOT_HOLD = 13000, SHOT_MOVE = 5600;
  let shotA = SHOTS[0], shotB = SHOTS[0], shotAt = 0;

  function shotNow(now) {
    if (now - shotAt >= SHOT_HOLD + SHOT_MOVE) {
      let next;
      do { next = SHOTS[(Math.random() * SHOTS.length) | 0]; } while (next === shotB);
      shotA = shotB;
      shotB = next;
      shotAt = now;
    }
    const p = Math.min(1, (now - shotAt) / SHOT_MOVE);
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;   // easeInOutQuad
    return {
      yaw: shotA.yaw + (shotB.yaw - shotA.yaw) * e,
      pitch: shotA.pitch + (shotB.pitch - shotA.pitch) * e,
      dolly: shotA.dolly + (shotB.dolly - shotA.dolly) * e,
    };
  }

  // 音频特征（app.js 每帧写入原始值，这里做平滑）
  const raw = { level: 0, bass: 0, mid: 0, treble: 0, beat: 0 };
  const sm = { level: 0, bass: 0, mid: 0, treble: 0 };
  let burst = 0, hover = 0, t0 = 0, lastT = 0;

  // 歌词
  let lyricLines = [], activeIdx = -1, lineEls = [];

  // 封面构建的竞态令牌
  let buildToken = 0;
  let lastCoverKey = '';

  const TMP = new Float32Array(16);
  const PROJ = new Float32Array(16);
  const VIEW = new Float32Array(16);
  const VP = new Float32Array(16);

  /* ══════════════ 4×4 矩阵（只用到透视 / lookAt / 相乘） ══════════════ */

  function perspective(out, fovy, asp, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    out.fill(0);
    out[0] = f / asp; out[5] = f;
    out[10] = (far + near) * nf; out[11] = -1;
    out[14] = 2 * far * near * nf;
    return out;
  }

  function lookAt(out, ex, ey, ez, cx, cy, cz, ux, uy, uz) {
    let zx = ex - cx, zy = ey - cy, zz = ez - cz;
    let l = Math.hypot(zx, zy, zz) || 1;
    zx /= l; zy /= l; zz /= l;
    let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
    l = Math.hypot(xx, xy, xz) || 1;
    xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * ex + xy * ey + xz * ez);
    out[13] = -(yx * ex + yy * ey + yz * ez);
    out[14] = -(zx * ex + zy * ey + zz * ez);
    out[15] = 1;
    return out;
  }

  function mul(out, a, b) {
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      out[c * 4]     = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
      out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
      out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return out;
  }

  /* ══════════════ 着色器 ══════════════
     顶点：把每颗高斯沿深度/横向做音乐驱动的位移，再做透视投影，
           gl_PointSize 按 1/距离 缩放（这就是视差的来源）。
     片元：gl_PointCoord 上的 exp(-r²) 软光斑 = 各向同性高斯核，
           减去边界值让边缘归零，得到没有硬边的溅射点。 */

  const VS = `
attribute vec3 aPos;
attribute vec3 aColor;
attribute float aSize;
attribute float aSeed;
attribute float aAlpha;

uniform mat4 uVP;
uniform float uTime;
uniform float uHover;
uniform vec2 uMouse;
uniform float uSizeK;
uniform float uSizeMul;
uniform float uHalfY;

varying vec3 vColor;
varying float vAlpha;
varying float vEdgeW;

void main() {
  vec3 p = aPos;
  float ph = aSeed * 6.2831853;

  // 波纹环：以圆角方形距离场做相位，从封面中心缓慢向外荡开 ——
  // 点阵沿径向被推开半个格距、深度上微微起伏，形成参考图里的等高线环
  vec2 pn = aPos.xy / vec2(1.0, uHalfY);          // 归一化到 [-1,1]²
  vec2 q = abs(pn) - vec2(0.60);
  float dsd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  float ring = sin(dsd * 15.0 - uTime * 0.85);
  vec2 rdir = pn / max(0.2, length(pn));
  p.xy += rdir * ring * 0.0090;
  p.z  += ring * 0.0060;

  // 保底的生命感：极小的多频漂移（~0.3 格距），阵列活着但不乱
  p += vec3(
    sin(uTime * 0.16 + ph * 1.7) + 0.5 * sin(uTime * 0.071 + ph * 3.1),
    cos(uTime * 0.13 + ph * 2.3) + 0.5 * sin(uTime * 0.083 + ph * 4.7),
    sin(uTime * 0.11 + ph * 3.9)
  ) * 0.0035;

  // 整个队形以 ~18s 周期极慢地呼吸（±1.2%），暂停播放时也像活着
  p *= 1.0 + 0.012 * sin(uTime * 0.349);

  // 指针斥力：世界坐标下的软推开（手势，不是旋律）
  vec2 d = p.xy - uMouse;
  p.xy += d * uHover * exp(-dot(d, d) * 3.0);

  vec4 mv = uVP * vec4(p, 1.0);
  gl_Position = mv;

  // 近大远小：视差来自机位运动，不来自音乐。
  // 下限 0.45px：继续下探到亚像素区间。GPU 对 <1px 的点按"覆盖率"绘制 ——
  // 点不会消失，而是变暗、变得更细（这正是我们要的"更小"）。
  // 0.45 是实测下限：再低时点会在漂移中整帧丢失，出现闪烁。
  float dist = max(0.35, -mv.z);
  gl_PointSize = clamp(aSize * uSizeK / dist * uSizeMul, 0.45, 160.0);

  // 抗锯齿带宽：屏幕上一个像素对应多少半径单位（r ∈ [0,1]）。
  // 在顶点算好传下去，片元不依赖 fwidth/OES_standard_derivatives。
  // 带宽 0.8px 与点径同步收窄：亚像素点整颗都没几个像素，
  // 带宽稍大就会把点彻底化开、失去颗粒感，故取较小值。
  vEdgeW = clamp(0.8 / max(gl_PointSize, 0.45), 0.03, 0.5);

  // 舞台灯：一道亮区极慢地横扫封面（~63s 一圈），现场感来自灯光
  float sweep = 0.5 + 0.5 * sin(uTime * 0.10 + aPos.x * 0.9);
  vColor = aColor * (1.00 + sweep * 0.22);

  // 微尘闪烁：相位错开的慢闪，永远在动但不吵
  vAlpha = aAlpha * (0.86 + 0.14 * sin(uTime * 0.7 + ph * 20.0));
}
`;

  const FS = `
precision mediump float;
uniform float uPass;      // 0 = 本体（正常混合）  1 = 光晕（加法混合）
varying vec3 vColor;
varying float vAlpha;
varying float vEdgeW;     // 边缘羽化带宽（半径单位），由顶点按点径算好传下来
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float r2 = dot(q, q) * 4.0;          // 圆心 0 → 边缘 1
  float r = sqrt(r2);
  if (r2 > 1.0) discard;               // 圆形裁剪

  /* 实心圆点（点阵风格：放大后颗粒分明、边缘干脆）
     参考 Mineradio 截图：它的点没有任何光晕，就是干净的小圆点，
     远看拼成灰阶画面、近看粒粒独立。所以这里：
       · 圆盘内部完全满色（不做中心提亮，避免"灯珠"的发光感）
       · 边缘只留 w 宽的过渡（w 由顶点按点径给，约 1.1 物理像素）
     不再对暗部做绕行，点径小 + 无光晕 = 参考图那种"稀疏但不散"的观感。 */
  float w = vEdgeW;
  float fall = smoothstep(1.0, 1.0 - w, r);
  if (fall <= 0.002) discard;

  /* 光晕 pass 大幅压低（0.09 → 0.028）：
     参考图是无光晕的实心点阵，先前 0.09 的加法光晕会让密集区糊成一片雾。
     保留极微量只为让画面不至于"死平"，肉眼几乎看不出。 */
  float lum = dot(vColor, vec3(0.299, 0.587, 0.114));
  float glow = 0.028 * (0.15 + lum * 0.85);
  // 光晕 pass 用很小的柔核，贴在点缘；本体 pass 就是硬边圆盘。
  float soft = 1.0 - smoothstep(0.30, 1.0, r);
  float shape = mix(fall, soft, uPass * 0.6);
  float a = shape * vAlpha * mix(1.0, glow, uPass);

  gl_FragColor = vec4(vColor, a);
}
`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('[粒子视界] 着色器编译失败：', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  /* ══════════════ 封面 → 高斯 ══════════════
     1) 把封面缩到 GW×GH 的采样网格（一个像素 = 一颗高斯）
     2) 亮度做可分离箱式模糊 → 平滑的深度场（亮处更靠近相机）
     3) 叠加中心先验（主体通常在中景），再按"细节量"调半径：
        边缘越强的地方高斯越小，图像细节才不会被糊掉 */

  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = acc / (2 * r + 1);
        acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }

  // 从封面里挑一个"主色"，用来给玻璃和歌词染色
  function pickAccent(data, n) {
    const hist = new Map();
    for (let i = 0; i < n; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx ? (mx - mn) / mx : 0;
      if (mx < 40) continue;                        // 太暗的像素不参与
      const w = sat * sat * (mx / 255) + 0.02;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const cur = hist.get(key) || [0, 0, 0, 0];
      cur[0] += r * w; cur[1] += g * w; cur[2] += b * w; cur[3] += w;
      hist.set(key, cur);
    }
    let best = null;
    for (const v of hist.values()) if (!best || v[3] > best[3]) best = v;
    if (!best || !best[3]) return null;
    const to = x => Math.round(Math.min(255, Math.max(0, x / best[3])));
    // 提一点亮度和饱和，免得从暗封面上取到一坨灰
    const r = to(best[0]), g = to(best[1]), b = to(best[2]);
    const mx = Math.max(r, g, b) || 1, k = Math.min(1.35, 190 / mx);
    const to2 = x => Math.round(Math.min(255, x * k));
    return `rgb(${to2(r)}, ${to2(g)}, ${to2(b)})`;
  }

  function buildGaussians(img) {
    const natW = img.naturalWidth || img.width || 1;
    const natH = img.naturalHeight || img.height || 1;
    aspect = natW / natH;

    const mobile = matchMedia('(max-width: 800px)').matches;
    // 网格密度：回到 21000（≈145 列）。点径已压到最小（0.05，亚像素级），
    // 此时"更细腻"只能靠点更多来实现 —— 点密了、格距小了，
    // 单点绝对尺寸随之更小，整体呈现细密如砂的点阵。
    // 注意：上限 220 列是硬约束（再高会明显拖慢上传与绘制）。
    const target = mobile ? 9000 : 21000;

    let GW = Math.round(Math.sqrt(target * aspect));
    let GH = Math.round(GW / aspect);
    GW = Math.min(220, Math.max(40, GW));
    GH = Math.min(220, Math.max(40, GH));

    const cv = document.createElement('canvas');
    cv.width = GW; cv.height = GH;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, GW, GH);
    const px = g.getImageData(0, 0, GW, GH).data;
    const n = GW * GH;

    // 亮度场 → 模糊成深度场
    const luma = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      luma[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
    }
    const blur = boxBlur(luma, GW, GH, Math.max(2, Math.round(GW / 14)));

    // 深度 = 平滑亮度（亮→近） + 中心先验；再归一化到 0..1
    const depth = new Float32Array(n);
    let dMin = Infinity, dMax = -Infinity;
    const cx = (GW - 1) / 2, cy = (GH - 1) / 2;
    const rr = Math.hypot(cx, cy) || 1;
    for (let i = 0; i < n; i++) {
      const x = i % GW, y = (i / GW) | 0;
      const rad = Math.hypot(x - cx, y - cy) / rr;
      const v = blur[i] * 0.78 + (1 - rad * rad) * 0.34;
      depth[i] = v;
      if (v < dMin) dMin = v;
      if (v > dMax) dMax = v;
    }
    const span = (dMax - dMin) || 1;

    // 世界尺寸：宽度固定 PLANE，高度按封面比例
    const wW = PLANE, wH = PLANE / aspect;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const seed = new Float32Array(n);
    const alpha = new Float32Array(n);

    // 参考图的点阵是严格等距网格，排列非常规整；抖动从 0.05 收到 0.02，
    // 只留一点点防摩尔纹，整体观感更接近"整齐的点阵屏"。
    const jx = (wW / GW) * 0.02, jy = (wH / GH) * 0.02;
    const spacing = wW / GW;

    /* 半调（halftone）映射：点的大小统一，明暗全靠 alpha 编码 ——
       暗部点几乎隐入镜头底，亮部点实，封面像报纸网版一样"显影"出来。 */
    for (let i = 0; i < n; i++) {
      const x = i % GW, y = (i / GW) | 0;
      const d = (depth[i] - dMin) / span;           // 0 远 → 1 近

      pos[i * 3]     = (x / (GW - 1) - 0.5) * wW + (Math.random() - 0.5) * jx;
      pos[i * 3 + 1] = -(y / (GH - 1) - 0.5) * wH + (Math.random() - 0.5) * jy;
      pos[i * 3 + 2] = (d - 0.5) * Z_SPAN;

      const r = px[i * 4] / 255, gg = px[i * 4 + 1] / 255, b = px[i * 4 + 2] / 255;
      col[i * 3] = r; col[i * 3 + 1] = gg; col[i * 3 + 2] = b;

      // 点径统一（细节交给密度与明暗）。
      // 网格回到 21000（格距更小）后，spacing*K 的绝对尺寸会随之变小，
      // 所以 K 从 0.05 微调到 0.06 做补偿 —— 单点绝对大小仍在最小量级，
      // 整体"点更密、更细"的细腻感来自网格而非点径。
      size[i] = spacing * 0.06 * (0.80 + Math.random() * 0.40);

      seed[i] = Math.random();
      // 亚像素点覆盖面积极小、整体会明显偏暗；
      // 基线抬到 0.92，避免画面糊成一片灰雾，保持颗粒可辨。
      alpha[i] = 0.92 + luma[i] * 0.08;
    }

    return { pos, col, size, seed, alpha, count: n, accent: pickAccent(px, n) };
  }

  function upload(data) {
    if (!gl) return;
    const n = data.count;
    const stride = 9;
    const inter = new Float32Array(n * stride);
    for (let i = 0; i < n; i++) {
      const o = i * stride;
      inter[o]     = data.pos[i * 3];
      inter[o + 1] = data.pos[i * 3 + 1];
      inter[o + 2] = data.pos[i * 3 + 2];
      inter[o + 3] = data.col[i * 3];
      inter[o + 4] = data.col[i * 3 + 1];
      inter[o + 5] = data.col[i * 3 + 2];
      inter[o + 6] = data.size[i];
      inter[o + 7] = data.seed[i];
      inter[o + 8] = data.alpha[i];
    }
    if (!vbo) vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, inter, gl.STATIC_DRAW);

    const S = stride * 4;
    const set = (loc, sz, off) => {
      if (loc === undefined || loc === null || loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, sz, gl.FLOAT, false, S, off * 4);
    };
    set(attrs.aPos, 3, 0);
    set(attrs.aColor, 3, 3);
    set(attrs.aSize, 1, 6);
    set(attrs.aSeed, 1, 7);
    set(attrs.aAlpha, 1, 8);
    count = n;
  }

  /* ══════════════ 初始化 ══════════════ */

  function initGL() {
    canvas = viewEl.querySelector('canvas');
    if (!canvas) { glFail = true; return false; }
    gl = canvas.getContext('webgl', {
      alpha: true, antialias: false, depth: false,
      premultipliedAlpha: false, powerPreference: 'high-performance',
    }) || canvas.getContext('experimental-webgl', { alpha: true, antialias: false, depth: false });

    if (!gl) { glFail = true; return false; }

    const vs = compile(gl.VERTEX_SHADER, VS);
    const fs = compile(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) { glFail = true; return false; }

    prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('[粒子视界] 程序链接失败：', gl.getProgramInfoLog(prog));
      glFail = true;
      return false;
    }
    gl.useProgram(prog);

    for (const k of ['aPos', 'aColor', 'aSize', 'aSeed', 'aAlpha']) {
      attrs[k] = gl.getAttribLocation(prog, k);
    }
    for (const k of ['uVP', 'uTime', 'uHover', 'uMouse', 'uSizeK', 'uSizeMul', 'uHalfY', 'uPass']) {
      uni[k] = gl.getUniformLocation(prog, k);
    }

    // 混合模式逐遍设置（见 frame()）：第一遍正常混合、第二遍加法混合
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);

    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); ctxLost = true; });
    canvas.addEventListener('webglcontextrestored', () => { ctxLost = false; count = 0; vbo = null; });
    return true;
  }

  function resize() {
    if (!gl || !viewEl) return;
    const r = viewEl.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    cw = Math.max(1, Math.round(w * dpr));
    ch = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw; canvas.height = ch;
    }
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    gl.viewport(0, 0, cw, ch);

    const viewAspect = w / h;
    const tanH = Math.tan(FOV / 2);
    // fitFloor：让封面"顶满"画面所需的相机距离（缩放中立点）。
    // 分别按宽、高两条约束算，取更远的那个——只按高度算的话，
    // 16:9 的封面在竖画布里会缩成中间一小块。
    const wW = PLANE, wH = PLANE / aspect;
    const dW = wW / (2 * tanH * viewAspect);
    const dH = wH / (2 * tanH);
    // 全屏沉浸式：不让封面贴着画框（那样四周的粒子会被裁掉，也没了呼吸感）。
    // 1.5 的余量让封面大致占画面高度的 ~58%，四周留出暗场，
    // 和 Mineradio 参考图里"粒子群浮在暗底中央"的构图一致。
    // 注意 SHOTS 里最近的 dolly 是 0.80，等效再把距离压到 1.5*0.8=1.2 倍，
    // 所以基准留 1.5 才能保证最贴近的机位也不裁到封面。
    const FIT = 1.5;
    // 再把 Z_SPAN/2 加上：最近的粒子在 z = +Z_SPAN/2，得让"最近的那层"也留在画内
    fitFloor = Math.max(dW, dH) * FIT + Z_SPAN * 0.5;
    cam.baseRadius = fitFloor / zoomApplied;   // 当前生效的相机基准距离
    // cam.radius 每帧由 baseRadius × dollySmooth 重算，这里同步一次，
    // 避免 resize 后到下一帧之间用旧值（视觉上会闪一下）。
    cam.radius = cam.baseRadius * dollySmooth;
    perspective(PROJ, FOV, viewAspect, NEAR, FAR);
    // gl_PointSize 是物理像素：世界单位 × (视口高 / 2tan(fov/2))
    sizeK = (ch / (2 * tanH));
    // 视口尺寸变了，粒子面投影宽也变 → 歌词断行必须重排。
    // 这里只是打标，真正的重排交给下一帧 frame()：那时新的 --lyr-w
    // 已经写好、字体也已按新视口重算，量出来才准。
    lastWrapW = -1;
  }

  /* ══════════════ 歌词"在前面"的深度 ══════════════

     需求：「歌词始终在粒子视界的前面，不管怎么转动视角歌词都是在前面」。

     .pView（粒子）z-index:1、.pLyr（歌词）z-index:2 —— 这一条保证了字
     永远**不会被粒子盖住**，任何视角都成立，是"在前面"的硬保证。

     在此之上再给 .pLyr 一个朝观察者方向的 translateZ，让它成为一块
     **离相机更近**的板子（perspective 在 .pStage 上）：近处平面被透视
     放大，于是字比粒子略大一圈，眼睛读到的就是"字浮在粒子前方"。

     ⚠ 深度值**不由 JS 写死**，而是在 style.css 里用 calc 从灭点反解：
           .pLyr { --lyr-z: calc(1200px * (1 - 1 / var(--lyr-s))) }   ← 正值
       理由是这样在任何视口 / 缩放下都保持同一个观感 —— 板子前移被透视
       放大的量（12%）正好被它自身布局宽的收窄抵消，两侧边始终与粒子面
       左右边界齐平，既看得出"在前面"又不会溢出封面。

     ⚠⚠ 符号：CSS 的 Z 轴正方向指向观察者。实测 translateZ(+120px) 把
       400px 的板子渲染成 444px，translateZ(−120px) 却缩到 364px ——
       要"在前面"必须写正、不能写负（写负等于把歌词推到粒子后面，
       与需求相反）。这条已用 verify_lyric_front.py 的 B/C 项锁住。

     ⚠⚠⚠ 曾经的另一半做法是**让歌词跟着相机一起 rotateY/rotateX**，假装
       它和封面同处一个空间。那条路和本需求直接冲突：板子转到 60° 就侧
       过去，字被透视压成窄带、还和粒子云搅在一起，看着反而"陷进"粒子里。
       现已废弃 —— 相机姿态不再参与歌词的 transform，particles.js 也不再
       写 --lyr-ry / --lyr-rx。歌词恒定正对镜头，怎么转视角都在前面。
       这条由 verify_lyric_front.py 的 E 项与 verify_lyric_in_plane.py 锁住。 */

  /* ══════════════ 渲染循环 ══════════════ */

  function frame(now) {
    raf = requestAnimationFrame(frame);

    const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 0.016);
    lastT = now;
    const t = (now - t0) / 1000;

    // ── 音频平滑：只喂歌词层，粒子的运动与音频完全无关
    const quiet = raw.level < 0.004 && raw.bass < 0.004 && raw.mid < 0.004 && raw.treble < 0.004;
    const iL = quiet ? 0.10 + Math.sin(t * 0.55) * 0.055 : 0;
    const iM = quiet ? 0.07 + Math.sin(t * 0.61 + 2.1) * 0.040 : 0;
    const iT = quiet ? 0.06 + Math.sin(t * 0.73 + 0.7) * 0.035 : 0;

    const k = 1 - Math.pow(0.0016, dt);
    const a = raw;
    sm.level  += (a.level  - sm.level)  * (a.level  > sm.level  ? k * 1.6 : k * 0.8);
    sm.mid    += (a.mid    - sm.mid)    * (a.mid    > sm.mid    ? k * 1.6 : k * 0.8);
    sm.treble += (a.treble - sm.treble) * (a.treble > sm.treble ? k * 1.7 : k * 0.8);

    const L = Math.max(sm.level, iL), M = Math.max(sm.mid, iM), T = Math.max(sm.treble, iT);

    // ── 节拍只剩一个用途：给当前歌词行做辉光，舞台本体不再响应
    if (a.beat > 0.5) burst = Math.min(1, burst + 0.62);
    burst *= Math.max(0, 1 - dt * 2.9);

    // 歌词层每帧都要更新（即使暂时没粒子），所以放在绘制之前
    driveLyrics(L, M, T, dt);

    if (!gl || ctxLost || !count) return;

    // ── 指针斥力
    const wantHover = ptr.inside && !drag ? 0.30 : 0;
    hover += (wantHover - hover) * Math.min(1, dt * 6);

    // ── 相机：镜头导演的长镜头 + 手持微晃 + 指针视差 + 拖拽 + 滚轮缩放
    // 停手一段时间后缓慢归位到 1，避免一直停在过度放大的状态
    if (ZOOM_IDLE_MS > 0 && drag == null && zoomFactor !== 1 &&
        performance.now() - zoomAt > ZOOM_IDLE_MS) {
      zoomFactor += (1 - zoomFactor) * Math.min(1, dt * 0.5);
      if (Math.abs(zoomFactor - 1) < 0.004) zoomFactor = 1;
      if (root) root.style.setProperty('--zoom', zoomFactor.toFixed(3));
    }
    // 缩放尺度先平滑（让滚轮跳变变柔和），再除到 fitFloor 上得到真实基准距离。
    // 除而不是乘：radius 越大视角越远、画面越小，放大 = 缩小半径。
    zoomApplied += (zoomFactor - zoomApplied) * Math.min(1, dt * 5.5);
    cam.baseRadius = fitFloor / zoomApplied;
    /* 歌词**不跟随相机旋转**（见 style.css 的 .pLyr 注释）。
       需求是「不管怎么转动视角歌词都是在前面」—— 板子若跟着 yaw/pitch 转，
       大角度时会侧过去、字被压成窄带并陷进粒子云，与需求正好相反。
       所以 --lyr-ry / --lyr-rx 已废弃，这里只剩唯一仍然依赖相机的量：
       入场方向 --lyr-in。 */
    if (root) {
      const kp = Math.round(cam.pitch * 57.29578 * 100) / 100;

      /* 入场滑动方向必须与"粒子面此刻在屏幕上往哪走"一致。
         ⚠ 这里用的是俯仰的**变化量**，不是符号 —— 这是关键，踩过坑：
           直觉上容易以为"俯仰为正 = 从下仰视 = 从下方滑入"，但用真实
           投影算过（见 gui-test-screenshots/_proj.py）：俯仰由 -16° 一路
           增大到 +16°，封面顶部点的 NDC.y 单调**变大** —— 也就是无论
           俯仰正负，只要俯仰在**增大**，粒子面就在屏幕上一路**上移**。
           所以真正决定"往哪走"的是 dp = 本帧俯仰 − 上帧俯仰：
             dp > 0（俯仰变大）→ 面在上移 → 歌词也从下方滑入 = fadeInUp
             dp < 0（俯仰变小）→ 面在下移 → 歌词也从上方滑入 = fadeInDown
           阈值 0.05° 是抗抖：相机停稳后 kp 会有极小余摆，不设阈值会反复翻转。 */
      if (lastLyrPitch === null) lastLyrPitch = kp;
      const dp = kp - lastLyrPitch;
      if (Math.abs(dp) >= 0.05) {
        lastLyrPitch = kp;
        const dir = dp > 0 ? 'fadeInUp' : 'fadeInDown';
        if (dir !== lastLyrIn) {
          lastLyrIn = dir;
          root.style.setProperty('--lyr-in', dir);
        }
      }
    }

    /* 歌词可用宽度 = 封面粒子面的"基准投影宽"（zoom = 1 时）。
       推导：sizeK 是"1 世界单位在 z=0 处占多少物理像素"（sizeK = ch/(2tanH)），
       而 z=0 平面到相机的距离就是 cam.radius，故
         投影宽(物理px) = PLANE * sizeK / cam.radius
       CSS 层是逻辑像素，再除以 dpr。

       ⚠ 必须用 fitFloor（缩放 1 的基准距离），不能用 cam.radius：
       因为缩放由 CSS transform: scale(var(--lyr-zoom)) 负责，
       而 --lyr-zoom 现在是 --zoom-live 的 1:1 原值。
       若这里还用 cam.radius，缩放就被算了两遍 —— 放大 2.6 倍时
       宽度先缩到 1/2.6、再被 scale 放大 2.6 倍，一来一回看似"没变"，
       但断行是按缩小后的宽度算的，字会提前折行、白白多出好几行。
       用 fitFloor 则：宽度锁在基准尺寸 → 断行稳定 → scale 负责跟随相机，
       与粒子面的投影变化严格同步。 */
    if (root) {
      const planeW = PLANE * sizeK / Math.max(0.001, fitFloor) / dpr;
      // 0.94：留一点点内边距让四周露出粒子（参考图里就是这样），
      // 但不要留太多 —— 粒子面在全屏构图里本来就只占画面一部分，
      // 再打 0.86 的折，可用宽只剩 400px 出头，一句正常长度的中文
      // 会被迫叠成 4~5 行，字挤成小方块。
      const lw = Math.max(180, Math.round(planeW * 0.94));
      if (lw !== lastLyrW) {
        lastLyrW = lw;
        lyrBudgetW = lw;
        root.style.setProperty('--lyr-w', lw + 'px');
        // 宽度变了要重排断行。relayoutLyrics 内部有 6px 门限，
        // 所以滚轮连续缩放不会每帧都重建 DOM。
        relayoutLyrics(false);
      }
    }

    const shot = shotNow(now);
    const swayY = Math.sin(t * 0.23) * 0.012 + Math.sin(t * 0.31 + 1.7) * 0.008;
    const swayP = Math.cos(t * 0.19) * 0.009;
    const parY = (ptr.sx - 0.5) * 0.20;
    const parP = (ptr.sy - 0.5) * 0.13;
    cam.yaw += ((shot.yaw + swayY + parY + cam.dragYaw) - cam.yaw) * Math.min(1, dt * 2.6);
    cam.pitch += ((shot.pitch + swayP + parP + cam.dragPitch) - cam.pitch) * Math.min(1, dt * 2.6);
    // 镜头推拉（dolly）与呼吸单独平滑，之后与 baseRadius 相乘得到真实距离。
    // 这样 cam.radius 只在"镜头切机位"时慢，用户缩放时是跟手的一级平滑。
    const dollyBreath = shot.dolly * (1 + 0.02 * Math.sin(t * 0.09));
    dollySmooth += (dollyBreath - dollySmooth) * Math.min(1, dt * 1.8);
    cam.radius = cam.baseRadius * dollySmooth;

    /* 歌词同步缩放：直接读"粒子此刻真实呈现的缩放比"。

       ⚠ 修复前的两个不同步来源（用户报的 bug）：
       (1) 歌词读中间的 zoomApplied，而粒子读 cam.radius，二者差着一级
           dt*1.8 的平滑 —— 滚轮一拨，粒子还在慢慢跟上、歌词却先动了；
       (2) CSS 上还叠了一层 .38s transition，等于反向再加一级滞后。

       现在直接把粒子的真实缩放比抄给歌词：
           live = fitFloor / cam.radius × dollySmooth
       稳态下 cam.radius = baseRadius × dollySmooth，baseRadius = fitFloor/zoomApplied，
       代入展开：
           fitFloor / (fitFloor/zoomApplied × dollySmooth) × dollySmooth
         = zoomApplied
       即 live → zoomApplied，与 HUD / zoomFactor 同义（100% 就是 1.0，
       双击复位能回到 1），同时完整继承 cam.radius 的每一丝动态 ——
       粒子此刻画多大，歌词就按同一比例缩放，严格同帧同步。

       乘 dollySmooth 是"除掉镜头语言"的正确做法：不能写成除以
       cam.radius 里的 dolly（那是除两次，live 会变成 1/dolly²，
       实测双击只能回到 0.689）。 */
    if (root) {
      const live = fitFloor / Math.max(0.001, cam.radius) * dollySmooth;
      const lz = Math.round(live * 1000) / 1000;
      if (lz !== lastLyricZoom) {
        lastLyricZoom = lz;
        root.style.setProperty('--zoom-live', lz.toFixed(3));
      }
    }

    const cy = Math.cos(cam.pitch), sy = Math.sin(cam.pitch);
    const ex = Math.sin(cam.yaw) * cam.radius * cy;
    const ey = sy * cam.radius;
    const ez = Math.cos(cam.yaw) * cam.radius * cy;

    lookAt(VIEW, ex, ey, ez, 0, 0, 0, 0, 1, 0);
    mul(VP, PROJ, VIEW);

    // ── 指针 → 世界坐标（与 z=0 平面求交，作为斥力中心）
    const tanH = Math.tan(FOV / 2);
    const fx = -Math.sin(cam.yaw) * cy, fy = -sy, fz = -Math.cos(cam.yaw) * cy;
    const rx = Math.cos(cam.yaw), ry = 0, rz = -Math.sin(cam.yaw);
    const upx = ry * fz - rz * fy, upy = rz * fx - rx * fz, upz = rx * fy - ry * fx;
    const nx = (ptr.sx * 2 - 1) * tanH * (cw / ch), ny = (1 - ptr.sy * 2) * tanH;
    let dx = fx + rx * nx + upx * ny;
    let dy = fy + ry * nx + upy * ny;
    let dz = fz + rz * nx + upz * ny;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    const tHit = Math.abs(dz) < 1e-4 ? 0 : -ez / dz;
    const mwx = tHit > 0 ? ex + dx * tHit : 0;
    const mwy = tHit > 0 ? ey + dy * tHit : 0;

    // ── 上屏
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog);
    gl.uniformMatrix4fv(uni.uVP, false, VP);
    gl.uniform1f(uni.uTime, t);
    gl.uniform1f(uni.uHover, hover);
    gl.uniform2f(uni.uMouse, mwx, mwy);
    gl.uniform1f(uni.uSizeK, sizeK);
    gl.uniform1f(uni.uHalfY, 1.0 / aspect);   // 波纹环要按封面比例归一化

    /* 两遍画同一批点：
       第一遍正常混合 —— vColor 就是最终颜色，不叠不累加，封面本体永远
         不会过曝，颜色忠实于原图；这是"认得出封面"的保证。
       第二遍加法混合 —— 同一批点、同尺寸（1.0）、强度压到 0.028，
         只提供极微的莹润感。参考 Mineradio 是无光晕的实心点阵，
         所以这遍不再放大（旧版 1.18 会让点缘外扩、密集区发糊）。 */
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(uni.uPass, 0.0);
    gl.uniform1f(uni.uSizeMul, 1.0);
    gl.drawArrays(gl.POINTS, 0, count);

    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.uniform1f(uni.uPass, 1.0);
    gl.uniform1f(uni.uSizeMul, 1.0);
    gl.drawArrays(gl.POINTS, 0, count);
  }

  /* ══════════════ 歌词层：按旋律起伏做特效 ══════════════ */

  /* ── 歌词断行：让一句长词在粒子范围内往下叠成多行 ──────────
     需求原文：「歌词的大小必须在粒子效果里面，不能超出他的范围，
              字太多可以往下叠」。
     做法不是 CSS 里写死宽度让浏览器自由换行 —— 那样每行断点不可控
     （可能把英文单词劈开、也可能留下一个孤字），而且折行后字号/行数
     会反过来影响垂直占位。这里手动测量：用 canvas 2d 的 measureText
     量当前字号下每个字的宽度，贪心累加到 --lyr-w（留一点内边距）就断。
     这样断点、行数都在我们手里，也便于后续按行数收敛字号。 */

  let measureCtx = null;
  /* 取"基准字号"用于测量断行。
     ⚠ 必须用 --p-lyr-base，不能用 getComputedStyle 的 fontSize ——
     后者现在是 calc(base × --lyr-zoom)，会随滚轮缩放变化，
     拿它去和固定的 --lyr-w 比较，就会"放大后字变宽、于是提前折行"，
     行数在缩放中乱跳。断行只跟基准字号有关（因为缩放由 font-size 承担，
     布局宽 = 基准宽 × zoom，但 --lyr-w 也是按基准给的，两者同倍率，
     比值恒定 → 断点必须用基准字号算才稳定）。 */
  function getFontFor(el) {
    const cs = getComputedStyle(el);
    // --p-lyr-base 可能是 clamp() 表达式，取它的解析值需要绕一下：
    // 先临时把 --lyr-zoom 当 1 读 fontSize 不现实（会触发重排），
    // 而是直接把当前 fontSize 除以当前 --lyr-zoom 反推出基准。
    const zoom = parseFloat(cs.getPropertyValue('--lyr-zoom')) || 1;
    const cur = parseFloat(cs.fontSize) || 40;
    const basePx = cur / Math.max(0.01, zoom);
    return (cs.fontWeight || '600') + ' ' + basePx.toFixed(2) + 'px ' + (cs.fontFamily || 'sans-serif');
  }
  function textWidth(str, font) {
    if (!measureCtx) {
      measureCtx = document.createElement('canvas').getContext('2d');
    }
    measureCtx.font = font;
    return measureCtx.measureText(str).width;
  }

  /* 把一段歌词按 maxW 像素断成若干行。
     逐字符贪心累加：遇到放不下的字符就换行。
     英文/数字按"喂单词"处理 —— 用正则切成 [英文单词] 与 [单字] 两类，
     避免把 "together" 劈成 "toget"/"her"。 */
  function wrapText(text, maxW, font) {
    if (!text) return [''];
    const tokens = text.match(/[A-Za-z0-9'’]+|\s+|./g) || [text];
    const lines = [];
    let cur = '';
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      // 行首不留空格（折行后前导空格会被视觉吃掉，还会把行尾顶歪）
      if (!cur && /^\s+$/.test(tk)) continue;
      const probe = cur + tk;
      // 单字就超宽时（avail 极小 / 字号极大）也必须独占一行，
      // 否则会无限循环或整句消失。cur 非空时才允许断。
      if (cur && textWidth(probe, font) > maxW) {
        lines.push(cur.replace(/\s+$/, ''));
        cur = /^\s+$/.test(tk) ? '' : tk;
      } else {
        cur = probe;
      }
    }
    if (cur.trim()) lines.push(cur.replace(/\s+$/, ''));
    if (!lines.length) lines.push(text);
    return lines;
  }

  /* 让一句歌词在 maxW 宽度内、最多 maxRows 行装下：
     从基准字号开始，一行放不下就往下降 2%，直到行数 <= maxRows 或触底。
     为什么要收敛字号而不只是"一直往下叠"：粒子面在 zoom=1 时投影宽
     只有 400~500px（全屏沉浸式构图里封面本身就占得不宽），一句 20 字的
     中文按 68px 字号会叠成 6~7 行，远超画面高度、完全不是"歌词"了。
     收敛到最多 3 行，字会小一些但成句可读，也仍稳稳在粒子范围内。
     返回 { rows, size }：size 是最终字号（px），写回元素 inline style。 */
  function fitFont(text, maxW, baseFont, basePx, maxRows) {
    let px = basePx;
    let rows = wrapText(text, maxW, baseFont.replace(/[\d.]+px/, px + 'px'));
    let guard = 0;
    while (rows.length > maxRows && px > 16 && guard++ < 80) {
      px *= 0.96;
      rows = wrapText(text, maxW, baseFont.replace(/[\d.]+px/, px + 'px'));
    }
    return { rows, size: px };
  }

  /* 重排所有有词的行。宽度取自 --lyr-w（粒子面投影宽），
     字号取该行 computed style（不同行字号不同：active / next / 移动端）。
     只在宽度变化超过 6px 时重排 —— 滚轮缩放会持续改 --lyr-w，
     每次都重排 DOM 会明显掉帧；6px 的粒度肉眼看不出来。
     传 force=true 时无视门限，用于字号切换（is-active / is-next）与视口变化。 */
  function relayoutLyrics(force) {
    if (!lyrBody) return;
    // lyrBudgetW 由 frame() 每帧从相机距离算出；首帧前还没写过，
    // 退一步直接量容器宽度，保证歌词一出现就是已断行的状态，
    // 不会先闪一下"整句撑破"再折行。
    const budget = lyrBudgetW || (lyrBody.clientWidth || 0);
    if (!budget) return;
    // lastWrapW === -1 是「强制重排」的哨兵（resize / buildLyricDom 会置位）
    if (!force && lastWrapW !== -1 && Math.abs(budget - lastWrapW) < 6) return;
    lastWrapW = budget;

    // 内边距：CSS 里 .pLyr-line 有 18px 左右 padding，断行宽度要扣掉
    const pad = window.innerWidth <= 800 ? 20 : 36;
    const avail = Math.max(120, budget - pad);
    // 每句最多叠几行。3 行足以容纳常见长短句，再多就不是"歌词"而是段落了。
    const MAX_ROWS = 3;

    for (let i = 0; i < lineEls.length; i++) {
      const el = lineEls[i];
      const L = lyricLines[i];
      if (!el || !L || !L.text) continue;
      // ⚠ 必须先清掉上一轮写在 inline 上的收敛值，否则量到的是上一轮的
      // 结果，每轮再收敛一次 → 字号无限变小。
      el.style.removeProperty('--p-lyr-base');
      const font = getFontFor(el);
      const basePx = parseFloat(font.match(/([\d.]+)px/)?.[1] || '40');
      // 先按基准字号试断，超行数则收敛字号
      const fit = fitFont(L.text, avail, font, basePx, MAX_ROWS);
      const rows = fit.rows;
      // 收敛后的**基准**字号写进 --p-lyr-base（而不是 font-size）：
      // CSS 里的 font-size: calc(var(--p-lyr-base) × var(--lyr-zoom))
      // 会自动把滚轮缩放乘上去，两者职责分明 —— JS 管"装不装得下"，
      // CSS 管"跟随缩放"。若这里直接写 font-size，会盖掉 CSS 的 calc，
      // 滚轮缩放就失效了。
      const sizeCss = fit.size.toFixed(2);
      // 缓存键 = 文本 + 可用宽 + 字体 + 最终基准字号。任一变了才重建 DOM，
      // 否则每帧重排会把逐字波浪动画（inline style 的 --i）反复重置，
      // 视觉上就是"字一直在抖"。
      const key = L.text + '|' + avail + '|' + font + '|' + sizeCss;
      if (el.__key === key) continue;
      el.__key = key;

      el.style.setProperty('--p-lyr-base', sizeCss + 'px');

      // 重建：每行一个 .pLyr-row > 若干 .pLyr-w（逐字 span 保留波浪动画）
      el.innerHTML = '';
      // --i 跨行连续编号，让波浪波峰从上一行末自然流到下一行首
      let off = 0;
      for (let r = 0; r < rows.length; r++) {
        const row = document.createElement('div');
        row.className = 'pLyr-row';
        const s = rows[r];
        for (let c = 0; c < s.length; c++) {
          const sp = document.createElement('span');
          sp.className = 'pLyr-w';
          sp.style.setProperty('--i', off + c);
          sp.textContent = s[c];
          row.appendChild(sp);
        }
        off += s.length;
        el.appendChild(row);
      }
    }
  }

  function buildLyricDom() {
    if (!lyrBody) return;
    // 提示语节点在 pLyrBody 里，重建歌词时把它摘出来再放回去，别被 innerHTML 抹掉
    const hint = hintEl;
    lyrBody.innerHTML = '';
    if (hint) {
      hint.hidden = lyricLines.length > 0;
      lyrBody.appendChild(hint);
    }
    lineEls = [];
    for (let i = 0; i < lyricLines.length; i++) {
      const L = lyricLines[i];
      const div = document.createElement('div');
      div.className = 'pLyr-line' + (L.text ? '' : ' pLyr-line--gap');
      div.style.setProperty('--d', Math.min(i, 16));
      if (!L.text) {
        div.textContent = '· · ·';
      } else {
        // 先塞进一个临时行，让它进 DOM 拿到真实 computed 字号，
        // 之后 relayoutLyrics 才量得准（active / next 字号不同）。
        // 此处用最朴素的单行结构，重排会在宽度确定后立即替换成多行。
        const row = document.createElement('div');
        row.className = 'pLyr-row';
        const frag = document.createDocumentFragment();
        for (let c = 0; c < L.text.length; c++) {
          const ch = L.text[c];
          const sp = document.createElement('span');
          sp.className = 'pLyr-w';
          sp.style.setProperty('--i', c);
          sp.textContent = ch;
          frag.appendChild(sp);
        }
        row.appendChild(frag);
        div.appendChild(row);
      }
      lyrBody.appendChild(div);
      lineEls.push(div);
    }
    // DOM 就绪后再按当前宽度断一次行。此时字号可量（元素已入文档），
    // 若 --lyr-w 尚未由 frame() 写过（首帧前），relayoutLyrics 会早退，
    // 由 frame() 里的宽度更新触发首排。
    lastWrapW = -1;
    relayoutLyrics(true);
  }
  function driveLyrics(L, M, T, dt) {
    if (root) {
      // 舞台氛围与旋律解耦：不再随节拍闪光，背景柔光改成时间驱动的慢呼吸
      root.style.setProperty('--p-level', (0.30 + 0.14 * Math.sin(performance.now() / 1000 * 0.42)).toFixed(3));
    }
    const act = lineEls[activeIdx];
    if (!act) return;
    // 全屏大字：振幅随字号放大（用视口高度做基准），否则字太大时浪感被淹没
    const sizeK = Math.max(1, Math.min(2.2, innerHeight / 900));
    // 振幅 = 旋律能量：唱到高潮时字跳得高，间奏时几乎不动
    const amp = ((0.9 + L * 12.5 + M * 5.5) * sizeK).toFixed(2);
    // 波速跟着亮度走，快歌更急促
    const dur = (1.34 - T * 0.5).toFixed(2);

    act.style.setProperty('--amp', amp + 'px');
    act.style.setProperty('--dur', dur + 's');
    // 注意：--glow 是全局的颜色 token（@property <color>），不能拿它装数字，
    // 否则 calc(px + var(--glow)*px) 会整条失效。歌词的辉光强度另开一个数值变量。
    act.style.setProperty('--glowK', (0.30 + L * 1.5 + burst * 0.6).toFixed(3));
    act.style.setProperty('--pop', (1 + L * 0.05 + burst * 0.028).toFixed(4));
  }

  /* ══════════════ 封面加载 ══════════════ */

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('封面加载失败'));
      img.src = src;
    });
  }

  async function setCover(src, opts) {
    opts = opts || {};
    // 标题/副标题每次都刷；封面图本身按 URL 去重，避免重复上传 GPU 缓冲
    if (titleEl) titleEl.textContent = opts.title || '';
    if (subEl) subEl.textContent = opts.sub || '';
    if (!src) return;
    if (src === lastCoverKey) return;
    lastCoverKey = src;
    const token = ++buildToken;

    if (badgeEl) badgeEl.textContent = '封面分析中…';
    if (root) root.classList.remove('is-ready');
    if (viewEl) {
      viewEl.classList.remove('is-static');
      viewEl.style.backgroundImage = '';
    }

    let img;
    try {
      img = await loadImage(src);
    } catch {
      if (token === buildToken && badgeEl) badgeEl.textContent = '封面加载失败';
      return;
    }
    if (token !== buildToken) return;

    if (glFail || !gl) {
      // 没有 WebGL：退化成一张静态封面，视图仍然可用
      if (badgeEl) badgeEl.textContent = '浏览器不支持 WebGL，已退回静态封面';
      if (viewEl) {
        viewEl.classList.add('is-static');
        viewEl.style.backgroundImage = `url("${src}")`;
      }
      if (root) root.classList.add('is-ready');
      return;
    }

    const data = buildGaussians(img);
    if (token !== buildToken) return;
    upload(data);
    resize();                     // 拿到真实封面比例后重算相机距离，保证整张图装得下
    if (data.accent && root) root.style.setProperty('--p-accent', data.accent);
    if (badgeEl) badgeEl.textContent = `${data.count.toLocaleString('en-US')} 颗高斯 · 电影粒子舞台`;
    if (root) root.classList.add('is-ready');
  }

  /* ══════════════ 指针交互 ══════════════ */

  function bindPointer() {
    const el = canvas || viewEl;

    const pos = e => {
      const r = el.getBoundingClientRect();
      ptr.sx = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
      ptr.sy = Math.min(1, Math.max(0, (e.clientY - r.top) / Math.max(1, r.height)));
    };

    el.addEventListener('pointermove', e => {
      pos(e);
      ptr.inside = true;
      if (!drag) return;
      // 拖拽 = 手动环绕，松手后自动回到缓慢巡航
      cam.dragYaw = Math.min(1.05, Math.max(-1.05, drag.yaw0 + (e.clientX - drag.x0) * 0.0052));
      cam.dragPitch = Math.min(0.5, Math.max(-0.5, drag.pitch0 + (e.clientY - drag.y0) * 0.0038));
    });

    el.addEventListener('pointerleave', () => { ptr.inside = false; });

    el.addEventListener('pointerdown', e => {
      pos(e);
      drag = { x0: e.clientX, y0: e.clientY, yaw0: cam.dragYaw, pitch0: cam.dragPitch };
      el.setPointerCapture(e.pointerId);
      el.classList.add('is-drag');
    });

    const end = e => {
      if (!drag) return;
      drag = null;
      el.classList.remove('is-drag');
      try { el.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    // 双击复位视角（含缩放）
    el.addEventListener('dblclick', () => {
      cam.dragYaw = 0; cam.dragPitch = 0;
      zoomFactor = 1; zoomAt = performance.now(); zoomHud();
    });

    /* 滚轮缩放。
       注意：这里必须非 passive —— 视界是全屏覆盖层，若让滚轮穿透下去，
       底下的歌单页会跟着一起滚，画面会"双层漂移"。
       连续滚动时滚轮事件来得很密，用 zoomAt 记录停手时刻，
       便于超时后自动归位。 */
    el.addEventListener('wheel', e => {
      // 触控板双指横扫（横向分量更大）不当作缩放，避免误触
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      e.preventDefault();
      // deltaMode：0=像素 1=行(~16px) 2=页(~100px)，统一归一到像素量级
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      const dy = e.deltaY * unit;
      // 指数曲线：不论当前远近，手感增量一致；clamp 防住个别浏览器的超大 delta
      const next = zoomFactor * Math.exp(-dy * 0.00115);
      zoomFactor = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
      zoomAt = performance.now();
      zoomHud();
    }, { passive: false });
  }

  /* ══════════════ 对外 API ══════════════ */

  function init() {
    if (inited) return;
    root = document.getElementById('pStage');
    if (!root) return;
    viewEl = document.getElementById('pView');
    lyrBody = document.getElementById('pLyrBody');
    titleEl = document.getElementById('pTitle');
    subEl = document.getElementById('pSub');
    badgeEl = document.getElementById('pBadge');
    hintEl = document.getElementById('pLyrHint');
    zoomValEl = document.getElementById('pZoomVal');

    initGL();
    if (!glFail) bindPointer();

    if (window.ResizeObserver && viewEl) {
      new ResizeObserver(resize).observe(viewEl);
    }
    addEventListener('resize', resize);
    inited = true;
  }

  function open(opts) {
    init();
    if (!root) return;
    opened = true;
    t0 = performance.now();
    lastT = 0;
    shotA = shotB = SHOTS[0];       // 每次进视界都从正面全景开始
    shotAt = performance.now();
    cam.dragYaw = 0; cam.dragPitch = 0;
    // 缩放也回到中立位；首次进入时先演示一下"它在缩"，让人意识到能滚
    zoomFactor = 1; zoomApplied = 1; zoomAt = performance.now();
    dollySmooth = 1;      // 镜头推拉平滑也复位，首帧不会带着上次的 dolly
    if (root) root.style.setProperty('--zoom', '1');
    lastLyricZoom = -1;   // 让下一帧无条件把 --zoom-live 写回 1
    lastLyrIn = null;     // 入场方向也重置，首帧重新按俯仰变化定一次
    lastLyrPitch = null;  // 俯仰基准也清掉，避免拿上一次会话的旧值算 delta
    lastLyrW = -1;        // 宽度也重置：下一次 frame() 必然重写并触发重排
    lastWrapW = -1;
    lyrBudgetW = 0;
    if (zoomShowOnce) {
      zoomShowOnce = false;
      zoomFactor = 1.28;
      setTimeout(() => { zoomFactor = 1; zoomAt = performance.now(); zoomHud(); }, 1250);
    }
    root.classList.add('is-open');
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('particle-open');
    resize();
    if (!raf) raf = requestAnimationFrame(frame);
    if (opts && opts.cover) setCover(opts.cover, opts);
  }

  function close() {
    if (!root) return;
    opened = false;
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('particle-open');
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    ptr.inside = false;
    drag = null;
  }

  return {
    init,
    open,
    close,
    isOpen: () => opened,
    setCover,
    resize,
    /** 每帧由 app.js 推入原始音频特征（0..1） */
    setAudio(f) { raw.level = f.level; raw.bass = f.bass; raw.mid = f.mid; raw.treble = f.treble; raw.beat = f.beat; },
    /** 歌词数组：[{ t, text }]，text 为空表示间奏 */
    setLyrics(lines) {
      lyricLines = lines || [];
      activeIdx = -1;
      if (hintEl) hintEl.hidden = lyricLines.length > 0;
      buildLyricDom();
    },
    setActive(i) {
      if (i === activeIdx || !lineEls.length) return;
      // 屏幕上只留两句：当前正在唱的（is-active）+ 紧接着要唱的（is-next）。
      // 其余行 .is-shown 摘掉后会 display:none 退出布局 —— 歌词不再一次全铺出来，
      // 而是唱到哪句出哪句；也让当前句永远稳稳居中。
      const prev = lineEls[activeIdx];
      if (prev) prev.classList.remove('is-active');
      if (lineEls[activeIdx + 1]) lineEls[activeIdx + 1].classList.remove('is-next');
      activeIdx = i;
      const cur = lineEls[activeIdx];
      if (!cur) return;

      // 找下一句有词的（跳过间奏占位），当成预告
      let n = activeIdx + 1;
      while (n < lineEls.length && !lyricLines[n].text) n++;
      const nextEl = lineEls[n];

      for (let k = 0; k < lineEls.length; k++) {
        lineEls[k].classList.toggle('is-shown', k === activeIdx || k === n);
      }
      // 先挂 is-next 再挂 is-active，让「上一句的预告」和「这句转正」同帧完成
      if (nextEl) nextEl.classList.add('is-next');
      cur.classList.add('is-active');

      // 关键：is-active / is-next 的字号与 is-shown 的默认字号不同，
      // 切换后必须按新的 computed 字号重新断行，否则长句会按旧字号断、
      // 转正后溢出粒子范围（或反过来留一大截空白）。
      relayoutLyrics(true);
    },
    /** 封面主题色，供玻璃与歌词染色 */
    setAccent(color) { if (root && color) root.style.setProperty('--p-accent', color); },
    /** 通知视图：当前没有可分析的音频（例如纯音景） */
    setIdle() { raw.level = raw.bass = raw.mid = raw.treble = raw.beat = 0; },
    /** 滚轮缩放：直接设缩放倍率（1 = 正好装下整张封面，>1 放大，<1 缩小） */
    setZoom(z) {
      zoomFactor = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +z || 1));
      zoomAt = performance.now();
      zoomHud();
    },
    zoom: () => zoomFactor,
  };
})();

window.ParticleStage = ParticleStage;
