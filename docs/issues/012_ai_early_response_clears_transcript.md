# 012 — AI 提前回應時清除 userTranscript 導致目標字遺失

## 問題描述
使用者造句 "hypothesis is essentially an educated guess..."，Gemini 成功轉錄了完整句子，
但 `findWordInText` 只收到後半段 `["is", "esse", "nti", ...]`，缺少 `"hy", "po", "the", "sis"`。

### 問題 Log
```
[Match] 🔎 findWordInText: words=["is", "esse", "nti", "al", "ly", "an", "edu", "ca", "ted",
  "gas", "not", "pred", "ic", "ts", "a", "re", "lation", "ship", "bet", "ween", "two", "variables"]
  target="hypothesis"
[Match] ❌ NO MATCH: best="is" sim=0.200 < 0.75
```

## 根本原因

### 行 514：AI 提前回應時無條件清除 transcript

當 AI 開始回應（第一個 audio chunk 到達），系統檢查 user buffer 是否有足夠音頻：

```typescript
// useLiveAPI.ts 行 505-514
const userChunks = processorRef.current?.getUserChunkCount?.() ?? 0;
const hasEnoughAudio = userChunks >= 3;
if (hasEnoughAudio) {
    runPraatAnalysis();
} else {
    processorRef.current?.clearUserBuffer();
    userTranscriptRef.current = '';  // ← BUG: 把有效的 transcript 也清掉了！
}
```

### 完整時序圖

```
時間  事件                                         transcript 狀態
────  ────                                         ──────────────
t0    AI 說完 → turnComplete → buffering ON         ""
t1    使用者開始說 "hypothesis is..."               ""
t2    inputTranscription: "hy"                      " hy"
t3    inputTranscription: "po"                      " hy po"
t4    inputTranscription: "the"                     " hy po the"
t5    inputTranscription: "sis"                     " hy po the sis"
t6    AI 太早回應 → 第一個 audio chunk 到達         " hy po the sis"
      userChunks < 3 → 清除!                       "" ← 全部消失！
t7    AI 說話中 (buffering=false)
t8    inputTranscription: "is"                      " is"
t9    inputTranscription: "esse"                    " is esse"
      ...後續 fragments 繼續累積...
t10   AI 結束 → turnComplete → buffering ON
t11   findWordInText("is esse nti al ly...")        → ❌ 找不到 hypothesis！
```

### 行 686：interrupted 也有同樣問題

使用者打斷 AI（說話中插嘴）時，`interrupted` handler 也清除 transcript：
```typescript
userTranscriptRef.current = '';  // 行 686
```
使用者可能一邊打斷 AI 一邊說句子，前面的 inputTranscription 被清掉。

## 解決方案

### 修改 1：行 514 — 不再清除 transcript
音頻不夠不代表 transcript 無效。保留 transcript 讓後續 match 能看到完整句子。

### 修改 2：行 686 — 有 targetWord 時不清除 transcript
使用者在練發音時打斷 AI 是正常行為，不應該丟棄已回收的轉錄文字。

## 影響檔案
- `src/hooks/useLiveAPI.ts` — AI first chunk handler + interrupted handler
