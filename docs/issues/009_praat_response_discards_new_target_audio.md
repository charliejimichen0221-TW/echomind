# 009 — Praat 回饋中更換目標字導致新音頻被丟棄

## 問題描述
當 AI 給予 Praat 分析的回饋時（例如：「你的發音不錯，但再試一次... **repeat after me... analyze**」），系統成功解析出新的目標字，但在接下來的對比分析中，卻因為**沒有參考音頻 (`refChunks=0`)** 而跳過對比階段。

### 問題 Log
```
[23:53:32] 🎯 [MATCH] ✅ MATCHED: "analyze" contains "analyze" at idx=0/1
[23:53:32] 🔬 [PRAAT] 🎤 Flushed user buffer: 31 chunks, transcript cleared
[Praat] 🔬 Analyzing 31 chunks (~7.9s) [analyze]
(之後沒有發生比較階段，user_full.wav 等檔案沒有紀錄)
```
因為沒有進行 `Compare`，所以 `user_full.wav` 和 `ref_full.wav` 都沒有產生。

## 根本原因
問題出在 **「Praat 回饋專用 Turn」** 的丟棄機制（Discard Mechanism）。

1. 為了不讓 AI 的「回饋對談」汙染了之前的參考音頻，系統設計了在 `isPraatResponse = true` 時，AI 講完話後會 **丟棄當前 Turn 的音頻** (`flushAiBuffer()`)。
2. 然而，如果 AI 不聽話，在回饋語音裡**直接換了新的單字或要求重新練習**（例如 "repeat after me... analyze"）：
   - `echoMatch` 成功抓到了新的單字 "analyze"。
   - `lastAiChunksRef` 隨即被清空（因為是新單字）。
   - **但是 `isPraatResponse` 仍然維持 `true`！**
3. 到了 AI 說完話（`turnComplete`）時，系統看見 `isPraatResponse == true`，直接把剛才包含 "analyze" 的音頻**丟進垃圾桶**。
4. 最終結果：有了目標字 "analyze"，但沒有音頻！當使用者跟讀後，沒有參考音頻可以比對。

## 解決方案

### 修改：偵測到新目標字時，解除「回饋模式」
在 `useLiveAPI.ts` 的 `echoMatch` 中，只要發現 AI 偷塞了新的目標字（例如 "repeat after me..."），就立刻將這個 Turn 升級為**「正統的發音練習 Turn」**：

```typescript
if (detected !== targetWordRef.current) {
  // ... 清除舊 ref 等邏輯 ...
  
  // 關鍵修復：AI 換字了，這個 turn 就不單純只是回饋而已！
  // 必須關閉 isPraatResponse 標記，確保 turnComplete 時會儲存此段參考音頻。
  isPraatResponseRef.current = false;
  dbgUpdateState({ isPraatResponse: false });
}
```

### 結果
現在，只要 AI 說出 `"repeat after me..."`，系統就會把它當成新的一輪練習，乖乖儲存 AI 在這句話裡的語音，成為下次對比的 `refChunks`！

## 影響檔案
- `src/hooks/useLiveAPI.ts` — `echoMatch` 區塊
