const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  Notification,
  screen,
} = require('electron');
const path = require('path');
const fs = require('fs');

// 窗口比卡片大一圈，四周留 14px 透明边距：布料网格可完整覆盖卡片，
// 甩动位移有足够余量，不会被窗口边缘裁切，也不会露出透明缝隙
const CARD_W = 356;
const CARD_H = 248;
const MINI_W = 216;
const MINI_H = 88;
const DOT_W = 74;
const DOT_H = 74;
const SIZES = {
  card: [CARD_W, CARD_H],
  mini: [MINI_W, MINI_H],
  dot: [DOT_W, DOT_H],
};
// 默认走官方接口；DS_BALANCE_API 环境变量可用于本地测试/代理
const BALANCE_API = process.env.DS_BALANCE_API || 'https://api.deepseek.com/user/balance';

const DEFAULT_CONFIG = {
  apiKey: '',
  refreshInterval: 5 * 60 * 1000, // 默认 5 分钟
  lowBalanceThreshold: 10,        // 默认 ¥10 预警
  theme: 'dark',
  alwaysOnTop: true,
  autoLaunch: false,
  mode: 'card',                   // card | mini | dot
  pos: null,                      // { x, y }
};

let config = { ...DEFAULT_CONFIG };
let win = null;
let tray = null;
let quitting = false;
let positionSaveTimer = null;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    if (fs.existsSync(configPath())) {
      const raw = fs.readFileSync(configPath(), 'utf-8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      config = { ...DEFAULT_CONFIG, ...parsed };
      // 旧版本兼容：collapsed:true 迁移为圆点模式
      if (parsed.collapsed) config.mode = 'dot';
    }
  } catch (err) {
    console.error('读取配置失败，使用默认配置:', err.message);
  }
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('保存配置失败:', err.message);
  }
}

function defaultPosition() {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width - CARD_W - 24,
    y: area.y + area.height - CARD_H - 24,
  };
}

// 防止保存的位置落在已断开/变更的显示器上导致窗口不可见
function ensurePosOnScreen(pos) {
  if (!pos) return null;
  const displays = screen.getAllDisplays();
  const onScreen = displays.some((d) => {
    const wa = d.workArea;
    return (
      pos.x + 40 < wa.x + wa.width &&
      pos.y + 40 < wa.y + wa.height &&
      pos.x + 40 > wa.x &&
      pos.y + 40 > wa.y
    );
  });
  return onScreen ? pos : null;
}

