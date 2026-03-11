# 問題追蹤記錄

此資料夾包含 EchoMind 開發過程中遇到的問題分析與修復記錄。

## 索引

| 編號 | 問題 | 狀態 | 檔案 |
|------|------|------|------|
| 001 | API 配額耗盡（RESOURCE_EXHAUSTED） | ✅ 已修復 | [001_api_quota_exhausted.md](./001_api_quota_exhausted.md) |
| 002 | ref_recording.wav 沙沙聲（Anti-aliasing 濾波器太弱） | ✅ 已修復 | [002_ref_recording_static_noise.md](./002_ref_recording_static_noise.md) |
| 003 | 使用者長句子中目標字被裁切掉 | ✅ 已修復 | [003_smart_trimming_word_position.md](./003_smart_trimming_word_position.md) |
| 004 | Praat 重複觸發導致 transcript 資料遺失 | ✅ 已修復 | [004_praat_double_trigger.md](./004_praat_double_trigger.md) |
| 005 | 模糊匹配門檻太低（Imperial ≈ empirical） | ✅ 已修復 | [005_fuzzy_match_threshold.md](./005_fuzzy_match_threshold.md) |
| 006 | Praat 回饋 turn 清空 ref 音頻 | ✅ 已修復 | [006_praat_response_clears_ref.md](./006_praat_response_clears_ref.md) |
| 007 | MISMATCH 後 transcript 殘留汙染 | ✅ 已修復 | [007_mismatch_transcript_residue.md](./007_mismatch_transcript_residue.md) |
| 008 | 長時間空白導致 Smart Trimming 偏移 | ✅ 已修復 | [008_smart_trimming_long_silence_bug.md](./008_smart_trimming_long_silence_bug.md) |
| 009 | Praat 回饋中換字導致 AI 參考音頻丟失 | ✅ 已修復 | [009_praat_response_discards_new_target_audio.md](./009_praat_response_discards_new_target_audio.md) |
