# 007 — MISMATCH 後 transcript 殘留汙染

## 問題描述
當 AI 要求使用者念 "empirical" 時，若使用者說錯成 "call"，因為新套用的 Fuzzy 門檻 (`0.75`) 擋下配對，進入了 `MISMATCH`。AI 回應一短句後，使用者再念 "empirical"，此時系統裡的 `transcript` 會受到上一次的殘留汙染：
變成了 `"call empirical"`，而不是純淨的 `"empirical"`。這會影響系統的「目標字位置（smart trimming）」演算法的精確度。

### 問題 Log
```
[23:10:43] ❌ MISMATCH: "call" ≠ "empirical" — skipping analysis
...AI Turn...
...User tries again...
```

## 根本原因
當 `runPraatAnalysis` 的這段程式偵測到 `!matchResult` (MISMATCH) 後，它選擇跳出函式（`return`），但：
- 沒有清空 `userTranscriptRef.current`，導致 "call" 被遺留。
- （註：`AudioBuffer` 反而在 `AI TURN COMPLETE` 的階段有正常被清空）。
結果，使用者下次再講話時，語音所轉出的文字段落（transcript）會接在 "call " 的後面。

## 解決方案

### 修改：MISMATCH 時直接清空 Transcript
在 `useLiveAPI.ts` 的 `runPraatAnalysis` 中，若遭遇 MISMATCH 失敗：
```typescript
if (!matchResult) {
  dbg('match', `❌ MISMATCH: "${cleanUserText}" ≠ "${target}"`);
  setRecognizedSpeech(null);
  setSpeechMismatch(true);
  setTimeout(() => setSpeechMismatch(false), 3000);
  userTranscriptRef.current = '';  // 新增：清除汙染殘留文字，避免影響下一次
  return;
}
```

### 結果分析

| 步驟 / 狀態 | Audio Buffer | Transcript |
|------------|--------------|------------|
| MISMATCH 當下 | ❌ 不清空 (留待 turnComplete 清理) | ✅ **立即清空** |
| turnComplete 後| ✅ `clearUserBuffer()` 被呼叫，乾淨 | （已經是空的） |
| 使用者重新嘗試 | 🆕 全新乾淨音頻片段 | 🆕 乾淨的 "empirical" |

## 影響檔案
- `src/hooks/useLiveAPI.ts` — `runPraatAnalysis` 中的 mismatch 提前中斷處理邏輯
