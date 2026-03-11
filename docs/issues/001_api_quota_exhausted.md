# 001 — API 配額耗盡（RESOURCE_EXHAUSTED）

## 問題描述
每次載入頁面，系統呼叫 `gemini-2.5-flash-image` 生成 Coach Echo 頭像。圖片生成 API 消耗大量配額，導致相同 API Key 的所有 Gemini 服務（包括 Live API 對話）被拒絕。

### 錯誤訊息
```
WebSocket closed: code=1011, reason="You exceeded your current quota"
```

### 影響
- 無法進入對話模式
- 頁面載入和切換難度分類時都會觸發圖片生成

## 根本原因
`src/services/imageService.ts` 的 `generateDebaterImage` 函數使用 Gemini Image API，與 Live API 共用同一個 API Key 配額。

## 解決方案

### 修改 1：替換圖片生成（imageService.ts）
- **移除** Gemini Image API 呼叫
- **改為** 本地 SVG 頭像生成（漸層色 + 發光效果，零 API 使用量）

### 修改 2：錯誤提示（App.tsx）
- `handleStartTraining` 加入 try-catch
- 顯示中文錯誤提示：「Gemini API 額度已用完，請等幾分鐘再試。」

### 修改 3：WebSocket close 偵測（useLiveAPI.ts）
- `onclose` handler 擷取 close code + reason
- 檢測 `RESOURCE_EXHAUSTED` 關鍵字並顯示提示

## 影響檔案
- `src/services/imageService.ts` — 整個重寫
- `src/App.tsx` — handleStartTraining try-catch
- `src/hooks/useLiveAPI.ts` — onclose/onerror 增強
- `.env.local` — 更新 API Key