function createWindow() {
  const pos = ensurePosOnScreen(config.pos) || defaultPosition();
  const [w, h] = SIZES[config.mode] || SIZES.card;
  win = new BrowserWindow({
    width: w,
    height: h,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(config.alwaysOnTop, 'floating');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 内部调试：--smoke 启动后输出渲染层 DOM 快照并退出
  if (process.argv.includes('--smoke')) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const snapshot = await win.webContents.executeJavaScript(`(async () => {
            const $ = (id) => document.getElementById(id);
            const cs = (el) => el ? getComputedStyle(el) : null;
            const card = $('card');
            const cardCs = cs(card);
            const main = {
              windowSize: [window.innerWidth, window.innerHeight],
              theme: document.body.dataset.theme,
              cardVisible: card ? !card.classList.contains('hidden') : false,
              cardBackground: cardCs ? cardCs.backgroundColor : null,
              cardRadius: cardCs ? cardCs.borderRadius : null,
              balanceMain: $('balance-main') ? $('balance-main').textContent : null,
              breakdown: $('balance-breakdown') ? $('balance-breakdown').textContent : null,
              statusText: $('status-text') ? $('status-text').textContent : null,
              statusDotClass: $('status-dot') ? $('status-dot').className : null,
              dotText: $('dot-balance') ? $('dot-balance').textContent : null,
              dotClass: $('dot') ? $('dot').className : null,
              progressWidth: $('progress-fill') ? $('progress-fill').style.width : null,
              progressBg: $('progress-fill') ? $('progress-fill').style.background : null,
              balanceColor: $('balance-main') ? $('balance-main').style.color : null,
            };
            $('btn-settings').click();
            await new Promise((r) => setTimeout(r, 300));
            const styleOf = (el) => el ? ({
              color: getComputedStyle(el).color,
              bg: getComputedStyle(el).backgroundColor,
            }) : null;
            const sel = $('set-interval');
            const opt = sel ? sel.options[sel.selectedIndex] : null;
            return {
              ...main,
              settingsVisible: $('settings') ? !$('settings').classList.contains('hidden') : false,
              apiKeyMasked: $('set-api-key') ? $('set-api-key').type : null,
              apiKeyValue: $('set-api-key') ? $('set-api-key').value : null,
              intervalValue: $('set-interval') ? $('set-interval').value : null,
              thresholdValue: $('set-threshold') ? $('set-threshold').value : null,
              themeValue: $('set-theme') ? $('set-theme').value : null,
              ontopChecked: $('set-ontop') ? $('set-ontop').checked : null,
              autostartChecked: $('set-autostart') ? $('set-autostart').checked : null,
              contrast: {
                select: styleOf(sel),
                option: opt ? { ...styleOf(opt), text: opt.text } : null,
                input: styleOf($('set-api-key')),
                checkLabel: styleOf($('set-ontop') ? $('set-ontop').parentElement : null),
                fieldLabel: styleOf(sel ? sel.previousElementSibling : null),
              },
            };
          })()`);
          console.log('[smoke]', JSON.stringify(snapshot));
          // 设置页必须真实可见：卡片隐藏、设置面板位于窗口内
          const settingsLayout = await win.webContents.executeJavaScript(`(() => {
            const card = document.getElementById('card');
            const settings = document.getElementById('settings');
            const r = settings.getBoundingClientRect();
            return {
              cardHidden: card.classList.contains('hidden'),
              settingsInWindow: r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.width > 0,
              settingsTop: Math.round(r.top),
              settingsBottom: Math.round(r.bottom),
              winH: window.innerHeight,
            };
          })()`);
          console.log('[smoke-settingslayout]', JSON.stringify(settingsLayout));
          await win.webContents.executeJavaScript(`document.getElementById('btn-back').click()`);
          await new Promise((r) => setTimeout(r, 300));
          const stateAfterBack = await win.webContents.executeJavaScript(`(() => {
            const $ = (id) => document.getElementById(id);
            return {
              cardHidden: $('card').classList.contains('hidden'),
              settingsHidden: $('settings').classList.contains('hidden'),
            };
          })()`);
          console.log('[smoke-back]', JSON.stringify(stateAfterBack));
          // 截图贴图：验证 capturePage 保留透明背景，卡片内容可用作布料纹理
          const captureTest = await win.webContents.executeJavaScript(`(async () => {
            const src = await window.ds.capture({ x: 14, y: 14, width: 328, height: 220 });
            if (!src) return { ok: false };
            const img = new Image();
            await new Promise((resolve, reject) => {
              img.onload = resolve;
              img.onerror = reject;
              img.src = src;
            });
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const px = (x, y) => {
              const d = ctx.getImageData(x, y, 1, 1).data;
              return [d[0], d[1], d[2], d[3]];
            };
            return {
              ok: true,
              size: [img.width, img.height],
              corner: px(2, 2),
              center: px(Math.floor(img.width / 2), Math.floor(img.height / 2)),
              body: px(200, 350),
            };
          })()`);
          console.log('[smoke-capture]', JSON.stringify(captureTest));
          // 卡片非按钮区域真实拖拽
          const cardRect = await win.webContents.executeJavaScript(`(() => {
            const r = document.getElementById('card').getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          })()`);
          const cp0 = win.getPosition();
          win.webContents.sendInputEvent({ type: 'mouseDown', x: cardRect.x, y: cardRect.y, button: 'left' });
          await new Promise((r) => setTimeout(r, 900));
          const clothDuring = await win.webContents.executeJavaScript(`(() => {
            const card = document.getElementById('card');
            const canvas = document.getElementById('cloth-canvas');
            const cr = canvas.getBoundingClientRect();
            const debug = window.ClothFX ? window.ClothFX.debug() : null;
            const ctx = canvas.getContext('2d');
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let opaque = 0, n = 0, sum = 0, sum2 = 0;
            let shadeFringeCalm = 0;
            const bottomRows = [];
            let leftLum = 0, leftN = 0, rightLum = 0, rightN = 0;
            const grid = [];
            const G = 8;
            const asciiRows = [];
            const ACOLS = 56, AROWS = 24;
            const chars = ' .:-=+*#%@';
            for (let ay = 0; ay < AROWS; ay++) {
              let line = '';
              for (let ax = 0; ax < ACOLS; ax++) {
                let lum = 0, cnt = 0;
                for (let y = Math.floor(ay * canvas.height / AROWS); y < Math.floor((ay + 1) * canvas.height / AROWS); y++) {
                  for (let x = Math.floor(ax * canvas.width / ACOLS); x < Math.floor((ax + 1) * canvas.width / ACOLS); x++) {
                    const i = (y * canvas.width + x) * 4;
                    if (img[i + 3] > 10) {
                      lum += 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
                      cnt++;
                    }
                  }
                }
                const avg = cnt ? lum / cnt : -1;
                line += avg < 0 ? ' ' : chars[Math.min(chars.length - 1, Math.floor((avg / 255) * (chars.length - 1)))];
              }
              asciiRows.push(line);
            }
            for (let gy = 0; gy < G; gy++) {
              const row = [];
              for (let gx = 0; gx < G; gx++) {
                let aSum = 0, cnt = 0;
                for (let y = Math.floor(gy * canvas.height / G); y < Math.floor((gy + 1) * canvas.height / G); y++) {
                  for (let x = Math.floor(gx * canvas.width / G); x < Math.floor((gx + 1) * canvas.width / G); x++) {
                    aSum += img[(y * canvas.width + x) * 4 + 3];
                    cnt++;
                  }
                }
                row.push(Math.round(aSum / cnt));
              }
              grid.push(row.join(' '));
            }
            for (let i = 0; i < img.length; i += 4) {
              if (img[i + 3] > 10) {
                opaque++;
                const lum = 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
                sum += lum; sum2 += lum * lum; n++;
              }
            }
            // 左右明暗对比：取样卡片左右两侧区域的平均亮度
            for (let y = Math.floor(canvas.height * 0.15); y < Math.floor(canvas.height * 0.85); y++) {
              for (let x = Math.floor(canvas.width * 0.25); x < Math.floor(canvas.width * 0.40); x++) {
                const j = (y * canvas.width + x) * 4;
                if (img[j + 3] > 10) {
                  leftLum += 0.299 * img[j] + 0.587 * img[j + 1] + 0.114 * img[j + 2];
                  leftN++;
                }
              }
              for (let x = Math.floor(canvas.width * 0.60); x < Math.floor(canvas.width * 0.75); x++) {
                const j = (y * canvas.width + x) * 4;
                if (img[j + 3] > 10) {
                  rightLum += 0.299 * img[j] + 0.587 * img[j + 1] + 0.114 * img[j + 2];
                  rightN++;
                }
              }
            }
            for (let y = Math.floor(canvas.height * 0.86); y < canvas.height; y++) {
              for (let x = Math.floor(canvas.width * 0.85); x < canvas.width; x++) {
                const j = (y * canvas.width + x) * 4;
                const a = img[j + 3];
                const lum = 0.299 * img[j] + 0.587 * img[j + 1] + 0.114 * img[j + 2];
                if (a >= 20 && a < 230 && lum < 60) shadeFringeCalm++;
              }
            }
            for (const cssY of [192, 200, 208, 214]) {
              const row = [];
              const y = Math.round(cssY * canvas.height / canvas.getBoundingClientRect().height);
              for (let x = 100; x < 320; x += 55) {
                const j = (y * canvas.width + x * (canvas.width / canvas.getBoundingClientRect().width)) * 4;
                const a = img[j + 3];
                const lum = 0.299 * img[j] + 0.587 * img[j + 1] + 0.114 * img[j + 2];
                row.push(x + ':' + a + '/' + Math.round(lum));
              }
              bottomRows.push('y' + cssY + ':' + row.join(' '));
            }
            return {
              active: window.ClothFX ? window.ClothFX.isActive() : false,
              canvasShown: canvas.style.display !== 'none',
              canvasRect: {
                top: Math.round(cr.top), bottom: Math.round(cr.bottom),
                left: Math.round(cr.left), right: Math.round(cr.right),
                w: Math.round(cr.width), h: Math.round(cr.height),
              },
              canvasInsideWindow: cr.top >= 0 && cr.left >= 0 &&
                cr.right <= window.innerWidth + 1 && cr.bottom <= window.innerHeight + 1,
              cardOpacity: getComputedStyle(card).opacity,
              cardClothActive: card.classList.contains('cloth-active'),
              debug,
              pixels: {
                opaqueRatio: n ? +(opaque / (canvas.width * canvas.height)).toFixed(3) : 0,
                avgLum: n ? +(sum / n).toFixed(1) : null,
                lumStd: n ? +Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2)).toFixed(1) : null,
                alphaGrid: grid,
                ascii: asciiRows,
                shadeFringeCalm,
                bottomRows,
                sideLum: {
                  left: leftN ? +(leftLum / leftN).toFixed(1) : null,
                  right: rightN ? +(rightLum / rightN).toFixed(1) : null,
                },
              },
            };
          })()`);
          console.log('[smoke-cloth]', JSON.stringify(clothDuring));
          try {
            const paperImg = await win.webContents.capturePage();
            fs.writeFileSync(
              path.join(__dirname, 'assets', 'screenshot-cloth.png'),
              paperImg.toPNG()
            );
            console.log('[smoke] cloth screenshot saved');
          } catch (err) {
            console.error('[smoke] cloth 截图失败:', err.message);
          }
          // 拖动耦合：模拟快速向右上甩动，布面应向左下滞后（惯性反推力）
          await win.webContents.executeJavaScript(`(async () => {
            for (let i = 0; i < 6; i++) {
              window.ClothFX.setDrag(2.0, -1.0, 0.03, -0.015);
              await new Promise((r) => setTimeout(r, 30));
            }
          })()`);
          await new Promise((r) => setTimeout(r, 200));
          const clothDrag = await win.webContents.executeJavaScript(`(() => {
            const canvas = document.getElementById('cloth-canvas');
            const cw = canvas.width;
            const ch = canvas.height;
            const img = canvas.getContext('2d').getImageData(0, 0, cw, ch).data;
            // 合成探针：验证 source-atop 在 Chromium 中是否保留目标 alpha
            const pt = document.createElement('canvas');
            pt.width = 4; pt.height = 1;
            const pc = pt.getContext('2d');
            pc.fillStyle = 'rgba(255, 0, 0, 1)';
            pc.fillRect(0, 0, 4, 1);
            pc.globalCompositeOperation = 'source-atop';
            pc.fillStyle = 'rgba(0, 0, 0, 0.5)';
            pc.fillRect(0, 0, 4, 1);
            const pd = pc.getImageData(0, 0, 1, 1).data;
            const compositeProbe = [pd[0], pd[1], pd[2], pd[3]];
            let opaque = 0;
            let shadeFringe = 0;
            const fringeSamples = [];
            for (let i = 3; i < img.length; i += 4) {
              if (img[i] > 10) opaque++;
            }
            // 右下角象限：统计"只有阴影、没有卡片"的半透明暗像素（布料轮廓裁剪的残影）
            for (let y = Math.floor(ch * 0.86); y < ch; y++) {
              for (let x = Math.floor(cw * 0.85); x < cw; x++) {
                const j = (y * cw + x) * 4;
                const a = img[j + 3];
                const lum = 0.299 * img[j] + 0.587 * img[j + 1] + 0.114 * img[j + 2];
                if (a >= 20 && a < 230 && lum < 60) {
                  shadeFringe++;
                  if (fringeSamples.length < 5) {
                    fringeSamples.push({ x, y, a, rgb: [img[j], img[j + 1], img[j + 2]], lum: Math.round(lum) });
                  }
                }
              }
            }
            return {
              debug: window.ClothFX ? window.ClothFX.debug() : null,
              opaqueRatio: +(opaque / (canvas.width * canvas.height)).toFixed(3),
              shadeFringe,
              fringeSamples,
              compositeProbe,
            };
          })()`);
          console.log('[smoke-cloth-drag]', JSON.stringify(clothDrag));
          for (let i = 1; i <= 6; i++) {
            win.webContents.sendInputEvent({ type: 'mouseMove', x: cardRect.x + i * 4, y: cardRect.y + i * 2, button: 'left' });
            await new Promise((r) => setTimeout(r, 30));
          }
          win.webContents.sendInputEvent({ type: 'mouseUp', x: cardRect.x + 24, y: cardRect.y + 12, button: 'left' });
          await new Promise((r) => setTimeout(r, 500));
          const settleAfter = await win.webContents.executeJavaScript(
            `document.getElementById('card').classList.contains('settle')`
          );
          const clothAfter = await win.webContents.executeJavaScript(`(() => {
            const card = document.getElementById('card');
            const canvas = document.getElementById('cloth-canvas');
            return {
              active: window.ClothFX ? window.ClothFX.isActive() : false,
              canvasShown: canvas.style.display !== 'none',
              cardOpacity: getComputedStyle(card).opacity,
              cardClothActive: card.classList.contains('cloth-active'),
            };
          })()`);
          const cp1 = win.getPosition();
          const cardDragOk = await win.webContents.executeJavaScript(
            `document.getElementById('settings').classList.contains('hidden') && !document.getElementById('card').classList.contains('hidden')`
          );
          console.log('[smoke-carddrag] moved:', cp1[0] - cp0[0], cp1[1] - cp0[1], 'viewOk:', cardDragOk, 'cloth:', JSON.stringify(clothAfter), 'settle:', settleAfter);
          // 用真实输入事件点击设置按钮，验证命中区域（区别于 element.click()）
          const btnRect = await win.webContents.executeJavaScript(`(() => {
            const r = document.getElementById('btn-settings').getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          })()`);
          win.webContents.sendInputEvent({ type: 'mouseDown', x: btnRect.x, y: btnRect.y, button: 'left', clickCount: 1 });
          win.webContents.sendInputEvent({ type: 'mouseUp', x: btnRect.x, y: btnRect.y, button: 'left', clickCount: 1 });
          await new Promise((r) => setTimeout(r, 500));
          const settingsOpened = await win.webContents.executeJavaScript(
            `!document.getElementById('settings').classList.contains('hidden')`
          );
          console.log('[smoke-click] settings opened by real click:', settingsOpened);
          if (!settingsOpened) {
            await win.webContents.executeJavaScript(`document.getElementById('btn-back').click()`);
          }
          const deltaTest = await win.webContents.executeJavaScript(`(async () => {
            document.getElementById('btn-refresh').click();
            await new Promise((r) => setTimeout(r, 1200));
            const badge = document.querySelector('.delta-badge');
            const bal = document.getElementById('balance-main');
            return {
              balance: bal ? bal.textContent : null,
              balanceRight: bal ? Math.round(bal.getBoundingClientRect().right) : null,
              badgeText: badge ? badge.textContent : null,
              badgeLeft: badge ? Math.round(badge.getBoundingClientRect().left) : null,
              badgeClass: badge ? badge.className : null,
            };
          })()`);
          console.log('[smoke-delta]', JSON.stringify(deltaTest));
          try {
            const image = await win.webContents.capturePage();
            fs.writeFileSync(
              path.join(__dirname, 'assets', 'screenshot-settings.png'),
              image.toPNG()
            );
            console.log('[smoke] settings screenshot saved');
          } catch (err) {
            console.error('[smoke] 截图失败:', err.message);
          }
          try {
            const mini = await win.webContents.executeJavaScript(`(async () => {
              document.getElementById('btn-back').click();
              await new Promise((r) => setTimeout(r, 200));
              await window.ds.updateConfig({ mode: 'mini' });
              await new Promise((r) => setTimeout(r, 500));
              const $ = (id) => document.getElementById(id);
              const miniEl = $('mini');
              return {
                windowSize: [window.innerWidth, window.innerHeight],
                miniVisible: miniEl ? !miniEl.classList.contains('hidden') : false,
                cardHidden: $('card') ? $('card').classList.contains('hidden') : null,
                miniBalance: $('mini-balance') ? $('mini-balance').textContent : null,
                miniStatus: $('mini-status') ? $('mini-status').textContent : null,
                miniColor: $('mini-balance') ? $('mini-balance').style.color : null,
              };
            })()`);
            console.log('[smoke-mini]', JSON.stringify(mini), 'pos:', JSON.stringify(win.getPosition()));
            const img2 = await win.webContents.capturePage();
            fs.writeFileSync(
              path.join(__dirname, 'assets', 'screenshot-mini.png'),
              img2.toPNG()
            );
            console.log('[smoke] mini screenshot saved');
            await win.webContents.executeJavaScript(`window.ds.updateConfig({ mode: 'card' })`);
            const dot = await win.webContents.executeJavaScript(`(async () => {
              await window.ds.updateConfig({ mode: 'dot' });
              await new Promise((r) => setTimeout(r, 400));
              const $ = (id) => document.getElementById(id);
              return {
                windowSize: [window.innerWidth, window.innerHeight],
                dotVisible: $('dot') ? !$('dot').classList.contains('hidden') : false,
                dotText: $('dot-balance') ? $('dot-balance').textContent : null,
              };
            })()`);
            console.log('[smoke-dot]', JSON.stringify(dot), 'pos:', JSON.stringify(win.getPosition()));
            try {
              const dotImg = await win.webContents.capturePage();
              fs.writeFileSync(
                path.join(__dirname, 'assets', 'screenshot-dot.png'),
                dotImg.toPNG()
              );
              console.log('[smoke] dot screenshot saved');
            } catch (err) {
              console.error('[smoke] dot 截图失败:', err.message);
            }
            // 在圆点形态下模拟真实鼠标拖拽
            const dotRect = await win.webContents.executeJavaScript(`(() => {
              const r = document.getElementById('dot').getBoundingClientRect();
              return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
            })()`);
            const dp0 = win.getPosition();
            win.webContents.sendInputEvent({ type: 'mouseDown', x: dotRect.cx, y: dotRect.cy, button: 'left' });
            for (let i = 1; i <= 8; i++) {
              win.webContents.sendInputEvent({ type: 'mouseMove', x: dotRect.cx + i * 5, y: dotRect.cy + i * 3, button: 'left' });
              await new Promise((r) => setTimeout(r, 30));
            }
            win.webContents.sendInputEvent({ type: 'mouseUp', x: dotRect.cx + 40, y: dotRect.cy + 24, button: 'left' });
            await new Promise((r) => setTimeout(r, 400));
            const dp1 = win.getPosition();
            const stillDot = await win.webContents.executeJavaScript(
              `!document.getElementById('dot').classList.contains('hidden')`
            );
            console.log('[smoke-dotdrag] moved:', dp1[0] - dp0[0], dp1[1] - dp0[1], 'stillDot:', stillDot);
            await win.webContents.executeJavaScript(`window.ds.updateConfig({ mode: 'card' })`);
            const posBefore = win.getPosition();
            await win.webContents.executeJavaScript(`window.ds.moveTo(${posBefore[0] + 37}, ${posBefore[1] + 23})`);
            await new Promise((r) => setTimeout(r, 300));
            const posAfter = win.getPosition();
            console.log('[smoke-drag] moveBy delta:', posAfter[0] - posBefore[0], posAfter[1] - posBefore[1]);
            const settingsSwitch = await win.webContents.executeJavaScript(`(async () => {
              document.getElementById('btn-settings').click();
              await new Promise((r) => setTimeout(r, 300));
              return { settingsVisible: !document.getElementById('settings').classList.contains('hidden') };
            })()`);
            setWindowMode('mini');
            await new Promise((r) => setTimeout(r, 500));
            const afterMini = await win.webContents.executeJavaScript(`(async () => {
              const $ = (id) => document.getElementById(id);
              return {
                windowSize: [window.innerWidth, window.innerHeight],
                settingsHidden: $('settings').classList.contains('hidden'),
                miniVisible: !$('mini').classList.contains('hidden'),
              };
            })()`);
            console.log('[smoke-switch] settings-open switch:', JSON.stringify({
              settingsWasVisible: settingsSwitch.settingsVisible,
              ...afterMini,
              winSize: win.getSize(),
              pos: win.getPosition(),
            }));
            // 从迷你卡片点击设置按钮
            await win.webContents.executeJavaScript(`document.getElementById('btn-mini-settings').click()`);
            await new Promise((r) => setTimeout(r, 500));
            const miniSettings = await win.webContents.executeJavaScript(`(() => {
              const $ = (id) => document.getElementById(id);
              return {
                settingsVisible: !$('settings').classList.contains('hidden'),
                winW: window.innerWidth,
              };
            })()`);
            console.log('[smoke-minisettings]', JSON.stringify(miniSettings));
            setWindowMode('card');
            await new Promise((r) => setTimeout(r, 300));
            console.log('[smoke-switch] back to card pos:', JSON.stringify(win.getPosition()), 'size:', JSON.stringify(win.getSize()));
            // 迷你卡片布料动效：按住迷你卡片应进入布料模拟，松手后停止并展开
            await win.webContents.executeJavaScript(`window.ds.updateConfig({ mode: 'mini' })`);
            await new Promise((r) => setTimeout(r, 500));
            const miniRect2 = await win.webContents.executeJavaScript(`(() => {
              const r = document.getElementById('mini').getBoundingClientRect();
              return { x: Math.round(r.x + r.width * 0.45), y: Math.round(r.y + r.height / 2) };
            })()`);
            win.webContents.sendInputEvent({ type: 'mouseDown', x: miniRect2.x, y: miniRect2.y, button: 'left' });
            await new Promise((r) => setTimeout(r, 700));
            const miniCloth = await win.webContents.executeJavaScript(`(() => {
              const mini = document.getElementById('mini');
              const canvas = document.getElementById('cloth-canvas');
              const debug = window.ClothFX ? window.ClothFX.debug() : null;
              return {
                active: window.ClothFX ? window.ClothFX.isActive() : false,
                canvasShown: canvas.style.display !== 'none',
                miniOpacity: getComputedStyle(mini).opacity,
                debug,
              };
            })()`);
            console.log('[smoke-minicloth]', JSON.stringify(miniCloth));
            win.webContents.sendInputEvent({ type: 'mouseUp', x: miniRect2.x, y: miniRect2.y, button: 'left' });
            await new Promise((r) => setTimeout(r, 400));
            const miniClothAfter = await win.webContents.executeJavaScript(`(() => {
              const canvas = document.getElementById('cloth-canvas');
              return {
                active: window.ClothFX ? window.ClothFX.isActive() : false,
                canvasShown: canvas.style.display !== 'none',
                cardShown: !document.getElementById('card').classList.contains('hidden'),
              };
            })()`);
            console.log('[smoke-minicloth-after]', JSON.stringify(miniClothAfter));
            await win.webContents.executeJavaScript(`window.ds.updateConfig({ mode: 'card' })`);
            await new Promise((r) => setTimeout(r, 300));
          } catch (err) {
            console.error('[smoke] mini 检查失败:', err.message);
          }
        } catch (err) {
          console.error('[smoke] 快照失败:', err.message);
        } finally {
          app.exit(0);
        }
      }, 4000);
    });
  }

  // 拖动后记住位置（折叠状态时不记录，避免被 resize 干扰）
  win.on('moved', () => {
    if (config.mode === 'dot') return;
    clearTimeout(positionSaveTimer);
    positionSaveTimer = setTimeout(() => {
      const [x, y] = win.getPosition();
      config.pos = { x, y };
      saveConfig();
    }, 300);
  });

  // 关闭按钮 → 隐藏到托盘而不是退出
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function setWindowMode(mode) {
  if (!SIZES[mode]) mode = 'card';
  config.mode = mode;
  saveConfig();
  if (!win) return;
  const [x, y] = win.getPosition();
  const [oldW, oldH] = win.getSize();
  const [w, h] = SIZES[mode];
  // 保持窗口中心点不变，切换形态时不“跳”
  // 注意：Windows 上 setPosition+setSize 分两次调用时 setSize 可能被吞掉，
  // 必须用 setBounds 一次性设置位置和尺寸
  win.setBounds({
    x: Math.round(x + (oldW - w) / 2),
    y: Math.round(y + (oldH - h) / 2),
    width: w,
    height: h,
  });
  win.webContents.send('mode:changed', mode);
}

