# 006 — Praat 回饋 turn 清空 ref 音頻

## 問題描述
當 AI 在給 Praat 的回饋時（如：「let's work on vowel clarity... repeat after me... empirical」），系統的 `lastAiChunksRef`（AI的參考音頻）會被無故清空，導致當使用者接著念 "empirical"，Praat 分析報告中找不到參考音頻：
```
⏭️ No comparison — refChunks=0, score=true
```

## 根本原因
在處理 AI 的 `outputTranscription` 時，`useLiveAPI.ts` 會使用 Regex (`/repeat\s+after\s+me.../i`) 偵測 AI 是不是要求使用者念哪個單字。

**舊的設計問題：**
只要偵測到 target word，就會清空 `lastAiChunksRef.current = []`。
若是目標單字更換，這很合理；但如果這是 Praat 的 feedback Turn，AI 只是「再次」要求使用者念這個舊有單字（"empirical" 沒變），也會導致 `lastAiChunksRef` 被清空。
偏偏在這個 turn 由於是 `isPraatResponse = true`，AI 接下來的音頻會被丟棄（不作為參考因其夾雜著其他feedback話語），所以 `lastAiChunksRef` 永遠不會被補回，變成了 `0` Chunks。

## 解決方案

### 修改：只有單字變更時，才清空 AI 參考音頻
```typescript
if (detected !== targetWordRef.current) {
// ... 更新 target word ...
    lastAiChunksRef.current = [];  // clear ref only for NEW word
} else {
    dbg('match', `🎯 Target word SAME: "${detected}" — keeping existing ref`);
}
```

如果在 AI 回饋中偵測到的是「原本的單字」，就保留先前的 `lastAiChunksRef`。如此一來，使用者再次跟讀時，依然有先前的正確唸法可作比對。

## 影響檔案
- `src/hooks/useLiveAPI.ts` — Regex target extraction (`echoMatch`) 邏輯
