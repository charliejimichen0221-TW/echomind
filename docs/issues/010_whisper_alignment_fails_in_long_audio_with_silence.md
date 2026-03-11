# 010 — 使用者造句音檔中 Whisper 無法定位目標字

## 問題描述
使用者用 "hypothesis" 造句：
> "Okay, a hypothesis is essentially an educated guess, a statement not predict a relationship between two variables."

系統成功在文字層匹配到 "hypothesis"（透過 Sliding Fuzzy Match），Praat 分析也正常觸發。
但 `user_full.wav` 中**聽不到 hypothesis 的清晰音頻**，導致 Whisper alignment 可能無法精準切出該字。

### 問題 Log
```
[Match] 🔎 findWordInText: words=["Okay", "a", "hy", "po", "the", "sis", "is", "esse", "nti", "ally", "an", "edu", "ca", "ted", "gas", "a", "sta", "tement", "no", "t", "pred", "ic", "t", "a", "re", "lation", "ship", "bet", "ween", "two", "varia", "bles"] target="hypothesis"
[Match] ✅ Strategy 2 (SLIDING FUZZY): joined "pothesis" ~ "hypothesis" sim=0.800 > 0.75 (win=3, pos=3)
[Praat] 🔬 Analyzing 100 chunks (~25.6s) [hypothesis]
[Praat] 📤 Ref: last 75/698 chunks (~3.0s) for "hypothesis"
```

## 為什麼 003 Smart Trimming 無法解決？

003 Smart Trimming 處理的情境是：
> buffer > MAX_USER_CHUNKS 時，根據字的位置估算音頻中心點，智慧裁切

**但本次的 buffer = 100 chunks = MAX_USER_CHUNKS，條件 `> 100` 為 false。
Smart Trimming 根本沒有被觸發。** 整個 100 chunks 原封不動地送到 server。

同理，008 的「尾部對齊」策略也已經實作在程式碼中，但同樣因為 buffer 沒超過 100 所以沒觸發。

## 根本原因

問題在 **buffer 送到 server 後的處理**。分析完整的 pipeline：

```
Client 端（useLiveAPI.ts）                      Server 端（praatService.ts）
─────────────────────────                      ──────────────────────────
1. 匹配成功 ✅                                  
2. flushUserBuffer() → 100 chunks              
3. Smart Trimming 未觸發                        
   (100 == MAX, 不是 >)                         
4. 送出 100 chunks 到 server  ──────────────▶  5. 合併 PCM → fullUserWav (25.6s)
                                               6. whisperAlign(fullUserWav, "hypothesis", hint=true)
                                               7. 根據 Whisper 結果裁切
```

**核心問題出在步驟 6 和 7**：

### 問題 A：Buffer 中可能有大量靜音期

使用者從 AI 說完話到開始說句子之間，可能思考了 15-20 秒。
由於 `setBuffering(true)` 在 AI `turnComplete` 時就開啟了，靜音也被錄進 buffer。

```
[0s ──── 20s 靜音（思考中）──── ] [20s "Okay, a hypothesis..." 25.6s]
```

25.6 秒的音檔裡可能只有 ~5 秒的語音。

### 問題 B：Whisper `tiny` 模型在長音檔 + 靜音中誤判

Whisper tiny 模型（align.py 使用的 `WhisperModel("tiny")`）對於：
- 含大量靜音的長音檔
- 非母語使用者的口音
- 在句子中間（非單獨唸出）的目標字

辨識準確率會大幅下降。一旦 `whisperAlign` 回傳 `found: false`，
系統就 fallback 到 `trimSilence`，只做簡單的能量閾值裁切，
最終 `user_recording.wav` 可能裁切不精準。

## 解決方案

### 修改：在送 Whisper 之前，先裁掉 Buffer 中的靜音（Pre-trim）

在 `praatService.ts` 的 `comparePronunciation` 中，Whisper alignment 之前，
先對 `rawUserPCM` 做 `trimSilence` 處理，產生一個乾淨的短音檔給 Whisper。

#### 修改前的流程
```
fullUserWav (25.6s, 含 ~20s 靜音)
  ──► whisperAlign("hypothesis", hint=true)
  ──► Whisper tiny 在 25s 音檔中搜尋 → ❌ 找不到
  ──► fallback: trimSilence → user_recording.wav（可能不含 hypothesis）
```

#### 修改後的流程
```
fullUserWav (25.6s, 含 ~20s 靜音)
  ──► trimSilence → trimmedUserWav (~5.6s, 只有語音)
  ──► whisperAlign(trimmedWav, "hypothesis", hint=true)
  ──► Whisper tiny 在 5s 音檔中搜尋 → ✅ 找到
  ──► extractWavSegment(trimmedWav, ...) → 精準切出 hypothesis
```

#### 關鍵設計考量
1. **原始 `fullUserWav` 保持不變**，仍然 copy 到 `debug/user_full.wav` 供檢查
2. **Whisper 時間戳基於 trimmed 版本**，所以 `extractWavSegment` 也從 trimmed 版本取
3. **即使 Whisper 仍然找不到**，至少 fallback 用的是已裁好靜音的版本（比原本整段都是靜音好很多）
4. Temp file 在不需要時自動清理

## 影響檔案
- `praatService.ts` — `comparePronunciation` 函式（Whisper alignment 前置處理）