function setAlwaysOnTopFlag(value) {
  config.alwaysOnTop = value;
  saveConfig();
  if (win) win.setAlwaysOnTop(value, 'floating');
}

function setAutoLaunch(value) {
  config.autoLaunch = value;
  saveConfig();
  app.setLoginItemSettings({ openAtLogin: value });
}

function buildTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'tray.png'));
  tray.setToolTip('DeepSeek 余额卡片');
  const menu = Menu.buildFromTemplate([
    { label: '显示卡片', click: () => { if (win) { win.show(); win.focus(); } } },
    { label: '迷你卡片', click: () => { setWindowMode('mini'); if (win) { win.show(); win.focus(); } } },
    { label: '立即刷新', click: () => win && win.webContents.send('menu:action', 'refresh') },
    {
      label: '打开设置',
      click: () => {
        if (win) { win.show(); win.focus(); }
        win && win.webContents.send('menu:action', 'settings');
      },
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: config.autoLaunch,
      click: (item) => setAutoLaunch(item.checked),
    },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: config.alwaysOnTop,
      click: (item) => setAlwaysOnTopFlag(item.checked),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else { win.show(); win.focus(); }
  });
}

function showCardMenu() {
  if (!win) return;
  const menu = Menu.buildFromTemplate([
    { label: '立即刷新', click: () => win.webContents.send('menu:action', 'refresh') },
    { label: '设置', click: () => win.webContents.send('menu:action', 'settings') },
    { type: 'separator' },
    ...(config.mode !== 'card' ? [{ label: '展开完整卡片', click: () => setWindowMode('card') }] : []),
    ...(config.mode !== 'mini' ? [{ label: '切换迷你卡片', click: () => setWindowMode('mini') }] : []),
    ...(config.mode !== 'dot' ? [{ label: '折叠为圆点', click: () => setWindowMode('dot') }] : []),
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: config.autoLaunch,
      click: (item) => setAutoLaunch(item.checked),
    },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: config.alwaysOnTop,
      click: (item) => setAlwaysOnTopFlag(item.checked),
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  menu.popup({ window: win });
}

async function fetchBalance() {
  if (!config.apiKey) {
    return { ok: false, code: 'NO_KEY' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(BALANCE_API, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    });
    if (res.status === 401) {
      return { ok: false, code: 'UNAUTHORIZED' };
    }
    if (!res.ok) {
      return { ok: false, code: 'HTTP', status: res.status };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, code: 'TIMEOUT' };
    }
    return { ok: false, code: 'NETWORK' };
  } finally {
    clearTimeout(timer);
  }
}

