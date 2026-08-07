const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  balance: null,
  status: 'idle', // idle | loading | ok | error
  errorMsg: '',
  lastFetchedAt: null,
  lowNotified: false,
  timer: null,
  lastTotal: null,
};

/* ---------- 工具 ---------- */

function formatMoney(value, currency) {
  const num = Number.parseFloat(value) || 0;
  const text = num.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const symbol = currency === 'USD' ? '$' : '¥';
  return { text, num, symbol };
}

function timeNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function levelOf(total, threshold) {
  if (total < threshold) return 'low';
  if (total < threshold * 4) return 'mid';
  return 'ok';
}

function levelColor(level) {
  const root = getComputedStyle(document.body);
  return root.getPropertyValue(`--${level === 'ok' ? 'ok' : level === 'mid' ? 'warn' : 'danger'}`).trim();
}

function applyTheme(theme) {
  document.body.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

/* ---------- 视图切换 ---------- */

let settingsOpen = false;

function applyMode(mode) {
  state.config.mode = mode;
  if (settingsOpen) return;
  $('card').classList.toggle('hidden', mode !== 'card');
  $('settings').classList.add('hidden');
  $('mini').classList.toggle('hidden', mode !== 'mini');
  $('dot').classList.toggle('hidden', mode !== 'dot');
}

function showSettingsView() {
  settingsOpen = true;
  $('card').classList.add('hidden');
  $('mini').classList.add('hidden');
  $('dot').classList.add('hidden');
  $('settings').classList.remove('hidden');
}

function hideSettings() {
  settingsOpen = false;
  $('settings').classList.add('hidden');
  applyMode(state.config.mode);
}

async function openSettings() {
  if (state.config.mode !== 'card') {
    state.config = await window.ds.updateConfig({ mode: 'card' });
  }
  fillSettings();
  showSettingsView();
}

/* ---------- 余额渲染 ---------- */

function renderBalance() {
  const dot = $('dot');
  dot.classList.remove('low', 'mid', 'loading');

  if (!state.config || !state.config.apiKey) {
    $('balance-main').textContent = '--';
    $('balance-breakdown').textContent = '未配置 API Key，点击 ⚙ 设置';
    setStatus('idle', '未配置 API Key');
    $('progress-fill').style.width = '0%';
    $('dot-balance').textContent = 'DS';
    $('mini-balance').textContent = '--';
    $('mini-balance').style.color = '';
    $('mini-status').textContent = '未配置 API Key';
    return;
  }

  if (state.status === 'loading') {
    setStatus('loading', '查询中…');
    dot.classList.add('loading');
    $('dot-balance').textContent = '…';
    $('mini-balance').textContent = '…';
    $('mini-balance').style.color = '';
    $('mini-status').textContent = '查询中…';
    return;
  }

  if (state.status === 'error') {
    setStatus('error', state.errorMsg);
    $('dot-balance').textContent = '!';
    $('mini-balance').textContent = '!';
    $('mini-balance').style.color = '';
    $('mini-status').textContent = state.errorMsg;
    return;
  }

  // ok
  const data = state.balance;
  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
  const primary = infos[0] || {};
  const { text, num, symbol } = formatMoney(primary.total_balance, primary.currency);
  const granted = formatMoney(primary.granted_balance, primary.currency);
  const topped = formatMoney(primary.topped_up_balance, primary.currency);
  const threshold = Number(state.config.lowBalanceThreshold) || 10;
  const level = levelOf(num, threshold);
  const color = levelColor(level);

  $('balance-main').textContent = `${symbol}${text}`;
  $('balance-main').style.color = color;

  const parts = [];
  if (infos.length > 1) parts.push(`${primary.currency || ''} ${symbol}${text}`);
  if (primary.topped_up_balance !== undefined) parts.push(`充值 ${symbol}${topped.text}`);
  if (primary.granted_balance !== undefined) parts.push(`赠送 ${symbol}${granted.text}`);
  $('balance-breakdown').textContent = parts.join(' · ') || '暂无明细';

  const pct = Math.min(num / 100, 1) * 100;
  $('progress-fill').style.width = `${pct}%`;
  $('progress-fill').style.background = color;

  // 迷你卡片
  $('mini-balance').textContent = `${symbol}${text}`;
  $('mini-balance').style.color = color;
  $('mini-status').textContent = state.balance?.is_available === false
    ? '账户不可用'
    : level === 'low'
      ? `低余额预警 ¥${threshold}`
      : `更新于 ${state.lastFetchedAt}`;

  if (state.balance?.is_available === false) {
    setStatus('warn', '账户当前不可用');
  } else {
    const statusText = level === 'low' ? `余额低于 ¥${threshold} 预警线` : '账户可用';
    setStatus(level === 'ok' ? 'ok' : 'warn', statusText);
  }

  // 圆点
  dot.classList.add(level);
  $('dot-balance').textContent = `${symbol}${num >= 100 ? num.toFixed(0) : num.toFixed(1)}`;

  // 余额变化高亮
  if (state.lastTotal !== null && Math.abs(state.lastTotal - num) > 0.001) {
    const delta = num - state.lastTotal;
    const flashCls = delta < 0 ? 'flash-down' : 'flash-up';
    $('balance-main').classList.remove('flash-up', 'flash-down');
    void $('balance-main').offsetWidth;
    $('balance-main').classList.add(flashCls);

    // 变化金额浮动动效：如 -¥1.00 / +¥0.50
    spawnDelta($('card').querySelector('.balance-row'), $('balance-main'), symbol, delta);
    spawnDelta($('mini').querySelector('.mini-main'), $('mini-balance'), symbol, delta);
  }
  state.lastTotal = num;

  // 低余额提醒（只在状态切换时通知一次）
  if (level === 'low' && !state.lowNotified) {
    state.lowNotified = true;
    window.ds.notify(
      'DeepSeek 余额不足',
      `当前余额 ${symbol}${text}，低于预警阈值 ¥${threshold}`
    );
  } else if (level !== 'low') {
    state.lowNotified = false;
  }
}

function spawnDelta(container, anchor, symbol, delta) {
  if (!container || !anchor) return;
  const el = document.createElement('div');
  el.className = `delta-badge ${delta < 0 ? 'down' : 'up'}`;
  el.textContent = `${delta < 0 ? '−' : '+'}${symbol}${Math.abs(delta).toFixed(2)}`;
  container.appendChild(el);
  // 定位到余额数字右侧，垂直居中
  const left = anchor.offsetLeft + anchor.offsetWidth + 6;
  const maxLeft = container.clientWidth - el.offsetWidth - 6;
  el.style.left = `${Math.min(left, Math.max(maxLeft, 6))}px`;
  el.style.top = `${anchor.offsetTop + (anchor.offsetHeight - el.offsetHeight) / 2}px`;
  el.addEventListener('animationend', () => el.remove(), { once: true });
  setTimeout(() => el.remove(), 2500); // 兜底清理
}

/* ---------- 通用指针拖拽 ---------- */

// 让指定元素可拖动窗口：按下后移动即拖动；未移动且提供 onClick 时视为点击
// skip 为选择器，命中（如按钮/输入框）时不触发拖拽，保证交互元素可正常点击
function makeDraggable(el, { skip, onClick, cloth = false } = {}) {
  if (!el) return;
  let drag = null;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (skip && e.target.closest(skip)) return;
    // 先同步建立拖拽状态，确保截屏期间移动也能正常跟随
    el.setPointerCapture(e.pointerId);
    drag = {
      moved: false,
      acc: 0,
      lastSX: e.screenX,
      lastSY: e.screenY,
      offsetReady: false,
      lastT: performance.now(),
      lastVX: 0,
      lastVY: 0,
      // 按下点的窗口内偏移 = clientX（视口坐标即窗口内容区坐标），同步可得，
      // 不依赖 IPC 异步返回，避免截屏阻塞导致偏移迟到、窗口跳变
      offsetX: e.clientX,
      offsetY: e.clientY,
      offsetReady: true,
    };
    el.classList.add('dragging');
    if (window.ClothFX) window.ClothFX.setDrag(0, 0, 0, 0);

    // 抓住卡片时：截取卡片真实像素作为布料贴图，再启动物理模拟
    if (cloth) {
      (async () => {
        let src = null;
        let grab = null;
        try {
          const r = el.getBoundingClientRect();
          if (window.ds && window.ds.capture) {
            src = await window.ds.capture({
              x: Math.round(r.x),
              y: Math.round(r.y),
              width: Math.round(r.width),
              height: Math.round(r.height),
            });
          }
          // 抓取点在卡片内的位置：作为布料“手捏住”的锚点，动效随抓取位置变化
          grab = { x: e.clientX - r.left, y: e.clientY - r.top };
        } catch (err) {
          src = null;
        }
        if (!drag) {
          // 松手比截图快：直接终止，避免出现卡死状态
          if (window.ClothFX) window.ClothFX.stop();
          return;
        }
        const clothOpts = { crease: !!(state.config && state.config.creaseShadow) };
        if (window.ClothFX) await window.ClothFX.start(el, src, grab, clothOpts);
        if (drag) el.classList.add('cloth-active');
      })();
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const now = performance.now();
    const dt = Math.max(1, now - drag.lastT);
    const vx = (e.screenX - drag.lastSX) / dt;
    const vy = (e.screenY - drag.lastSY) / dt;
    const ax = (vx - drag.lastVX) / dt;
    const ay = (vy - drag.lastVY) / dt;
    drag.lastT = now;
    drag.lastVX = vx;
    drag.lastVY = vy;
    if (window.ClothFX) window.ClothFX.setDrag(vx, vy, ax, ay);
    drag.acc += Math.abs(e.screenX - drag.lastSX) + Math.abs(e.screenY - drag.lastSY);
    drag.lastSX = e.screenX;
    drag.lastSY = e.screenY;
    if (!drag.moved && drag.acc < 4) return;
    drag.moved = true;
    if (!drag.offsetReady) return;
    // 绝对目标位置：屏幕绝对坐标 - 按下时的窗口内偏移（无反馈，不抖动）
    drag.tx = e.screenX - drag.offsetX;
    drag.ty = e.screenY - drag.offsetY;
    if (!drag.raf) {
      drag.raf = requestAnimationFrame(() => {
        drag.raf = null;
        window.ds.moveTo(drag.tx, drag.ty);
      });
    }
  });

  const end = () => {
    if (!drag) return;
    const wasDrag = drag.moved;
    if (drag.raf) cancelAnimationFrame(drag.raf);
    drag = null;
    el.classList.remove('dragging');
    if (cloth) {
      // 松手：布料淡出收尾，与卡片淡入交叉过渡
      if (window.ClothFX) window.ClothFX.release();
      el.classList.remove('cloth-active');
      el.classList.add('settle');
      setTimeout(() => el.classList.remove('settle'), 340);
    }
    if (!wasDrag && onClick) onClick();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function setStatus(kind, text) {
  const dot = $('status-dot');
  dot.className = 'status-dot';
  if (kind !== 'idle') dot.classList.add(kind);
  $('status-text').textContent = text;
  $('updated-at').textContent = state.lastFetchedAt ? `更新于 ${state.lastFetchedAt}` : '';
}

/* ---------- 余额查询 ---------- */

async function refresh(force = false) {
  if (!state.config) return;
  if (state.status === 'loading' && !force) return;

  state.status = 'loading';
  renderBalance();

  const res = await window.ds.fetchBalance();

  if (res.ok) {
    state.status = 'ok';
    state.balance = res.data;
    state.lastFetchedAt = timeNow();
    state.errorMsg = '';
  } else {
    state.status = 'error';
    state.balance = null;
    state.errorMsg = errorText(res.code, res.status);
    state.lastFetchedAt = null;
  }
  renderBalance();
}

function errorText(code, status) {
  switch (code) {
    case 'NO_KEY': return '未配置 API Key';
    case 'UNAUTHORIZED': return 'API Key 无效（401）';
    case 'TIMEOUT': return '请求超时';
    case 'NETWORK': return '网络错误';
    case 'HTTP': return `接口错误（HTTP ${status}）`;
    default: return '查询失败';
  }
}

function restartTimer() {
  if (state.timer) clearInterval(state.timer);
  const interval = Math.max(10000, Number(state.config.refreshInterval) || 300000);
  state.timer = setInterval(() => refresh(), interval);
}

/* ---------- 设置 ---------- */

function fillSettings() {
  const cfg = state.config;
  $('set-api-key').value = cfg.apiKey || '';
  $('set-interval').value = String(cfg.refreshInterval);
  $('set-threshold').value = String(cfg.lowBalanceThreshold);
  $('set-theme').value = cfg.theme === 'light' ? 'light' : 'dark';
  $('set-ontop').checked = !!cfg.alwaysOnTop;
  $('set-autostart').checked = !!cfg.autoLaunch;
  $('set-crease').checked = !!cfg.creaseShadow;
  $('test-result').textContent = '';
}

async function saveSettings() {
  const interval = Math.max(10000, Number($('set-interval').value) || 300000);
  const patch = {
    apiKey: $('set-api-key').value.trim(),
    refreshInterval: interval,
    lowBalanceThreshold: Math.max(0, Number($('set-threshold').value) || 0),
    theme: $('set-theme').value,
    alwaysOnTop: $('set-ontop').checked,
    autoLaunch: $('set-autostart').checked,
    creaseShadow: $('set-crease').checked,
  };
  const keyChanged = patch.apiKey !== state.config.apiKey;
  state.config = await window.ds.updateConfig(patch);
  applyTheme(state.config.theme);
  restartTimer();
  hideSettings();
  if (keyChanged || !state.balance) refresh(true);
}

async function testConnection() {
  const key = $('set-api-key').value.trim();
  if (!key) {
    $('test-result').textContent = '请先填入 API Key';
    return;
  }
  $('test-result').textContent = '测试中…';
  const savedKey = state.config.apiKey;
  const res = key === savedKey
    ? await window.ds.fetchBalance()
    : await window.ds.updateConfig({ apiKey: key }).then(() => window.ds.fetchBalance());
  if (res.ok) {
    const infos = res.data?.balance_infos || [];
    const total = infos[0]?.total_balance;
    $('test-result').textContent = `连接成功，余额 ${total ?? '未知'}`;
  } else {
    $('test-result').textContent = errorText(res.code, res.status);
  }
}

/* ---------- 事件绑定 ---------- */

function bindEvents() {
  $('btn-refresh').addEventListener('click', () => refresh(true));
  $('btn-mini').addEventListener('click', () => window.ds.updateConfig({ mode: 'mini' }));
  $('btn-collapse').addEventListener('click', () => window.ds.updateConfig({ mode: 'dot' }));
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-mini-settings').addEventListener('click', openSettings);
  $('btn-back').addEventListener('click', () => hideSettings());
  $('btn-expand').addEventListener('click', () => window.ds.updateConfig({ mode: 'card' }));
  $('btn-save').addEventListener('click', saveSettings);
  $('btn-test').addEventListener('click', testConnection);
  $('btn-reset').addEventListener('click', async () => {
    state.config = await window.ds.updateConfig({ apiKey: '' });
    state.balance = null;
    fillSettings();
    renderBalance();
    hideSettings();
  });
  $('btn-toggle-key').addEventListener('click', () => {
    const input = $('set-api-key');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('btn-toggle-key').textContent = show ? '隐藏' : '显示';
  });

  // 三种形态：任意非按钮区域均可拖动窗口
  const interactiveSel = 'button, input, select, label';
  makeDraggable($('card'), { skip: interactiveSel, cloth: true });
  makeDraggable($('mini'), { skip: interactiveSel, cloth: true, onClick: () => window.ds.updateConfig({ mode: 'card' }) });
  makeDraggable($('dot'), { onClick: () => window.ds.updateConfig({ mode: 'card' }) });

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.ds.showContextMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('settings').classList.contains('hidden')) {
      hideSettings();
    }
  });

  window.ds.onMenuAction((action) => {
    if (action === 'refresh') refresh(true);
    else if (action === 'settings') openSettings();
  });

  window.ds.onModeChanged((mode) => {
    // 设置页只适合完整卡片尺寸：切换到其他形态时先关闭设置页
    if (mode !== 'card' && settingsOpen) {
      settingsOpen = false;
      $('settings').classList.add('hidden');
    }
    // 形态切换时终止布料动效，避免画布尺寸错位
    if (window.ClothFX) window.ClothFX.stop();
    document.querySelectorAll('.cloth-active').forEach((el) => el.classList.remove('cloth-active'));
    applyMode(mode);
  });
}

/* ---------- 启动 ---------- */

async function init() {
  state.config = await window.ds.getConfig();
  applyTheme(state.config.theme);
  bindEvents();
  fillSettings();
  applyMode(state.config.mode || 'card');
  restartTimer();
  renderBalance();
  refresh(true);
}

init();
