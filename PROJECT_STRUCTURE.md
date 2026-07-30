# 專案結構說明

## 檔案樹

```
流程圖動畫工具/
│
├── index.html                    # 主介面 HTML
├── app.js                        # 主邏輯（全部前端功能）
├── styles.css                    # 樣式
├── parser.js                     # FlowParser：縮排文字 → 節點資料
├── installed-fonts.js            # Windows 已安裝字型清單（由 start.ps1 產生）
│
├── launch.bat                    # 主啟動器（雙擊執行，不需 PowerShell）
├── launch.py                     # 啟動邏輯：掃字型、安裝套件、啟伺服器、開瀏覽器
├── start.ps1                     # 舊版啟動腳本（PowerShell，備用）
├── resolve_export_server.py      # 本機 HTTP 伺服器（FFmpeg 轉檔、Whisper 辨識）
├── spacemouse_flow_bridge.py     # SpaceMouse HID → WebSocket 橋接（Windows）
├── run_spacemouse_flow_bridge.bat # 啟動 SpaceMouse 橋接器
├── 轉換Resolve相容影片.ps1       # 獨立的 DaVinci Resolve 影片轉換工具
│
├── test-parser.js                # 解析器單元測試（需 Node.js）
├── MEDIA_COMPOSITE_PLAN.md       # 參考媒體合成功能規劃文件
├── PROJECT_STRUCTURE.md          # 本文件
└── TECH_STACK.md                 # 技術棧與相關技能說明
```

---

## 各檔案說明

### `index.html`
單頁應用的 HTML 骨架，包含：
- 頂部工具列（檔案、媒體下拉選單、操作按鈕）
- 三欄佈局：左側工具區、中央畫布區、右側屬性區
- 下方時間軸面板
- 錄音 Modal（拖曳式浮動視窗）
- 所有 UI 元素的 `id` 屬性（由 `app.js` 透過 `$()` 綁定）

### `app.js`（~1380 行）
唯一的前端邏輯檔案，功能模組分區：

| 區段 | 功能 |
|---|---|
| State & constants | 全域狀態物件、Undo/Redo 堆疊、常數定義 |
| Node / Line building | 從解析結果建立節點與連線物件 |
| Layout | 自動排版演算法（分欄、均分） |
| Canvas rendering | SVG 產生、節點形狀、連線、動畫效果渲染 |
| Canvas interaction | 拖曳、框選、多選、連線模式、縮放、平移 |
| Timeline rendering | 軌道 HTML 產生、波形 Canvas 繪製 |
| Timeline interaction | 片段拖曳、邊緣縮放、音訊剪輯 |
| Properties panel | 屬性欄位雙向綁定 |
| Export | PNG 序列；MOV（ProRes）、MP4（H.264）透過 FFmpeg；均含音訊混合 |
| Recording modal | 麥克風錄音、預覽、剪輯、Whisper 辨識；錄音存為 base64 data URL |
| Media playback | 音訊／影片同步播放、JKL 穿梭 |
| SpaceMouse | WebSocket 連線與六軸映射 |
| Persistence | localStorage 自動保存、JSON 匯出入、版面快照 |

### `parser.js`
獨立的純函式模組（UMD 格式，可在 Node.js 與瀏覽器共用）。

**輸入格式：**
```
1.主節點
2.另一個主節點
  [錯誤：子節點必須用 Tab，不能用空白]
3.父節點
	3.1子節點
	3.2另一個子節點
		3.2.1孫節點
```

**輸出：**
```json
{
  "nodes": [
    { "number": "1", "text": "主節點", "parts": [1], "tabs": 0 },
    { "number": "3.1", "text": "子節點", "parts": [3, 1], "tabs": 1 }
  ],
  "errors": []
}
```

連線規則：
- 整數節點依序連線（1→2→3）
- 小數節點連到父節點（3.1、3.2 → 3）

### `styles.css`（~156 行）
Dark theme 為主，主要區塊：
- 全域重置與版面（flexbox 三欄 + 時間軸）
- 頂部工具列與下拉選單
- 左側面板、屬性面板
- 畫布區與 SVG 輔助線樣式
- 時間軸：軌道、片段（節點藍/線條橙）、播放頭
- 錄音 Modal 與各控制元件

### `resolve_export_server.py`
以 Python 標準庫 `http.server` 實作的本機 HTTP 伺服器，Port 8765。

| 端點 | 方法 | 功能 |
|---|---|---|
| `GET /api/health` | GET | 健康檢查（launch.bat 等待就緒用） |
| `GET /index.html` 等 | GET | 靜態檔案服務 |
| `POST /api/resolve-export` | POST | multipart 接收影片 + 可選音訊，FFmpeg 輸出 ProRes MOV 或 H.264 MP4（含音訊混合） |
| `POST /api/frame-export` | POST | 逐格 PNG 接收，輸出影片（MOV / MP4 / WebM） |
| `POST /api/transcribe-audio` | POST | 音訊送 faster-whisper，返回帶時間戳字幕 JSON |
| `POST /api/convert-audio` | POST | webm 轉 mp3/wav/aac（FFmpeg） |

