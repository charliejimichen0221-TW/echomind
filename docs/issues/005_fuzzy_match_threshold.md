# 005 — 模糊匹配門檻太低（Imperial ≈ empirical）

## 問題描述
當系統要求使用者念 "empirical" 時，如果使用者念錯成 "Imperial"，系統依然會判定為 Matches（匹配成功），導致將錯誤的發音單字送入 Praat 進行分析。

### 問題 Log
```
[Match] 🔎 findWordInText: words=["Imperial", "call"] target="empirical"
[Match] ✅ Strategy 4 (FUZZY): "imperial" ~ "empirical" sim=0.667 > 0.6
```

## 根本原因
`useLiveAPI.ts` 中的 `findWordInText` 函數，其第 4 種策略（Fuzzy 單字匹配）使用了 Levenshtein 相似度演算法。原本設定的門檻值是 `0.6`。

"Imperial" 和 "empirical" 相似度為 `0.667`，超過了 `0.6` 的門檻，因此被誤判為配對成功。

## 解決方案

### 修改：收緊匹配門檻並加入詳細 Logs (useLiveAPI.ts)
1. **收緊門檻**：將 Fuzzy 單字匹配的 Levenshtein 相似度門檻從 `0.6` 提高到 `0.75`。
2. **加入 Debug Logs**：在每種匹配策略（Exact、Sliding Exact、Sliding Fuzzy、Contains、Fuzzy）中加入詳細的 `console.log`，方便快速查看是哪一個策略觸發了匹配。

```typescript
// 修改前
if (s > bestScore && s > 0.6) { bestScore = s; best = i; }

// 修改後
if (s > bestScore) { bestScore = s; best = i; bestWord = w; }
if (best >= 0 && bestScore > 0.75) { ... }
```

### 結果
- `Imperial` (0.667) → ❌ (`< 0.75`) 成功拒絕
- `empiricl` (0.889) → ✅ (`> 0.75`) 允許稍微念錯或系統小漏字

## 影響檔案
- `src/hooks/useLiveAPI.ts` — `findWordInText` 函數
