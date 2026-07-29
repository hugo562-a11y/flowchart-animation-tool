# 技術棧與相關技能

## 概覽

本工具為**零安裝、零 npm 依賴**的單頁網頁應用，搭配可選的 Python 後端。所有核心功能在瀏覽器內執行，後端只在需要 FFmpeg 輸出或 AI 語音辨識時才必要。

---

## 前端

### HTML5 / CSS3
- Flexbox 三欄佈局 + 固定時間軸面板
- CSS Grid 用於時間軸軌道排版
- CSS 自訂屬性（`--timeline-height` 等）實現可拖曳分隔條
- `position: absolute` 定位時間軸片段（滑動式固定播放頭設計）
- `@media` 響應式斷點

### SVG（Scalable Vector Graphics）
- 所有節點與連線完全以 SVG 動態產生（非 DOM 元素）
- 路徑（`<path>`）繪製直線、貝茲曲線連線
- 箭頭以 SVG `<marker>` 實作（5 種端點造型）
- 漸層（`<linearGradient>`）支援節點背景與外框
- `<clipPath>` 用於動畫效果遮罩
- Hit-testing：透明寬粗線條（`stroke-width: 18`）提升點擊精確度

### JavaScript（ES2022，無框架）
- 純函式式狀態管理（單一 `state` 物件 + Undo/Redo 堆疊）
- UMD 模組（`parser.js`）同時相容瀏覽器和 Node.js
- 事件委派（`pointerdown` / `pointermove` / `pointerup`）實作拖曳
- `setPointerCapture` 確保拖曳不因滑出元素而中斷
- `requestAnimationFrame` 驅動播放動畫循環
- `performance.now()` 高精度計時（用於 JKL 穿梭播放）

### Canvas API
- `<canvas>` 繪製時間軸音訊波形（從 PCM 取樣值繪製振幅條）
- 離線渲染：`OfflineAudioContext` 解碼音訊並取樣 2000 個振幅峰值
- `captureStream()` + `MediaRecorder` 實作瀏覽器端影片錄製

### Web Audio API
- `AudioContext` + `AnalyserNode`：即時麥克風音量計（錄音中）
- `OfflineAudioContext.decodeAudioData()`：解碼音訊檔案取得 PCM 波形資料
- `createMediaStreamSource()`：將麥克風串流接入分析器

### MediaDevices API（getUserMedia）
- 列舉麥克風裝置（`enumerateDevices`）
- 請求麥克風錄音權限（`getUserMedia({ audio: true })`）
- `MediaRecorder` API：錄音、暫停、繼續、停止，輸出 WebM/Opus

### File & Blob API
- `FileReader` 讀取匯入的圖片/音訊/影片
- `Blob` + `URL.createObjectURL()` 建立可播放的本機 URL
- `FormData` 上傳音訊到 Python 後端
- `fetch` 呼叫本機 API（轉檔、辨識）
- 自製 ZIP 封裝器（純 JS 實作 ZIP local file header + central directory，用於 PNG 序列下載）

### localStorage / JSON
- 完整專案狀態的自動保存與讀取
- 版面快照（獨立 storage key）
- State migration（`upgradeState()` 向上相容舊格式）

### WebSocket（客戶端）
- 連接 SpaceMouse 橋接器（Port 8766）
- 接收六軸 HID 資料並映射到畫布操作

---

## 後端（Python）

### `http.server`（標準庫）
- `ThreadingHTTPServer` 多執行緒處理並行請求
- `SimpleHTTPRequestHandler` 繼承後自訂 POST 路由
- `email.parser.BytesParser` 解析 multipart/form-data 上傳

### FFmpeg（外部工具，透過子行程呼叫）
- PNG 序列 → ProRes 4444 MOV（透明背景）
- PNG 序列 → ProRes 422 MOV（不透明）
- PNG 序列 → H.264 MP4
- PNG 序列 → WebM VP9 alpha（透明 MP4 替代方案）
- WebM/Ogg 音訊 → MP3 / WAV / AAC 轉換

