// 布料物理模拟：Verlet 积分 + 质点-弹簧网格 + 风力 + 法线光照
// 抓住卡片时，把卡片快照贴到布面上，风从侧面吹出真实的褶皱阴影
(function () {
  'use strict';

  const FRAME_MS = 16.7;      // 估算帧时长，用于把拖动速度折算成每帧位移
  const WIND_X = 0.011;       // 水平摆动基础系数（整体强度由 params.wind 调节）
  const PINCH_R = 90;         // 捏起影响的半径（随卡片尺寸缩放）

  // 布料动效的全部可调参数（默认值 = 当前打磨好的手感）
  const DEFAULT_PARAMS = {
    cols: 20,                 // 网格列数（密度）
    rows: 14,                 // 网格行数（密度）
    damping: 0.985,           // 每帧速度阻尼
    gravity: 0.07,            // 重力
    airDrag: 0.004,           // 布料自身速度的空气阻尼（用于回落稳定）
    dragLag: 0.020,           // 以抓取点为中心的拖曳系数：越远的布料越滞后
    wind: 1.0,                // 风力总强度
    fold: 0.030,              // 竖向褶皱波力（褶皱幅度）
    zDamp: 0.985,             // z 回弹阻尼
    iterations: 4,            // 约束求解迭代次数
    dragDecay: 0.90,          // 拖动速度/加速度每帧衰减
    inertia: 0.45,            // 拖动加速度 -> 惯性反推力系数
    speedFlutter: 0.20,       // 拖动速度对风力的增益（速度越快越飘）
    zMax: 10,                 // 褶皱深度上限（配合边界软墙，防止投影超出窗口）
    pinchZ: 8,                // 抓取点向观察者隆起的 z 高度（3D 捏起效果）
    pinchPull: 0.13,          // 周围布料向抓取点收拢的力度
    pinchLift: 0.12,          // 周围布料向观察者微隆的力度
  };
  let currentParams = { ...DEFAULT_PARAMS };

  // 平滑值噪声：随时间和空间变化的褶皱场，让褶皱在任意位置/方向出现
  function hash(ix, iy, t) {
    const s = Math.sin(ix * 127.1 + iy * 311.7 + t * 74.7) * 43758.5453;
    return s - Math.floor(s);
  }
  function noise(x, y, t) {
    const sx = x * 0.028;
    const sy = y * 0.030;
    const gx = Math.floor(sx);
    const gy = Math.floor(sy);
    const fx = sx - gx;
    const fy = sy - gy;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const a = hash(gx, gy, t);
    const b = hash(gx + 1, gy, t);
    const c = hash(gx, gy + 1, t);
    const d = hash(gx + 1, gy + 1, t);
    return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
  }
  // 双倍频噪声：褶皱纹理更丰富、不规则
  function turbulence(x, y, t) {
    return (noise(x, y, t) + 0.55 * noise(x * 2.1 + 23.7, y * 2.3 + 7.1, t * 1.3)) / 1.55;
  }
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
  function drawTri(ctx, tex, dpr, P, Q, R, uP, vP, uQ, vQ, uR, vR, expand) {
    // 三角形中心外扩 0.5 设备像素，消除光栅化的发丝缝隙；
    // 摊平归位阶段不经过三角形（整张贴图），此处恒传 0.5 即可
    const cxs = (P.x + Q.x + R.x) / 3;
    const cys = (P.y + Q.y + R.y) / 3;
    const out = (p) => {
      if (!expand) return { x: p.x * dpr, y: p.y * dpr };
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
      this.grabPin = -1;
      this.grabX = opts && opts.grab ? opts.grab.x : -1;
      this.grabY = opts && opts.grab ? opts.grab.y : -1;
      // 捏起半径/高度随卡片尺寸缩放，避免迷你卡片被捏得过大
      this.grabR = Math.min(PINCH_R, Math.min(w, h) * 0.5);
      this.margin = MARGIN;
      // 动效参数：默认值 + 外部传入（设置页可调）
      this.params = Object.assign({}, DEFAULT_PARAMS, (opts && opts.params) || {});
      this.buildMesh();
    }

    // 按当前 params 生成质点与约束（密度参数变化时用于重建网格）
    buildMesh() {
      const cols = this.params.cols;
      const rows = this.params.rows;
      this.cols = cols;
      this.rows = rows;
      const spX = this.w / (cols - 1);
      const spY = this.h / (rows - 1);
      const idx = (r, c) => r * cols + c;
      this.pts = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          this.pts.push({
            idx: r * cols + c,
            x: c * spX,
            y: r * spY,
            z: 0,
            px: c * spX,
            py: r * spY,
            pz: 0,
            restX: c * spX, // 初始平铺位置：松手恢复时被拉回的目标
            restY: r * spY,
            pinned: false, // 唯一固定点 = 手指抓取点
          });
        }
      }
      // 抓取点：找到离手指最近的质点作为“手捏住”的锚点，动效随抓取位置变化
      this.grabPin = -1;
      if (Number.isFinite(this.grabX) && Number.isFinite(this.grabY)) {
        let best = -1;
        let bestD = Infinity;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const d = (c * spX - this.grabX) ** 2 + (r * spY - this.grabY) ** 2;
            if (d < bestD) {
              bestD = d;
              best = r * cols + c;
            }
          }
        }
        this.grabPin = best;
      }
      this.constraints = [];
      const add = (a, b, rest) => this.constraints.push({ a, b, rest });
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (c < cols - 1) add(idx(r, c), idx(r, c + 1), spX);                 // 结构
          if (r < rows - 1) add(idx(r, c), idx(r + 1, c), spY);                 // 结构
          if (r < rows - 1 && c < cols - 1) add(idx(r, c), idx(r + 1, c + 1), Math.hypot(spX, spY)); // 剪切
          if (r < rows - 1 && c > 0) add(idx(r, c), idx(r + 1, c - 1), Math.hypot(spX, spY));        // 剪切
          if (c < cols - 2) add(idx(r, c), idx(r, c + 2), spX * 2);             // 弯曲
          if (r < rows - 2) add(idx(r, c), idx(r + 2, c), spY * 2);             // 弯曲
        }
      }
    }

    rebuild() {
      this.buildMesh();
    }

    update(t) {
      const P = this.params;
      // 阵风：水平摆动 + 沿布面纵横两个方向的起伏；拖动越快，风越强
      const speed = Math.hypot(dragVX, dragVY);
      const flutter = 1 + Math.min(0.5, speed * P.speedFlutter);
      // 噪声驱动阵风：风势忽强忽弱，像真实气流一样不规律
      const gust = 0.7 + 0.65 * noise(3.7, 9.2, t * 0.00022);
      // 松手恢复阶段风逐渐减弱，让弹力能把布料稳稳拉回平铺
      const windScale = this.recovering ? Math.max(0, 1 - this.recoverT / 50) : 1;
      // 风效开关：关闭后不再自动飘动，只保留拖拽/重力效果
      const windX = windEnabled
        ? (Math.sin(t * 0.0024) * 2.1 + Math.sin(t * 0.0012) * 1.0) * gust * flutter * P.wind * windScale
        : 0;
      dragVX *= P.dragDecay;
      dragVY *= P.dragDecay;
      dragAX *= P.dragDecay;
      dragAY *= P.dragDecay;
      const h = this.h;
      const diagRef = Math.hypot(this.w, this.h) * 0.5;
      // 捏起高度/半径随参数与卡片尺寸实时计算，改参数立即生效
      this.pinchZ = Math.min(P.pinchZ, Math.min(this.w, this.h) * 0.08);
      this.grabR = Math.min(PINCH_R, Math.min(this.w, this.h) * 0.5);
      for (const p of this.pts) {
        if (p.pinned || p.idx === this.grabPin) {
          // 抓取点本身向观察者隆起，形成被手指捏起的 3D 形态
          if (p.idx === this.grabPin) p.z = this.pinchZ;
          p.px = p.x; p.py = p.y; p.pz = p.z;
          continue;
        }
        const vx = (p.x - p.px) * P.damping;
        const vy = (p.y - p.py) * P.damping;
        const vz = (p.z - p.pz) * P.damping;
        const lx = p.x - p.px;  // 本帧局部速度（用于空气阻力）
        const ly = p.y - p.py;
        p.px = p.x; p.py = p.y; p.pz = p.z;
        // 以抓取点为中心的拖曳：手边几乎不滞后，越远的布料越拖在后面，
        // 模拟“手抓住一点把柔软卡片拽过去，布尾跟着走”的真实情景
        const dg = this.grabPin >= 0
          ? Math.hypot(p.x - this.grabX, p.y - this.grabY)
          : p.y;
        const distFactor = Math.min(1, dg / diagRef);
        const lagX = -P.dragLag * dragVX * FRAME_MS * distFactor;
        const lagY = -P.dragLag * dragVY * FRAME_MS * distFactor;
        const inertiaX = -dragAX * P.inertia * 16.7 * distFactor;
        const inertiaY = -dragAY * P.inertia * 16.7 * distFactor;
        const airX = -P.airDrag * lx;
        const airY = -P.airDrag * ly;
        p.x += vx + windX * WIND_X + inertiaX + lagX + airX;
        p.y += vy + P.gravity + inertiaY + lagY + airY;
        // 褶皱：平滑噪声场随空间/时间演化，褶皱在任意位置出现；
        // 幅度按"离手指抓取点越远越明显"计算
        const depth = 0.15 + 0.85 * Math.min(1, dg / (h * 0.55));
        const edge = Math.min(1, p.x / (this.w * 0.06), (this.w - p.x) / (this.w * 0.06));
        const n = turbulence(p.x, p.y, t * 0.00022);
        p.z += vz + windX * P.fold * depth * n * edge;
        p.z *= P.zDamp; // 轻微回弹，避免越吹越远
        // 抓取效果：布料向手指聚拢并微隆；收拢带噪声扰动，形成不规则放射褶皱
        if (this.grabPin >= 0) {
          const dx = p.x - this.grabX;
          const dy = p.y - this.grabY;
          const d = Math.hypot(dx, dy);
          if (d < this.grabR && d > 1) {
            const fall = (1 - d / this.grabR) ** 2;
            const jit = 0.4 + 0.9 * (0.5 + 0.5 * noise(p.x * 0.4, p.y * 0.4, t * 0.00018));
            p.x -= (dx / d) * P.pinchPull * fall * jit;
            p.y -= (dy / d) * P.pinchPull * fall * jit;
            p.z += P.pinchLift * fall;
          }
        }
      }
      // 约束求解
      for (let i = 0; i < P.iterations; i++) {
        for (const c of this.constraints) {
          const a = this.pts[c.a];
          const b = this.pts[c.b];
          const aPin = a.pinned || a.idx === this.grabPin;
          const bPin = b.pinned || b.idx === this.grabPin;
          if (aPin && bPin) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dz = b.z - a.z;
          const dist = Math.hypot(dx, dy, dz) || 1e-6;
          // 注意：dist > rest 时应把两点拉近，所以用 (dist - rest)
          const diff = ((dist - c.rest) / dist) * 0.5;
          const ox = dx * diff;
          const oy = dy * diff;
          const oz = dz * diff;
          if (!aPin) { a.x += ox; a.y += oy; a.z += oz; }
          if (!bPin) { b.x -= ox; b.y -= oy; b.z -= oz; }
        }
      }
      // 边界弹性墙：触墙后缓慢推回而非硬性截断，避免"空气墙"的生硬感
      for (const p of this.pts) {
        if (p.pinned || p.idx === this.grabPin) continue;
        // 推回的同时消耗法向速度（非弹性碰撞），贴墙时不会抖动
        if (p.x < this.wallL) {
          p.x = this.wallL + (this.wallL - p.x) * 0.45;
          p.px = p.x - (p.x - p.px) * 0.35;
        } else if (p.x > this.wallR) {
          p.x = this.wallR - (p.x - this.wallR) * 0.45;
          p.px = p.x - (p.x - p.px) * 0.35;
        }
        if (p.y < this.wallT) {
          p.y = this.wallT + (this.wallT - p.y) * 0.45;
          p.py = p.y - (p.y - p.py) * 0.35;
        } else if (p.y > this.wallB) {
          p.y = this.wallB - (p.y - this.wallB) * 0.45;
          p.py = p.y - (p.y - p.py) * 0.35;
        }
        if (p.z > P.zMax) p.z = P.zMax;
        else if (p.z < -P.zMax) p.z = -P.zMax;
      }
      // 松手恢复：先让布料带着惯性甩动，随后弹力从中心向四周逐层拉回平铺，
      // 像纸张落回桌面一样从中间摊开，最终变成卡片本身（DOM 随后淡入）
      if (this.recovering) {
        this.recoverT++;
        const rt = this.recoverT;
        // 前 8 帧几乎不加恢复力，让松手时的惯性/重力先自然表现
        let k = 0.0015;
        let kz = 0.012;
        let damp = 0; // 恢复阶段额外速度阻尼：让回弹平滑收敛，避免末段来回振荡
        if (rt > 8) {
          const e = Math.min(1, (rt - 8) / 30);
          const ease = e * e * (3 - 2 * e);
          k = 0.008 + ease * 0.115;
          kz = 0.015 + ease * 0.13;
          damp = ease * 0.18;
        }
        const cw = this.w;
        const ch = this.h;
        const diagRef = Math.hypot(cw, ch) * 0.5;
        let maxD = 0;
        for (const p of this.pts) {
          // 离中心越近恢复越快：中心先贴平，边缘如波浪逐层摊开
          const dc = Math.hypot(p.restX - cw / 2, p.restY - ch / 2) / diagRef;
          const local = k * (1 - 0.45 * Math.min(1, dc));
          const vx = p.x - p.px;
          const vy = p.y - p.py;
          const vz = p.z - p.pz;
          p.x += (p.restX - p.x) * local - vx * damp;
          p.y += (p.restY - p.y) * local - vy * damp;
          p.z += -p.z * kz - vz * damp * 0.5;
          const d = Math.hypot(p.x - p.restX, p.y - p.restY, p.z);
          if (d > maxD) maxD = d;
        }
        // 末段收尾：整体进入 2px 后平滑插值并清空速度，避免最后一下抖动/急停
        if (maxD < 2.0) {
          for (const p of this.pts) {
            p.x += (p.restX - p.x) * 0.3;
            p.y += (p.restY - p.y) * 0.3;
            p.z += -p.z * 0.35;
            p.px = p.x; p.py = p.y; p.pz = p.z;
          }
          maxD *= 0.7;
        }
        this.lastMaxD = maxD;
        // 布料基本归位（视觉上已摊平）并稳定数帧后，通知外部收尾
        if (maxD < 1.0) this.recoverSettledFrames++;
        else this.recoverSettledFrames = 0;
        if (this.recoverSettledFrames >= 6) {
          this.recovering = false;
          this.recoverDone = true;
        }
      }
    }

    render(ctx, tex, dpr, light) {
      const w = this.w;
      const h = this.h;
      const cols = this.cols;
      const rows = this.rows;
      ensureShade(cols, rows);
      // 画布覆盖整个窗口（含透明边距），布料飘出卡片后仍可见，直到窗口边缘
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

      // 摊平归位阶段：直接整张贴图（与卡片截图像素级一致），
      // 避免三角形网格的外扩/接缝在交叉淡化时露出网格线
      if (this.recovering && this.lastMaxD !== undefined && this.lastMaxD < 1.0) {
        ctx.drawImage(tex, 0, 0, tex.width, tex.height, offsetX * dpr, offsetY * dpr, w * dpr, h * dpr);
        return;
      }

      const idx = (r, c) => r * cols + c;
      const proj = (p) => ({ x: offsetX + p.x + p.z * 0.24, y: offsetY + p.y + p.z * 0.12 });

      for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < cols - 1; c++) {
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
          let shade = Math.min(0.35, (1 - bright) * 0.75);
          const cx = ((c + 0.5) / (cols - 1)) * w;
          const cy = ((r + 0.5) / (rows - 1)) * h;
          // 折痕阴影（设置开关）：z 落差越大越暗，噪声扰动避免过于规律
          if (creaseEnabled) {
            const crease = Math.min(0.45, (Math.abs(p10.z - p00.z) + Math.abs(p01.z - p00.z)) * 0.05) *
              (0.55 + 0.45 * noise(cx * 0.55, cy * 0.55, 3.3));
            shade = Math.min(0.60, shade + crease);
          }
          // 抓取点：不规则的手指阴影 + 放射收拢褶皱，呈现"被抓"的感觉
          if (this.grabPin >= 0) {
            const dxc = cx - this.grabX;
            const dyc = cy - this.grabY;
            const dc = Math.hypot(dxc, dyc);
            const R = this.grabR;
            if (dc < R) {
              // 手指阴影：抓取点附近不规则暗块
              if (dc < 14) {
                const blob = (1 - dc / 14) * (0.30 + 0.35 * noise(cx, cy, 5.1));
                shade = Math.min(0.62, shade + blob);
              }
              // 放射收拢褶皱：6 条角度抖动、强度不一的暗褶，越靠手指越深
              if (dc > 6) {
                const ang = Math.atan2(dyc, dxc);
                for (let k = 0; k < 6; k++) {
                  const dir = (k / 6) * Math.PI * 2 + (noise(k, 0.5, 7.3) - 0.5) * 1.1;
                  let da = Math.abs(ang - dir);
                  da = Math.min(da, Math.PI * 2 - da);
                  if (da < 0.22) {
                    const fold = (1 - da / 0.22) * (1 - dc / R) *
                      (0.20 + 0.22 * noise(cx * 0.7, cy * 0.7, 9.7));
                    shade = Math.min(0.62, shade + fold);
                  }
                }
              }
            }
          }

          const tx = (c / (cols - 1)) * tex.width;
          const ty = (r / (rows - 1)) * tex.height;
          const tw = tex.width / (cols - 1);
          const th = tex.height / (rows - 1);

          // 纹理小块拆成两个三角形精确贴图，消除四边形扭曲造成的缝隙
          const tx1 = tx + tw;
          const ty1 = ty + th;
          drawTri(ctx, tex, dpr, s00, s10, s11, tx, ty, tx1, ty, tx1, ty1, 0.5);
          drawTri(ctx, tex, dpr, s00, s11, s01, tx, ty, tx1, ty1, tx, ty1, 0.5);

          // 收集褶皱亮度，稍后用低分辨率画布平滑渲染，避免马赛克分块
          const off = (r * (cols - 1) + c) * 4;
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
      ctx.drawImage(shadeCanvas, 0, 0, cols - 1, rows - 1, offsetX * dpr, offsetY * dpr, w * dpr, h * dpr);
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

    // 余额 / 更新时间
    drawText(isMini ? container.querySelector('.mini-balance') : container.querySelector('.balance-main'));
    drawText(isMini ? container.querySelector('.mini-status') : container.querySelector('.updated-at'));

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
  let settleTimer = null;
  let onRecoveredCb = null;
  let creaseEnabled = false;
  let windEnabled = true;

  const light = (() => {
    // 正面为主的柔光，避免左上光照让左右两侧明暗明显不对称
    const lx = 0.12, ly = -0.22, lz = 0.97;
    const l = Math.hypot(lx, ly, lz);
    return { x: lx / l, y: ly / l, z: lz / l };
  })();

  // 低分辨率明暗图画布：网格密度变化时重建
  function ensureShade(cols, rows) {
    if (shadeCanvas && shadeCanvas.width === cols - 1 && shadeCanvas.height === rows - 1) return;
    shadeCanvas = document.createElement('canvas');
    shadeCanvas.width = cols - 1;
    shadeCanvas.height = rows - 1;
    shadeCtx = shadeCanvas.getContext('2d');
    shadeImg = shadeCtx.createImageData(cols - 1, rows - 1);
    shadePixels = shadeImg.data;
  }

  function loop(t) {
    if (!cloth) return;
    cloth.update(t);
    if (cloth.recoverDone) {
      finishRecover();
      return;
    }
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

  async function start(container, imageSrc, grab, opts) {
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
    creaseEnabled = !!(opts && opts.crease);
    windEnabled = !(opts && opts.wind === false);
    ctx2d = canvas.getContext('2d');
    // 动效参数：默认值 + 设置页传入
    currentParams = Object.assign({}, DEFAULT_PARAMS, (opts && opts.params) || {});
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
    // 固定点 = 手指抓取点；异常情况下兜底到卡片中心
    const grabPoint = grab && Number.isFinite(grab.x) && Number.isFinite(grab.y)
      ? grab
      : { x: w / 2, y: h / 2 };
    cloth = new Cloth(w, h, {
      wallL: -marginL + 4,   // 预留 z 投影 + 三角形外扩余量，杜绝边缘被裁
      wallR: w + marginR - 4,
      wallT: -marginT + 3,
      wallB: h + marginB - 3,
      grab: grabPoint,
      params: currentParams,
    });
    ensureShade(cloth.cols, cloth.rows);
    frames = 0;
    firstBadFrame = -1;
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    clearTimeout(settleTimer);
    settleTimer = null;
    onRecoveredCb = null;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    cloth = null;
    texture = null;
    if (canvas) {
      const c = canvas.getContext('2d');
      c && c.clearRect(0, 0, canvas.width, canvas.height);
      canvas.style.display = 'none';
      canvas.classList.remove('fading');
    }
  }

  // 松手：解除手指固定，布料带着惯性甩动，随后被弹力拉回摊平；
  // 完全归位后调用回调（由 app.js 让卡片淡入），实现"布料变成卡片"的无缝衔接
  function release(cb) {
    setDrag(0, 0, 0, 0);
    clearTimeout(settleTimer);
    settleTimer = null;
    onRecoveredCb = typeof cb === 'function' ? cb : null;
    if (!cloth) {
      const cb2 = onRecoveredCb;
      onRecoveredCb = null;
      stop();
      if (cb2) cb2();
      return;
    }
    if (canvas) canvas.classList.remove('fading');
    cloth.recovering = true;
    cloth.recoverT = 0;
    cloth.recoverSettledFrames = 0;
    cloth.recoverDone = false;
    cloth.grabPin = -1; // 松手：解除手指固定点
  }

  // 布料已摊平归位：布料淡出与卡片淡入交叉进行，
  // 两者内容一致（布料即卡片快照），视觉上"布料变成卡片"，无空白帧闪动
  function finishRecover() {
    const cb = onRecoveredCb;
    onRecoveredCb = null;
    clearTimeout(settleTimer);
    if (canvas) canvas.classList.add('fading');
    if (cb) cb();
    settleTimer = setTimeout(() => {
      settleTimer = null;
      stop();
    }, 340); // 必须盖过画布 0.3s 的淡出过渡，否则布料半透明时被掐断会闪
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
    release,
    setDrag,
    isActive: () => !!cloth,
    // 运行时更新动效参数（设置页保存后立即生效；密度变化会重建网格）
    setParams: (patch) => {
      if (!patch || typeof patch !== 'object') return { ...currentParams };
      Object.assign(currentParams, patch);
      if (cloth) {
        const densityChanged =
          (patch.cols !== undefined && patch.cols !== cloth.params.cols) ||
          (patch.rows !== undefined && patch.rows !== cloth.params.rows);
        Object.assign(cloth.params, patch);
        if (densityChanged) cloth.rebuild();
      }
      return { ...currentParams };
    },
    getParams: () => ({ ...currentParams }),
    // 调试：输出质点网格的位移范围，用于验证褶皱幅度和边缘余量
    debug: () => {
      if (!cloth) return null;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      let bad = 0;
      let maxDisp = 0;
      for (const p of cloth.pts) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) bad++;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
        const d = Math.hypot(p.x - p.restX, p.y - p.restY, p.z);
        if (d > maxDisp) maxDisp = d;
      }
      return {
        meshW: Math.round(cloth.w),
        meshH: Math.round(cloth.h),
        margin: cloth.margin,
        xRange: [Math.round(minX), Math.round(maxX)],
        yRange: [Math.round(minY), Math.round(maxY)],
        zRange: [Math.round(minZ * 10) / 10, Math.round(maxZ * 10) / 10],
        maxZ: Math.round(Math.max(Math.abs(minZ), Math.abs(maxZ)) * 10) / 10,
        maxDisp: Math.round(maxDisp * 10) / 10,
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
          const bl = cloth.pts[(cloth.rows - 1) * cloth.cols];
          const br = cloth.pts[(cloth.rows - 1) * cloth.cols + (cloth.cols - 1)];
          return {
            bottomLeft: Math.round(bl.z * 10) / 10,
            bottomRight: Math.round(br.z * 10) / 10,
          };
        })() : null,
      };
    },
  };
})();
