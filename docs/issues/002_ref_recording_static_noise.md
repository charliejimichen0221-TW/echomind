# 002 — ref_recording.wav 沙沙聲（Anti-aliasing 濾波器太弱）

## 問題描述
`debug/ref_recording.wav`（AI 參考音頻切割後的正規化版本）播放時有明顯的沙沙雜音。

### 診斷數據
```
ref_full.wav:      maxAmp=32768 (clipping), largeJumps=0   ← 原始 OK
ref_recording.wav: maxAmp=32639, largeJumps=3241           ← 3241 處爆音！
```

## 根本原因
`praatService.ts` 的 `normalizeWavForPlayback` 函數將 AI 音頻從 24kHz 降頻到 16kHz。

降頻前需要 anti-aliasing 濾波器移除 8kHz 以上的頻率。原始濾波器太弱：
- **原始**：1-pass moving average, window=2 → 幾乎沒有濾波效果
- AI 音頻已經在 clipping 邊緣（maxAmp=32768），高頻殘留 + 降頻 → 3241 sample jumps → 沙沙聲

## 解決方案

### 修改：增強 anti-aliasing 濾波器（praatService.ts）

```typescript
// 之前（太弱）
const filterWidth = Math.ceil(ratio);  // = 2
// 單次 pass

// 嘗試 1（太悶）
const filterWidth = 5;
const PASSES = 3;  // 聲音太悶，高頻全被吃掉

// 最終版（平衡）
const filterWidth = 2;   // gentle window
const PASSES = 2;        // 2 passes ≈ triangular rolloff
```

### 各版本比較
| 設定 | maxAmp | largeJumps | 聽感 |
|------|--------|------------|------|
| 1-pass, w=2 (原始) | 30888 | 3241 ❌ | 沙沙雜音 |
| **2-pass, w=2 (最終)** | **29864** | **0** ✅ | **正常** |
| 2-pass, w=3 | 29864 | 0 ✅ | 正常（與 w=2 等效） |
| 3-pass, w=5 | 25307 | 0 ✅ | 太悶 |

> 注意：filterWidth=2 和 filterWidth=3 在此演算法中等效（`Math.floor(2/2) = Math.floor(3/2) = 1`）

## 額外改動：Debug Log
在 `praatService.ts` 加入了完整的音頻管線 debug log：
- `extractWavSegment` — 切割位置、PCM 品質統計
- `normalizeWavForPlayback` — 正規化前後分析
- `comparePronunciation` — 最終檔案大小比較
- 自動偵測 `largeJumps > 100`（STATIC 警告）和 clipping

啟用方式：`$env:ECHOMIND_DEBUG="1"; npm run dev`

## 影響檔案
- `praatService.ts` — normalizeWavForPlayback 濾波器 + debug log