### faster-whisper（可選依賴）
- OpenAI Whisper 的 CTranslate2 加速版本
- 語音活動偵測（VAD）過濾靜音段
- 輸出帶時間戳的字幕段落（start/end/text）
- 支援自訂模型大小（`WHISPER_MODEL` 環境變數）和推理裝置（CPU/GPU）

### `ctypes`（SpaceMouse 橋接器）
- 呼叫 Windows `user32.dll`
- 建立隱藏訊息視窗（`CreateWindowEx`）
- 注冊 Raw Input 接收器（`RegisterRawInputDevices`）
- 解析 HID 封包（3Dconnexion Usage Page 0x01 / Usage 0x08）
- 六軸資料解碼：16-bit little-endian，範圍 -350 到 +350

### `socketserver`（WebSocket 伺服器）
- 手動實作 WebSocket 握手（RFC 6455）
- 幀編解碼（masking、opcode 處理）
- 廣播模式（多個瀏覽器 tab 同時接收）

---

## 開發工具與環境

### 執行環境
- Windows 10/11（SpaceMouse 橋接器僅限 Windows）
- Python 3.9+（標準庫 + 可選 faster-whisper）
- Chrome 或 Edge（需支援 MediaRecorder、Web Audio API）
- FFmpeg（PATH 中可找到，用於影片輸出）

### 無需安裝
- 無 Node.js（除非要跑 `test-parser.js`）
- 無 npm / webpack / vite / babel
- 無前端框架（React / Vue / Angular）
- 無 CSS 預處理器

### 啟動方式
| 方式 | 需要 | 功能限制 |
|---|---|---|
| 直接開 `index.html` | 瀏覽器 | 無字型掃描、無影片輸出、無 MP3 下載 |
| 執行 `start.ps1` | Python、Chrome/Edge | 全功能 |
| `run_spacemouse_flow_bridge.bat` | Python、SpaceMouse | 六軸輸入 |

---

## 架構特點

### 固定播放頭時間軸
時間軸的播放頭**固定在畫面正中央**，所有片段隨播放頭移動而左右平移。這避免了傳統時間軸的水平捲動問題，片段在時間軸上的位置公式：

```
left = calc(50% + (clip.start - currentTime) * PX_PER_SECOND)
```

### 音訊剪輯資料模型
```
state.media = {
  projectStart,   // 音訊在專案時間軸上的起始點（秒）
  offset,         // 音訊檔案本身的裁切起點（秒）
  duration,       // 播放時長（秒）
}

audioTime = playhead - projectStart + offset
```
- 拖曳 clip 本體 → 改變 `projectStart`
- 拖曳左邊緣 → 同時改變 `projectStart` 和 `offset`（保持音訊內容對齊）
- 拖曳右邊緣 → 改變 `duration`

### SVG 動畫渲染策略
不使用 CSS animation 或 WAAPI，而是每一幀由 JS 計算每個元素當前的幾何狀態（progress → ease → 插值），直接寫入 SVG 屬性。好處是可以精確 seek 到任意時間點，支援逐格輸出。

### 純 JS ZIP 封裝
為了讓瀏覽器可以一次下載多個 PNG，自製了 ZIP 格式封裝器。使用 CRC-32 校驗、local file header 和 central directory 結構，避免使用任何外部庫。

---

## 相關技術關鍵字

`SVG` · `Canvas API` · `Web Audio API` · `MediaRecorder API` · `getUserMedia` · `WebSocket` · `localStorage` · `Blob` · `FormData` · `fetch` · `Python http.server` · `FFmpeg` · `faster-whisper` · `Whisper AI` · `ctypes` · `Windows Raw Input` · `HID` · `3Dconnexion SpaceMouse` · `ZIP` · `ProRes` · `H.264` · `WebM VP9` · `UMD module` · `Undo/Redo` · `requestAnimationFrame` · `Pointer Events API`