function registerIpc() {
  ipcMain.handle('config:get', () => ({ ...config }));

  ipcMain.handle('config:update', (_e, patch) => {
    if (typeof patch !== 'object' || patch === null) return { ...config };
    const old = { ...config };
    config = { ...config, ...patch };
    saveConfig();

    if (patch.alwaysOnTop !== undefined && patch.alwaysOnTop !== old.alwaysOnTop) {
      setAlwaysOnTopFlag(patch.alwaysOnTop);
    }
    if (patch.autoLaunch !== undefined && patch.autoLaunch !== old.autoLaunch) {
      setAutoLaunch(patch.autoLaunch);
    }
    if (patch.mode !== undefined && patch.mode !== old.mode) {
      setWindowMode(patch.mode);
    } else if (patch.collapsed !== undefined && patch.collapsed !== old.collapsed) {
      setWindowMode(patch.collapsed ? 'dot' : 'card');
    }
    return { ...config };
  });

  ipcMain.handle('balance:fetch', () => fetchBalance());

  // 抓取卡片区域的像素快照（保持透明背景），用于布料贴图
  ipcMain.handle('card:capture', async (_e, rect) => {
    if (!win) return null;
    try {
      const r = rect && typeof rect === 'object' ? rect : null;
      const img = await win.webContents.capturePage(r);
      if (!img || img.isEmpty()) return null;
      return img.toDataURL();
    } catch (err) {
      console.error('[capture] 截图失败:', err.message);
      return null;
    }
  });

  ipcMain.handle('app:quit', () => {
    quitting = true;
    app.quit();
  });

  ipcMain.handle('app:notify', (_e, title, body) => {
    if (Notification.isSupported()) {
      new Notification({ title: String(title), body: String(body) }).show();
    }
  });

  ipcMain.handle('window:hide', () => {
    if (win) win.hide();
  });

  ipcMain.handle('window:move-to', (_e, x, y) => {
    if (!win) return;
    win.setPosition(Math.round(x), Math.round(y));
  });

  ipcMain.handle('window:get-position', () => {
    if (!win) return { x: 0, y: 0 };
    const [x, y] = win.getPosition();
    return { x, y };
  });

  ipcMain.handle('window:move-by', (_e, dx, dy) => {
    if (!win) return;
    const [x, y] = win.getPosition();
    win.setPosition(x + Math.round(dx), y + Math.round(dy));
  });

  ipcMain.handle('card:context-menu', () => showCardMenu());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId('com.deepseek.balance-card');

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    loadConfig();
    // 始终以卡片形态启动；圆点状态只对当前会话生效，避免下次启动“找不到窗口”
    const forcedMode = process.env.DS_START_MODE;
    if (config.mode === 'dot' && !forcedMode) {
      config.mode = 'card';
      saveConfig();
    }
    if (forcedMode && SIZES[forcedMode]) {
      config.mode = forcedMode;
      saveConfig();
    }
    registerIpc();
    createWindow();
    buildTray();
    if (config.autoLaunch) {
      // 同步系统真实的开机自启状态
      const status = app.getLoginItemSettings();
      if (status.openAtLogin !== config.autoLaunch) {
        app.setLoginItemSettings({ openAtLogin: config.autoLaunch });
      }
    }
  });

  app.on('window-all-closed', () => {
    // 托盘驻留，不退出
  });

  app.on('activate', () => {
    if (win) { win.show(); win.focus(); }
  });
}
