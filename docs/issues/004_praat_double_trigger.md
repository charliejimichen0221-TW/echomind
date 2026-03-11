# 004 — Praat 重複觸發導致 transcript 資料遺失

## 問題描述
使用者跟讀 "hypothesis" 後又說了一個長句子。第 1 次 `runPraatAnalysis` 觸發後清空了 transcript 和 buffer。第 2 次觸發只拿到句子尾巴，匹配失敗。

### 問題 Log
```
[Praat] 🔬 Analyzing 14 chunks [hypothesis]     ← 第 1 次成功
[User] 👤 " hy"                                  ← 造句中的 hypothesis
[User] 👤 "po"
...
[Match] findWordInText: words=["over", "de"...] target="hypothesis"
[Match] ❌ NO MATCH                              ← 第 2 次失敗（只有尾巴）
```

## 根本原因
1. 第 1 次觸發：成功分析 → **立即清空** buffer + transcript
2. 使用者繼續說（造句），fragment 陸續到達
3. 中間某個 handler（turnComplete / interrupt）再次清空 transcript
4. 第 2 次觸發：transcript 只有尾巴 → NO MATCH

## 解決方案

### 修改 1：5 秒 Cooldown（useLiveAPI.ts）
```typescript
const lastPraatTimeRef = useRef(0);

// 在 runPraatAnalysis 開頭：
const elapsed = Date.now() - lastPraatTimeRef.current;
if (elapsed < 5000) {
  dbg('praat', `⏭️ Skip — cooldown (${elapsed}ms < 5s)`);
  return;
}
```
成功分析後設定 cooldown，5 秒內不會重複觸發。

### 修改 2：延遲 flush（useLiveAPI.ts）
```typescript
// 之前：進入函數就立刻 flush + 清空
let userChunks = proc.flushUserBuffer();  // ← 資料消失
userTranscriptRef.current = '';           // ← 文字消失

// 之後：匹配成功才 flush + 清空
if (!matchResult) { return; }  // 失敗 → 保留資料
// ... 匹配成功 ...
lastPraatTimeRef.current = Date.now();
let userChunks = proc.flushUserBuffer();  // ← 有把握才 flush
userTranscriptRef.current = '';
```

## 影響檔案
- `src/hooks/useLiveAPI.ts` — cooldown ref + 延遲 flush 邏輯
