// 布料物理模拟：Verlet 积分 + 质点-弹簧网格 + 风力 + 法线光照
// 抓住卡片时，把卡片快照贴到布面上，风从侧面吹出真实的褶皱阴影
(function () {
  'use strict';

  const COLS = 36;
  const ROWS = 26;
  const DAMPING = 0.985;
  const GRAVITY = 0.05;
  const WIND_X = 0.011;   // 水平摆动力
  const WIND_Z = 0.030;   // 竖向褶皱波力
  const Z_DAMP = 0.985;   // z 回弹阻尼
  const ITERATIONS = 4;
  const DRAG_DECAY = 0.90;   // 拖动速度/加速度每帧衰减
  const DRAG_INERTIA = 0.45; // 拖动加速度 -> 惯性反推力系数
  const SPEED_FLUTTER = 0.20; // 拖动速度对风力的增益（速度越快越飘）
  const Z_MAX = 10;           // 褶皱深度上限（配合边界软墙，防止投影超出窗口）
  // 窗口四周已有 14px 透明边距，布料网格直接完整覆盖卡片，不内缩
  const MARGIN = 0;

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // 三角形仿射贴图：任意 3D 投影下的三角形都能被仿射变换精确映射，
  // 相邻三角形共享完整边，不会出现四边形映射产生的缝隙
  function drawTri(ctx, tex, dpr, P, Q, R, uP, vP, uQ, vQ, uR, vR) {
    // 三角形中心外扩 0.5 设备像素，消除光栅化的发丝缝隙
    const cxs = (P.x + Q.x + R.x) / 3;
    const cys = (P.y + Q.y + R.y) / 3;
    const out = (p) => {
      const dx = p.x - cxs;
      const dy = p.y - cys;
      const l = Math.hypot(dx, dy) || 1;
      const ox = 0.5 / dpr;
      return { x: (p.x + (dx / l) * ox) * dpr, y: (p.y + (dy / l) * ox) * dpr };
    };
    const A = out(P), B = out(Q), C = out(R);

    const sx1 = uQ - uP, sy1 = vQ - vP;
    const sx2 = uR - uP, sy2 = vR - vP;
    const dx1 = B.x - A.x, dy1 = B.y - A.y;
    const dx2 = C.x - A.x, dy2 = C.y - A.y;
    const det = sx1 * sy2 - sx2 * sy1 || 1e-6;
    const a = (dx1 * sy2 - dx2 * sy1) / det;
    const c = (sx1 * dx2 - sx2 * dx1) / det;
    const b = (dy1 * sy2 - dy2 * sy1) / det;
    const d = (sx1 * dy2 - sx2 * dy1) / det;
    const e = A.x - a * uP - c * vP;
    const f = A.y - b * uP - d * vP;
    const sw = uQ - uP;
    const sh = vR - vP;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    ctx.lineTo(B.x, B.y);
    ctx.lineTo(C.x, C.y);
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(a, b, c, d, e, f);
    ctx.drawImage(tex, uP, vP, sw, sh, uP, vP, sw, sh);
    ctx.restore();
  }

  class Cloth {
    constructor(w, h, opts) {
      this.w = w;
      this.h = h;
      // 边界软墙：布料最多飘到窗口透明边距边缘（预留 z 投影余量）
      this.wallL = opts && opts.wallL !== undefined ? opts.wallL : -11;
      this.wallR = opts && opts.wallR !== undefined ? opts.wallR : w + 11;
      this.wallT = opts && opts.wallT !== undefined ? opts.wallT : -12;
      this.wallB = opts && opts.wallB !== undefined ? opts.wallB : h + 12;
      this.margin = MARGIN;
      this.cols = COLS;
      this.rows = ROWS;
      const spX = w / (COLS - 1);
      const spY = h / (ROWS - 1);
      const idx = (r, c) => r * COLS + c;
      this.pts = [];
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          this.pts.push({
            x: c * spX,
            y: r * spY,
            z: 0,
            px: c * spX,
            py: r * spY,
            pz: 0,
            pinned: r === 0, // 顶部固定：像窗帘挂在杆上
          });
        }
      }
      this.constraints = [];
      const add = (a, b, rest) => this.constraints.push({ a, b, rest });
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (c < COLS - 1) add(idx(r, c), idx(r, c + 1), spX);                 // 结构
          if (r < ROWS - 1) add(idx(r, c), idx(r + 1, c), spY);                 // 结构
          if (r < ROWS - 1 && c < COLS - 1) add(idx(r, c), idx(r + 1, c + 1), Math.hypot(spX, spY)); // 剪切
          if (r < ROWS - 1 && c > 0) add(idx(r, c), idx(r + 1, c - 1), Math.hypot(spX, spY));        // 剪切
          if (c < COLS - 2) add(idx(r, c), idx(r, c + 2), spX * 2);             // 弯曲
          if (r < ROWS - 2) add(idx(r, c), idx(r + 2, c), spY * 2);             // 弯曲
        }
      }
    }

    update(t) {
      // 阵风：水平摆动 + 沿布面纵横两个方向的起伏；拖动越快，风越强
      const speed = Math.hypot(dragVX, dragVY);
      const flutter = 1 + Math.min(0.5, speed * SPEED_FLUTTER);
      const gust = 1 + 0.3 * Math.sin(t * 0.0009);
      const windX = (Math.sin(t * 0.0024) * 2.1 + Math.sin(t * 0.0012) * 1.0) * gust * flutter;
      // 惯性耦合：拖动加速时布料滞后、减速/停止时前甩，方向与加速度相反
      const inertiaX = -dragAX * DRAG_INERTIA * 16.7;
      const inertiaY = -dragAY * DRAG_INERTIA * 16.7;
      dragVX *= DRAG_DECAY;
      dragVY *= DRAG_DECAY;
      dragAX *= DRAG_DECAY;
      dragAY *= DRAG_DECAY;
      const h = this.h;
      for (const p of this.pts) {
        if (p.pinned) {
          p.px = p.x; p.py = p.y; p.pz = p.z;
          continue;
        }
        const vx = (p.x - p.px) * DAMPING;
        const vy = (p.y - p.py) * DAMPING;
        const vz = (p.z - p.pz) * DAMPING;
        p.px = p.x; p.py = p.y; p.pz = p.z;
        p.x += vx + windX * WIND_X + inertiaX;
        p.y += vy + GRAVITY + inertiaY;
        // 窗帘式褶皱：以竖向褶子为主，越靠下摆越明显；轻微横向起伏作为辅波
        const depth = 0.25 + 0.75 * Math.min(1, p.y / h);
        const ridge = Math.sin(p.x * 0.075 + t * 0.0021);
        const swell = 0.8 + 0.2 * Math.sin(p.y * 0.04 + t * 0.0011);
        // 边缘衰减：左右边缘的褶皱减弱，避免自由角被吹卷成折叠状态
        const edge = Math.min(1, p.x / (this.w * 0.10), (this.w - p.x) / (this.w * 0.10));
        p.z += vz + windX * WIND_Z * depth * ridge * swell * edge;
        p.z *= Z_DAMP; // 轻微回弹，避免越吹越远
      }
      // 约束求解
      for (let i = 0; i < ITERATIONS; i++) {
        for (const c of this.constraints) {
          const a = this.pts[c.a];
          const b = this.pts[c.b];
          if (a.pinned && b.pinned) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dz = b.z - a.z;
          const dist = Math.hypot(dx, dy, dz) || 1e-6;
          // 注意：dist > rest 时应把两点拉近，所以用 (dist - rest)
          const diff = ((dist - c.rest) / dist) * 0.5;
          const ox = dx * diff;
          const oy = dy * diff;
          const oz = dz * diff;
          if (!a.pinned) { a.x += ox; a.y += oy; a.z += oz; }
          if (!b.pinned) { b.x -= ox; b.y -= oy; b.z -= oz; }
        }
      }
      // 边界弹性墙：触墙后缓慢推回而非硬性截断，避免"空气墙"的生硬感
      for (const p of this.pts) {
        if (p.x < this.wallL) p.x = this.wallL + (this.wallL - p.x) * 0.45;
        else if (p.x > this.wallR) p.x = this.wallR - (p.x - this.wallR) * 0.45;
        if (p.y < this.wallT) p.y = this.wallT + (this.wallT - p.y) * 0.45;
        else if (p.y > this.wallB) p.y = this.wallB - (p.y - this.wallB) * 0.45;
        if (p.z > Z_MAX) p.z = Z_MAX;
        else if (p.z < -Z_MAX) p.z = -Z_MAX;
      }
    }

    render(ctx, tex, dpr, light) {
      const w = this.w;
      const h = this.h;
      // 画布覆盖整个窗口（含透明边距），布料飘出卡片后仍可见，直到窗口边缘
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

      const idx = (r, c) => r * COLS + c;
      const proj = (p) => ({ x: offsetX + p.x + p.z * 0.24, y: offsetY + p.y + p.z * 0.12 });

      for (let r = 0; r < ROWS - 1; r++) {
        for (let c = 0; c < COLS - 1; c++) {
          const p00 = this.pts[idx(r, c)];
          const p10 = this.pts[idx(r, c + 1)];
          const p11 = this.pts[idx(r + 1, c + 1)];
          const p01 = this.pts[idx(r + 1, c)];
          const s00 = proj(p00);
          const s10 = proj(p10);
          const s11 = proj(p11);
          const s01 = proj(p01);

          // 法线 -> 亮度（褶皱明暗）
          const e1x = p10.x - p00.x, e1y = p10.y - p00.y, e1z = p10.z - p00.z;
          const e2x = p01.x - p00.x, e2y = p01.y - p00.y, e2z = p01.z - p00.z;
          const nx = e1y * e2z - e1z * e2y;
          const ny = e1z * e2x - e1x * e2z;
          const nz = e1x * e2y - e1y * e2x;
          const nl = Math.hypot(nx, ny, nz) || 1e-6;
          const dot = (nx * light.x + ny * light.y + nz * light.z) / nl;
          // 明暗调淡：只在褶皱高反差处有可见阴影，避免整张卡片被压暗成"纱"
          const bright = 0.70 + 0.30 * Math.max(0, dot);
          const shade = Math.min(0.35, (1 - bright) * 0.75);

          const tx = (c / (COLS - 1)) * tex.width;
          const ty = (r / (ROWS - 1)) * tex.height;
          const tw = tex.width / (COLS - 1);
          const th = tex.height / (ROWS - 1);

          // 纹理小块拆成两个三角形精确贴图，消除四边形扭曲造成的缝隙
          const tx1 = tx + tw;
          const ty1 = ty + th;
          drawTri(ctx, tex, dpr, s00, s10, s11, tx, ty, tx1, ty, tx1, ty1);
          drawTri(ctx, tex, dpr, s00, s11, s01, tx, ty, tx1, ty1, tx, ty1);

          // 收集褶皱亮度，稍后用低分辨率画布平滑渲染，避免马赛克分块
          const off = (r * (COLS - 1) + c) * 4;
          shadePixels[off] = 0;
          shadePixels[off + 1] = 0;
          shadePixels[off + 2] = 0;
          shadePixels[off + 3] = Math.round(Math.max(0, Math.min(1, shade)) * 255);
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // 平滑阴影：低分辨率明暗图放大到布面，双线性插值后是连续的柔光渐变；
      // source-atop 让阴影只作用在已有的不透明布料上，透明圆角/轮廓外不会留下黑边
      shadeCtx.putImageData(shadeImg, 0, 0);
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      ctx.drawImage(shadeCanvas, 0, 0, COLS - 1, ROWS - 1, offsetX * dpr, offsetY * dpr, w * dpr, h * dpr);
      ctx.restore();
    }
  }

  // 把卡片 DOM 画成纹理快照（读取真实布局位置，含头部/进度条）
  function buildTexture(container) {
    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const isMini = container.id === 'mini';
    const radius = isMini ? 16 : 18;

    const tex = document.createElement('canvas');
    tex.width = Math.round(w * dpr);
    tex.height = Math.round(h * dpr);
    const ctx = tex.getContext('2d');
    ctx.scale(dpr, dpr);

    const cs = getComputedStyle(container);
    const bg = cs.backgroundColor || 'rgba(15,23,42,0.94)';

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = bg;
    roundRect(ctx, 0, 0, w, h, radius);
    ctx.fill();
    ctx.strokeStyle = cs.borderColor || 'rgba(148,163,184,0.16)';
    ctx.lineWidth = 1;
    roundRect(ctx, 0.5, 0.5, w - 1, h - 1, radius);
    ctx.stroke();

    const rel = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left - rect.left, y: r.top - rect.top, w: r.width, h: r.height };
    };
    const drawText = (el) => {
      const r = rel(el);
      if (!r || !el.textContent) return;
      const s = getComputedStyle(el);
      ctx.save();
      ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      ctx.fillStyle = el.style.color || s.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(el.textContent, r.x + r.w / 2, r.y + r.h / 2);
      ctx.restore();
    };

    if (!isMini) {
      // 品牌 logo + 名称 + 头部按钮占位
      const lr = rel(container.querySelector('.brand-logo'));
      if (lr) {
        const g = ctx.createLinearGradient(lr.x, lr.y, lr.x + lr.w, lr.y + lr.h);
        g.addColorStop(0, '#1d4ed8');
        g.addColorStop(1, '#3b82f6');
        ctx.save();
        roundRect(ctx, lr.x, lr.y, lr.w, lr.h, 7);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.font = '700 10px "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('DS', lr.x + lr.w / 2, lr.y + lr.h / 2 + 0.5);
        ctx.restore();
      }
      drawText(container.querySelector('.brand-name'));
      container.querySelectorAll('.card-header .icon-btn').forEach((btn) => {
        const br = rel(btn);
        if (!br) return;
        ctx.fillStyle = 'rgba(148,163,184,0.13)';
        roundRect(ctx, br.x, br.y, br.w, br.h, 8);
        ctx.fill();
        // 画真实图标字形，避免快照里变成空白方框
        const s = getComputedStyle(btn);
        ctx.save();
        ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
        ctx.fillStyle = s.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(btn.textContent, br.x + br.w / 2, br.y + br.h / 2 + 0.5);
        ctx.restore();
      });
    }

    // 余额 / 明细 / 状态文字
    drawText(isMini ? container.querySelector('.mini-balance') : container.querySelector('.balance-main'));
    drawText(isMini ? container.querySelector('.mini-status') : container.querySelector('.balance-breakdown'));
    if (!isMini) drawText(container.querySelector('.status-text'));

    // 进度条
    const track = container.querySelector('.progress-track');
    const fill = container.querySelector('.progress-fill');
    const tr = rel(track);
    if (tr) {
      ctx.fillStyle = getComputedStyle(track).backgroundColor || 'rgba(148,163,184,0.16)';
      roundRect(ctx, tr.x, tr.y, tr.w, tr.h, tr.h / 2);
      ctx.fill();
      const fr = rel(fill);
      if (fr && fr.w > 0) {
        ctx.fillStyle = fill.style.background || getComputedStyle(fill).backgroundColor || '#34d399';
        roundRect(ctx, fr.x, fr.y, fr.w, fr.h, fr.h / 2);
        ctx.fill();
      }
    }
    return tex;
  }

  let raf = null;
  let cloth = null;
  let texture = null;
  let canvas = null;
  let ctx2d = null;
  let dpr = 1;
  let frames = 0;
  let firstBadFrame = -1;
  let shadeCanvas = null;
  let shadeCtx = null;
  let shadeImg = null;
  let shadePixels = null;
  let dragVX = 0;
  let dragVY = 0;
  let dragAX = 0;
  let dragAY = 0;
  let offsetX = 0;
  let offsetY = 0;

  const light = (() => {
    // 正面为主的柔光，避免左上光照让左右两侧明暗明显不对称
    const lx = 0.12, ly = -0.22, lz = 0.97;
    const l = Math.hypot(lx, ly, lz);
    return { x: lx / l, y: ly / l, z: lz / l };
  })();

  function loop(t) {
    if (!cloth) return;
    cloth.update(t);
    cloth.render(ctx2d, texture, dpr, light);
    frames++;
    if (firstBadFrame < 0 && cloth.pts.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z))) {
      firstBadFrame = frames;
    }
    raf = requestAnimationFrame(loop);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image load failed'));
      img.src = src;
    });
  }

  async function start(container, imageSrc) {
    stop();
    canvas = document.getElementById('cloth-canvas');
    if (!canvas || !container) return;
    dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    offsetX = rect.left;
    offsetY = rect.top;
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    // 画布覆盖整个窗口，布料飘出卡片后进入透明边距仍可见
    canvas.width = Math.round(winW * dpr);
    canvas.height = Math.round(winH * dpr);
    canvas.style.width = `${winW}px`;
    canvas.style.height = `${winH}px`;
    canvas.style.left = '0px';
    canvas.style.top = '0px';
    canvas.style.display = 'block';
    ctx2d = canvas.getContext('2d');
    if (!shadeCanvas) {
      shadeCanvas = document.createElement('canvas');
      shadeCanvas.width = COLS - 1;
      shadeCanvas.height = ROWS - 1;
      shadeCtx = shadeCanvas.getContext('2d');
      shadeImg = shadeCtx.createImageData(COLS - 1, ROWS - 1);
      shadePixels = shadeImg.data;
    }
    texture = buildTexture(container);
    if (imageSrc) {
      try {
        // 优先使用主进程截取的整块卡片像素，保证抓取时内容与真实卡片完全一致
        const img = await loadImage(imageSrc);
        const t = document.createElement('canvas');
        t.width = texture.width;
        t.height = texture.height;
        const tc = t.getContext('2d');
        tc.drawImage(img, 0, 0, t.width, t.height);
        texture = t;
      } catch (err) {
        // 截图失败时保留手绘快照作为兜底
      }
    }
    const marginL = rect.left;
    const marginR = winW - rect.right;
    const marginT = rect.top;
    const marginB = winH - rect.bottom;
    cloth = new Cloth(w, h, {
      wallL: -marginL + 4,   // 预留 z 投影 + 三角形外扩余量，杜绝边缘被裁
      wallR: w + marginR - 4,
      wallT: -marginT + 3,
      wallB: h + marginB - 3,
    });
    frames = 0;
    firstBadFrame = -1;
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    cloth = null;
    texture = null;
    if (canvas) {
      const c = canvas.getContext('2d');
      c && c.clearRect(0, 0, canvas.width, canvas.height);
      canvas.style.display = 'none';
    }
  }

  // 拖动耦合：接收方向/速度（px/ms）与加速度（px/ms²），平滑后作用于布面
  function setDrag(vx, vy, ax, ay) {
    dragVX = dragVX * 0.7 + (Number.isFinite(vx) ? vx : 0) * 0.3;
    dragVY = dragVY * 0.7 + (Number.isFinite(vy) ? vy : 0) * 0.3;
    dragAX = dragAX * 0.6 + (Number.isFinite(ax) ? ax : 0) * 0.4;
    dragAY = dragAY * 0.6 + (Number.isFinite(ay) ? ay : 0) * 0.4;
  }

  window.ClothFX = {
    start,
    stop,
    setDrag,
    isActive: () => !!cloth,
    // 调试：输出质点网格的位移范围，用于验证褶皱幅度和边缘余量
    debug: () => {
      if (!cloth) return null;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      let bad = 0;
      for (const p of cloth.pts) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) bad++;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
      return {
        meshW: Math.round(cloth.w),
        meshH: Math.round(cloth.h),
        margin: cloth.margin,
        xRange: [Math.round(minX), Math.round(maxX)],
        yRange: [Math.round(minY), Math.round(maxY)],
        zRange: [Math.round(minZ * 10) / 10, Math.round(maxZ * 10) / 10],
        maxZ: Math.round(Math.max(Math.abs(minZ), Math.abs(maxZ)) * 10) / 10,
        count: cloth.pts.length,
        badCount: bad,
        frames,
        firstBadFrame,
        texSize: texture ? [texture.width, texture.height] : null,
        canvasSize: canvas ? [canvas.width, canvas.height] : null,
        texProbe: texture ? (() => {
          const c = texture.getContext('2d');
          const pts = [[100, 100], [279, 114], [285, 189], [295, 190], [285, 170]];
          return pts.map(([x, y]) => {
            const d = c.getImageData(x * dpr, y * dpr, 1, 1).data;
            return [x, y, d[0], d[1], d[2], d[3]];
          });
        })() : null,
        texAvgLum: texture ? (() => {
          const c = texture.getContext('2d');
          const d = c.getImageData(0, 0, texture.width, texture.height).data;
          let s = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] > 10) {
              s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
              n++;
            }
          }
          return n ? +(s / n).toFixed(1) : null;
        })() : null,
        cornerZ: cloth ? (() => {
          const bl = cloth.pts[(ROWS - 1) * COLS];
          const br = cloth.pts[(ROWS - 1) * COLS + (COLS - 1)];
          return {
            bottomLeft: Math.round(bl.z * 10) / 10,
            bottomRight: Math.round(br.z * 10) / 10,
          };
        })() : null,
      };
    },
  };
})();
