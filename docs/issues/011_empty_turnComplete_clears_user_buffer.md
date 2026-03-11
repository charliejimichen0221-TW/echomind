# 011 — Empty turnComplete 反覆清空 User Buffer 導致語音遺失

## 問題描述
`user_full.wav` (25.6s) 的 max amplitude 只有 2191/32768 (6.7%)，
幾乎是純背景噪音等級（正常語音應 3000-15000+）。
儘管 Gemini 能正確轉錄使用者的語音，buffer 裡卻沒有語音內容。

### 診斷數據
```
USER (user_full.wav): rate=16000Hz dur=25.60s maxAmp=2191 RMS=34.3
REF  (ref_full.wav):  rate=24000Hz dur=3.00s  maxAmp=30014 RMS=3960.9
```

User audio 的 max amplitude 是 ref 的 7%，基本上是靜音。

### 為什麼 Gemini 能轉錄但 buffer 抓不到？
因為 `AudioProcessor.onaudioprocess` 中：
```typescript
onChunk(base64);                    // ← 永遠發給 Gemini（所以 Gemini 能轉錄）
if (this.isBuffering) {
    this.userBuffer.push(base64);   // ← 只有 isBuffering=true 才存入 buffer
}
```

問題是 `isBuffering` 在使用者說話的大部分時間為 **false**。

## 根本原因

### Gemini Live API 的 Empty turnComplete 機制

Gemini Live API 是全雙工的。當使用者沈默或停頓時，Gemini 會發送
`turnComplete`（沒有附帶 audio 的空 turn）來表示「我在聽」。

我們的程式碼處理 empty turnComplete 時：

```typescript
if (isEmptyTurn) {
    const userChunks = processorRef.current?.getUserChunkCount?.() ?? 0;
    const cleanUserText = userTranscriptRef.current.replace(/[^a-zA-Z\s]/g, '').trim();

    if (userChunks >= 3 && targetWordRef.current && cleanUserText.length > 0) {
        runPraatAnalysis();      // ✅ 有轉錄文字時：觸發分析
    } else {
        clearUserBuffer();       // ❌ 沒有轉錄文字時：清空 buffer！
        userTranscriptRef.current = '';
    }
}
// ... 最後都會：
processorRef.current?.setBuffering(true);
```

### 時序問題

```
AI 說完話 → turnComplete → clearBuffer + setBuffering(true)
                                ↓
使用者開始思考... (靜音)         buffering ON, 錄到靜音
                                ↓
Gemini 發送 empty turnComplete  → cleanUserText="" → clearBuffer！
                                ↓
使用者繼續沈默...               buffering ON (重新錄，但之前的已丟)
                                ↓
Gemini 再發 empty turnComplete  → cleanUserText="" → clearBuffer！
                                ↓
使用者開始說 "Okay, a hypo..."  buffering ON
             ↑                  ↓
         inputTranscription     但可能幾秒後又一個 empty turnComplete
         開始進來               在 text 累積完之前又 clearBuffer！
                                ↓
最後 AI 開始回應                runPraatAnalysis → flush buffer
                                → 只拿到最後一小段噪音
```

**每次 empty turnComplete 都清空 buffer，導致使用者的語音被反覆丟棄。**
最終 flush 時只剩下最後一小段 — 大部分是靜音或噪音。

## 解決方案

### 修改：Empty turnComplete 不再清空 User Buffer

Empty turnComplete 時，既然沒有要做分析，就不應該破壞性地清空 buffer。
改為：只在確定不需要這些音頻時才清空（例如沒有 target word 設定時）。

```
修改前：else { clearUserBuffer(); userTranscriptRef.current = ''; }
修改後：只在沒有 targetWord 時才清，否則保留 buffer 等待使用者說話
```

## 影響檔案
- `src/hooks/useLiveAPI.ts` — `turnComplete` 的 `isEmptyTurn` 分支
