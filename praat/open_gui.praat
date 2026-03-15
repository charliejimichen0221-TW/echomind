# open_gui.praat
# 這個腳本會直接在 Praat 介面中打開你剛才的錄音和分析結果

wav_file$ = "debug/user_recording.wav"
tg_file$ = "debug/user_vowels.TextGrid"

if fileReadable(wav_file$) and fileReadable(tg_file$)
    # 清除之前的物件避免混亂
    select all
    Remove

    sound = Read from file: wav_file$
    tg = Read from file: tg_file$
    selectObject: sound
    plusObject: tg
    View & Edit
    
    # 打開 Info window 提示
    writeInfoLine: "✅ 已經在 Praat 中打開你的語音和標記！"
    appendInfoLine: "1. 請查看 View & Edit 視窗"
    appendInfoLine: "2. 你可以看到 Spectrogram (頻譜圖) 和紅色的 Formant 軌跡"
    appendInfoLine: "3. 點擊母音區間的正中間，然後按 F1 / F2 查看數值 (或看左邊紅色的數字)"
else
    writeInfoLine: "❌ 找不到檔案，請確定已經在 App 中完成過一次發音練習。"
endif
