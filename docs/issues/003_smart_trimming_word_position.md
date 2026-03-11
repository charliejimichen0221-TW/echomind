# 003 — 使用者長句子中目標字被裁切掉

## 問題描述
使用者說了一段長句子（如 30 秒），目標字 "empirical" 在句子中段。但 `user_full.wav` 中沒有包含 "empirical" 的音頻。

### 問題 Log
```
[AUDIO] ✂️ User buffer too long: 120 chunks (~30.7s) → trimming to 25
[AUDIO] ✂️ Target "hypothesis" at word 24/37 (65%) → chunk 77/120
[AUDIO] ✂️ Trimming to chunks [65..90) = 25 chunks (~6.4s)
```

## 根本原因
1. **裁切窗口太小**：25 chunks = 6.4s，長句子中誤差大
2. **線性位置估算不精確**：文字位置 ≠ 音頻位置（每個字長度不同、有停頓）
3. 6.4s 窗口不足以容忍估算誤差

### 早期版本的問題（更嚴重）
原始代碼使用 `slice(-25)` 只取**最後** 25 chunks。如果目標字在句首或中段，100% 會被裁掉。

## 解決方案

### 修改 1：智慧定位裁切（useLiveAPI.ts）
用目標字在 transcript 中的位置，估算對應的音頻 chunk，以此為中心取窗口：

```typescript
const wordRatio = matchResult.idx / matchResult.total;  // e.g. 24/37 = 65%
const estimatedCenter = Math.floor(wordRatio * totalChunks);  // chunk 77
// Center window around estimated position
```

### 修改 2：加大窗口 25 → 60 chunks
```typescript
const MAX_USER_CHUNKS = 60;  // ~15.4s（原本 25 = ~6.4s）
```

15.4s 窗口可容忍 ±7s 誤差。Server 端 Whisper 會做精準的 word-level alignment，所以 client 端只需確保目標字在窗口內即可。

## 範例比較
120 chunks, hypothesis at word 24/37 (65%), estimated chunk 77:

| 版本 | 窗口 | 範圍 | 結果 |
|------|------|------|------|
| 原始 `slice(-25)` | 6.4s (尾巴) | [95..120) | ❌ 完全抓不到 |
| 智慧定位 MAX=25 | 6.4s (置中) | [65..90) | ⚠️ 勉強，但容易失敗 |
| **智慧定位 MAX=60** | **15.4s (置中)** | **[47..107)** | ✅ 穩定 |

## 影響檔案
- `src/hooks/useLiveAPI.ts` — smart trimming 邏輯 + MAX_USER_CHUNKS