`/api/resolve-export` 接收欄位：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `video` | binary | 瀏覽器 canvas.captureStream() 輸出的 WebM |
| `format` | text | `mov`（ProRes，預設）或 `mp4`（H.264） |
| `fps` | text | 影格率（1–60） |
| `audio` | binary | 音訊檔案（可選），有時才混音 |
| `audio_offset` | text | 音訊剪輯起點（秒），對應 `state.media.offset` |
| `audio_start` | text | 音訊在影片中的起始時間（秒），對應 `state.media.projectStart` |

### `spacemouse_flow_bridge.py`
Windows 專用的 HID 橋接器，Port 8766（WebSocket）。

工作流程：
1. 以 `ctypes` 呼叫 `user32.dll` 注冊 Raw Input 接收器
2. 建立隱藏視窗攔截 `WM_INPUT` 訊息
3. 解析 3Dconnexion HID 封包（Usage Page 0x01，Usage 0x08）
4. 將六軸資料（tx/ty/tz/rx/ry/rz）和按鈕狀態，透過 WebSocket 廣播給瀏覽器

### `launch.bat` + `launch.py`
主要啟動方式（雙擊 `launch.bat` 即可）。`.bat` 確認 Python 存在後呼叫 `launch.py`，執行順序：
1. 掃描 Windows Registry（`winreg` 標準庫）讀取已安裝字型，寫入 `installed-fonts.js`
2. `pip install --dry-run` 檢查缺少套件，若有則自動安裝
3. 確認 FFmpeg 是否在 PATH 中（僅警告，不阻止啟動）
4. 若 `/api/health` 未回應則以無視窗模式啟動 `resolve_export_server.py`
5. 等待伺服器就緒（最多 40 × 150ms）
6. 以 `--app=` 模式開啟 Chrome（優先）或 Edge，找不到則開預設瀏覽器

### `start.ps1`（舊版，備用）
PowerShell 啟動腳本，功能與 `launch.py` 相同，保留供 PowerShell 環境使用。

---

## 資料流

```
使用者輸入 .txt
      │
      ▼
  parser.js  ──→  節點物件陣列 + 連線陣列
      │
      ▼
  app.js state
  ┌─────────────────────────────────────┐
  │ nodes[]  lines[]  canvas{}          │
  │ timelineOrder[]  media{}            │
  │ subtitles[]  ui{}                   │
  └─────────────────────────────────────┘
      │               │               │
      ▼               ▼               ▼
  SVG 畫布       時間軸 HTML      屬性面板
  (renderCanvas) (renderTimeline) (renderProperties)
      │
      ▼
  輸出選項
  ├── PNG 序列 ZIP（瀏覽器端）
  ├── WebM（瀏覽器 MediaRecorder）
  └── MOV / MP4（Python 伺服器 + FFmpeg）
```

---

## 狀態物件結構（`state`）

```js
{
  sourceText: "",          // 匯入的原始文字
  nodes: [{
    id, number, text,
    x, y, width, height, radius,
    shape,                 // capsule | roundRect | rect | circle | ellipse
    fillMode,              // gradient | solid | none
    fill1, fill2, stroke, stroke2, strokeMode, strokeWidth,
    textColor, textStroke, textStrokeWidth, font, fontSize,
    start, duration,       // 時間軸動畫時間（秒）
    effect, easing
  }],
  lines: [{
    id, from, to,
    color, width, dash, type,   // straight | curve
    arrow, startMarker, endMarker, markerSize,
    startAnchor, endAnchor,     // { x: 0-1, y: 0-1 }
    controlPoints: [],
    start, duration, effect, easing, order
  }],
  canvas: {
    width, height,
    backgroundType,        // solid | gradient | image | transparent
    color1, color2, image
  },
  media: {                 // 匯入的音訊或影片
    type,                  // audio | video
    fileName, src,         // src 永遠為 data: URL（base64），可存入 localStorage
    duration, offset,      // 剪輯起點（秒）
    fileDuration,          // 原始音訊檔總長度（秒）
    projectStart,          // 在專案時間軸上的起始位置（秒）
    volume, muted,
    element,               // HTMLAudioElement / HTMLVideoElement（runtime only，不序列化）
    waveform: []           // 正規化振幅陣列（0-1，2000 個取樣）
  },
  subtitles: [{ id, start, end, text }],
  timelineOrder: [],       // 軌道顯示順序（id 陣列）
  selectedNodes: [],
  selectedLine: null,
  selectedTimelineItems: [],
  zoom: 0.55,
  playhead: 0,
  playing: false,
  ui: { leftWidth, rightWidth, timelineHeight, canvasPanX, canvasPanY }
}
```
