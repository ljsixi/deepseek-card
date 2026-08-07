# DeepSeek 余额卡片

一块可以直接放在桌面上的 DeepSeek API 余额小卡片：半透明、可拖拽、始终置顶、可折叠成小圆点，还能在余额低于阈值时弹系统通知。

![卡片截图](assets/screenshot-card.png)

## 功能

- **余额查询**：调用 DeepSeek 官方接口 `GET https://api.deepseek.com/user/balance`，展示总余额、充值余额、赠送余额、币种与可用状态
- **自动刷新**：默认每 5 分钟，可在设置中调整为 10 秒 ~ 1 小时；余额变化时数字短暂高亮
- **余额变动动效**：每次刷新余额变化时，余额数字会向变化方向闪烁（涨绿跌红），并在数字右侧弹出带光晕的浮动金额标签（如 `-¥1.00` / `+¥0.50`），弹跳入场、上浮淡出，约 2 秒后消失
- **低余额预警**：低于阈值（默认 ¥10）时卡片变红并发送系统通知，只在状态切换时提醒一次
- **状态反馈**：加载中 / Key 无效（401）/ 网络错误 / 请求超时均有明确提示
- **三种形态**：完整卡片（356×248，卡片本体 328×220，四周留透明余量供布料甩动）→ 迷你卡片（216×88，只显示余额与状态）→ 小圆点（74×74），右上角按钮或右键菜单随时切换
- **卡片交互**：按住卡片任意非按钮区域拖动并记住位置（小圆点也支持直接拖动）；右键菜单含「展开完整卡片 / 切换迷你卡片 / 折叠为圆点 / 立即刷新 / 设置 / 开机自启 / 窗口置顶 / 退出」
- **布料抓取动效**：按住卡片时，卡片快照会被贴到一张 Verlet 布料物理模拟的布面上（质点-弹簧网格 + 阵风 + 柔光法线阴影 + 弹性边界），像被风吹动的窗帘一样鼓起真实褶皱；拖动的方向与速度会通过惯性反推力影响飘动（加速时滞后、减速时前甩、越快越飘），布料最多飘到窗口透明边距处被轻轻挡回，松手后平滑回弹
- **托盘驻留**：点关闭不退出，驻留系统托盘；支持开机自启、单实例防重复
- **主题**：深色 / 浅色一键切换

## 快速开始

环境要求：Windows 10/11，Node.js 18+（开发/运行均需要）。

### 方式一：双击启动（推荐）

双击 `start.bat`：首次运行会自动安装依赖，之后每次启动应用会直接以卡片形态出现在桌面（命令窗口随即关闭，卡片独立运行，驻留系统托盘）。

### 方式二：命令行

```bash
npm install
npm start
```

### 首次使用

1. 打开卡片右上角 **⚙ 设置**
2. 填入 DeepSeek API Key（在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 的「API Keys」页面创建）
3. 点「测试连接」确认 Key 有效，再点「保存」
4. 卡片随即显示余额，之后自动定时刷新

## 配置说明

配置文件位于 `%APPDATA%\deepseek-balance-card\config.json`，保存 API Key、刷新间隔、预警阈值、主题、窗口位置等。API Key 只存本机，不会出现在日志中。

| 字段 | 说明 | 默认值 |
| --- | --- | --- |
| `apiKey` | DeepSeek API Key | 空 |
| `refreshInterval` | 刷新间隔（毫秒，最小 10000） | 300000 |
| `lowBalanceThreshold` | 低余额预警阈值（¥） | 10 |
| `theme` | `dark` / `light` | `dark` |
| `alwaysOnTop` | 窗口是否置顶 | `true` |
| `autoLaunch` | 是否开机自启 | `false` |
| `mode` | 当前形态：`card` / `mini` / `dot`（重启后始终以卡片启动） | `card` |
| `pos` | 窗口位置 `{x, y}` | 屏幕右下角 |

## 可选：打包为独立 exe

一键启动脚本已满足日常使用；如需分发安装包，可自行加装 electron-builder：

```bash
npm i -D electron-builder
npx electron-builder --win portable
```

产物位于 `dist/`。注意 Windows 打包建议准备 `.ico` 图标（当前仓库提供 PNG 图标，仅用于窗口与托盘）。

## 开发者备注

- `scripts/mock-server.js`：本地 mock 余额接口，配合环境变量 `DS_BALANCE_API`（例如 `http://127.0.0.1:8899/user/balance`）可脱离官方接口开发调试
- `renderer/cloth.js`：Verlet 布料引擎（结构/剪切/弯曲约束、阵风、法线光照、拖动惯性耦合），把卡片快照按三角形精确仿射映射到网格上（相邻三角形共享边，无缝隙），产生抓取时的立体褶皱动效；`window.ClothFX` 暴露 `start/stop/setDrag/debug`
- `scripts/smoke.ps1`：自动化冒烟测试，输出渲染层 DOM 快照：
  ```powershell
  powershell -File scripts/smoke.ps1 -Balance 5.00   # 低余额场景
  powershell -File scripts/smoke.ps1 -Real           # 真实接口（无效 Key 预期 401）
  powershell -File scripts/smoke.ps1 -Collapsed      # 折叠圆点场景
  ```
- `scripts/visual-check.ps1`：启动应用并截图采样，验证卡片渲染与窗口位置
- `scripts/gen-icon.js`：纯 Node 重新生成图标（`npm run icon`）

## 安全说明

- 所有网络请求只发往 `api.deepseek.com`（或本地测试地址）
- API Key 仅保存在本机 `%APPDATA%` 配置中，不写入日志、不提交仓库
- 本应用非 DeepSeek 官方产品，仅供学习与日常使用
