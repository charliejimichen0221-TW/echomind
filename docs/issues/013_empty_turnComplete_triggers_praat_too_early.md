# 013 — Empty turnComplete 觸發 Praat 太早，用戶還在說話就 flush buffer

## 問題描述
用戶造句 "hypothesis is to continue discuss with your wider family..."，
Praat 被觸發了**兩次**：
- 第一次：只有 24 chunks (~6.1s)，用戶才剛說出 "hypothesis" 就被 flush
- 第二次：100 chunks (~25.6s)，但已丟失第一次 flush 的 audio

### 問題 Log
```
[Echo] 🎯 Target word CHANGED: "null" → "hypothesis"
[User] 👤 " hypothesis"
[Match] ✅ Strategy 1 (EXACT): "hypothesis"
[Praat] 🔬 Analyzing 24 chunks (~6.1s)          ← 太早！用戶還在說
[User] 👤 " hy"
[User] 👤 "po"
...
[User] 👤 " basis."
[Match] ✅ Strategy 2 (SLIDING FUZZY)
[Praat] 🔬 Analyzing 100 chunks (~25.6s)         ← 第二次，已丟失前 24 chunks
```

## 根本原因

Issue #011 修復了 empty turnComplete **清空 buffer** 的問題，但沒有處理
empty turnComplete **觸發 Praat** 太早的問題。

### 時序

```
t0  AI turnComplete → setBuffering(true)
t1  用戶開始說 "hypothesis is to continue..."
t2  inputTranscription: " hypothesis"               transcript 有內容了
t3  Empty turnComplete → chunks >= 3 + text 有內容
    → runPraatAnalysis() → flushUserBuffer()        ← 24 chunks 被 flush
    → buffer 清空，用戶還在說話！
t4  用戶繼續說 "...discuss with your wider family..."
t5  更多 fragments 進來，buffer 重新累積
t6  又一個 empty turnComplete 或 AI 開始回應
    → 第二次 runPraatAnalysis() → 100 chunks
```

## 解決方案

### Empty turnComplete 加入 2 秒 debounce

不立即觸發 Praat，改為設定 2 秒 debounce timer：
- 每次 empty turnComplete 都重置 timer
- 用戶持續說話 → Gemini 持續送 empty turnComplete → timer 持續重置
- 用戶停下來 2 秒後 → timer 觸發 → 此時 buffer 包含完整句子

### AI 開始回應時直接觸發

AI 真正開始說話（第一個 audio chunk）是用戶已經停止說話的可靠信號，
此時取消 debounce 並直接觸發 runPraatAnalysis()。

## 影響檔案
- `src/hooks/useLiveAPI.ts` — empty turnComplete handler + AI first chunk handler
