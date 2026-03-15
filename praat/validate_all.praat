# validate_all.praat — One-click F1/F2 accuracy test
# Generates synthetic vowels with KNOWN formants using Praat's own synthesis,
# then measures them with the same method as query_vowels.praat.
# Also tests real recordings if available.

# ═══ Part 1: Synthetic Vowel Test ═══
writeInfoLine: "═══ F1/F2 ACCURACY VALIDATION ═══"
appendInfoLine: ""
appendInfoLine: "── Part 1: Synthetic Vowels (known F1/F2) ──"
appendInfoLine: ""

# Define known vowels: name, F1, F2
vowelName$[1] = "IY (beat)"
vowelF1[1] = 270
vowelF2[1] = 2290

vowelName$[2] = "IH (bit)"
vowelF1[2] = 390
vowelF2[2] = 1990

vowelName$[3] = "EH (bet)"
vowelF1[3] = 530
vowelF2[3] = 1840

vowelName$[4] = "AE (bat)"
vowelF1[4] = 660
vowelF2[4] = 1720

vowelName$[5] = "AH (but)"
vowelF1[5] = 520
vowelF2[5] = 1190

vowelName$[6] = "AA (bot)"
vowelF1[6] = 730
vowelF2[6] = 1090

vowelName$[7] = "UW (boot)"
vowelF1[7] = 300
vowelF2[7] = 870

numVowels = 7
good = 0
ok = 0
bad = 0

appendInfoLine: "  Vowel        Known F1  Known F2  Meas F1   Meas F2   dF1    dF2    Status"
appendInfoLine: "  ─────────── ────────  ────────  ────────  ────────  ─────  ─────  ──────"

for vi from 1 to numVowels
    # Create a KlattGrid for this vowel
    Create KlattGrid: "synth", 0, 0.5, 6, 1, 1, 6, 1, 1, 1
    
    # Set voicing
    Add pitch point: 0.25, 120
    
    # Set formants (F1-F4)
    Remove oral formant frequency points: 1
    Add oral formant frequency point: 1, 0.25, vowelF1[vi]
    Remove oral formant frequency points: 2
    Add oral formant frequency point: 2, 0.25, vowelF2[vi]
    Remove oral formant frequency points: 3
    Add oral formant frequency point: 3, 0.25, 2500
    Remove oral formant frequency points: 4
    Add oral formant frequency point: 4, 0.25, 3500
    
    # Set bandwidths
    Remove oral formant bandwidth points: 1
    Add oral formant bandwidth point: 1, 0.25, 80
    Remove oral formant bandwidth points: 2
    Add oral formant bandwidth point: 2, 0.25, 100
    Remove oral formant bandwidth points: 3
    Add oral formant bandwidth point: 3, 0.25, 120
    Remove oral formant bandwidth points: 4
    Add oral formant bandwidth point: 4, 0.25, 150
    
    # Synthesize
    selectObject: "KlattGrid synth"
    sound = To Sound
    
    # Measure formants (same settings as query_vowels.praat)
    selectObject: sound
    formant = To Formant (burg): 0, 5, 5500, 0.025, 50
    
    # Get F1/F2 at midpoint (same as our pipeline)
    dur = 0.5
    midStart = dur * 0.2
    midEnd = dur * 0.8
    step = 0.01
    nSteps = floor((midEnd - midStart) / step)
    sumF1 = 0
    sumF2 = 0
    nValid = 0
    
    for si from 1 to nSteps
        t = midStart + (si - 0.5) * step
        selectObject: formant
        f1v = Get value at time: 1, t, "Hertz", "Linear"
        f2v = Get value at time: 2, t, "Hertz", "Linear"
        if f1v <> undefined and f2v <> undefined and f1v > 50 and f2v > 50
            sumF1 = sumF1 + f1v
            sumF2 = sumF2 + f2v
            nValid = nValid + 1
        endif
    endfor
    
    if nValid > 0
        measF1 = sumF1 / nValid
        measF2 = sumF2 / nValid
    else
        measF1 = 0
        measF2 = 0
    endif
    
    dF1 = abs(measF1 - vowelF1[vi])
    dF2 = abs(measF2 - vowelF2[vi])
    
    if dF1 < 50 and dF2 < 100
        status$ = "GOOD"
        good = good + 1
    elsif dF1 < 100 and dF2 < 200
        status$ = "OK"
        ok = ok + 1
    else
        status$ = "BAD"
        bad = bad + 1
    endif
    
    appendInfoLine: "  " + vowelName$[vi] + tab$ + fixed$(vowelF1[vi], 0) + tab$ + "  " + fixed$(vowelF2[vi], 0) + tab$ + "  " + fixed$(measF1, 0) + tab$ + "  " + fixed$(measF2, 0) + tab$ + "  " + fixed$(dF1, 0) + tab$ + " " + fixed$(dF2, 0) + tab$ + " " + status$
    
    # Clean up
    selectObject: sound
    plusObject: formant
    plusObject: "KlattGrid synth"
    Remove
endfor

appendInfoLine: ""
appendInfoLine: "  ── Synthetic Summary ──"
appendInfoLine: "  GOOD: " + string$(good) + "/" + string$(numVowels)
appendInfoLine: "  OK:   " + string$(ok) + "/" + string$(numVowels)
appendInfoLine: "  BAD:  " + string$(bad) + "/" + string$(numVowels)
total_ok = good + ok
pct = (total_ok / numVowels) * 100
appendInfoLine: "  Accuracy (GOOD+OK): " + fixed$(pct, 0) + "%"
appendInfoLine: ""

# ═══ Part 2: Real Recording Test ═══
appendInfoLine: "── Part 2: Real Recordings ──"
appendInfoLine: ""

debugDir$ = defaultDirectory$ + "/debug/"

refPath$ = debugDir$ + "ref_recording.wav"
userPath$ = debugDir$ + "user_recording.wav"
refTG$ = debugDir$ + "ref_vowels.TextGrid"
userTG$ = debugDir$ + "user_vowels.TextGrid"

if fileReadable(userPath$) and fileReadable(userTG$)
    # Open user recording + TextGrid
    userSound = Read from file: userPath$
    userTG = Read from file: userTG$
    
    selectObject: userSound
    userFormant = To Formant (burg): 0, 5, 5500, 0.025, 50
    
    selectObject: userTG
    nIntervals = Get number of intervals: 1
    
    appendInfoLine: "  User recording vowels:"
    appendInfoLine: "  Vowel     Start    End      F1       F2"
    appendInfoLine: "  ─────── ──────── ──────── ──────── ────────"
    
    for ii from 1 to nIntervals
        selectObject: userTG
        label$ = Get label of interval: 1, ii
        if label$ <> ""
            startT = Get start time of interval: 1, ii
            endT = Get end time of interval: 1, ii
            midT = (startT + endT) / 2
            
            selectObject: userFormant
            f1 = Get value at time: 1, midT, "Hertz", "Linear"  
            f2 = Get value at time: 2, midT, "Hertz", "Linear"
            
            if f1 = undefined
                f1 = 0
            endif
            if f2 = undefined
                f2 = 0
            endif
            
            appendInfoLine: "  " + label$ + tab$ + " " + fixed$(startT, 3) + "s  " + fixed$(endT, 3) + "s  " + fixed$(f1, 0) + " Hz  " + fixed$(f2, 0) + " Hz"
        endif
    endfor
    
    appendInfoLine: ""
    appendInfoLine: "  (Compare these with terminal [PraatService] output)"
    
    # Open for visual inspection
    selectObject: userSound
    plusObject: userTG
    View & Edit
    
    selectObject: userFormant
    Remove
else
    appendInfoLine: "  No debug recordings found."
    appendInfoLine: "  Run a pronunciation session first, then:"
    appendInfoLine: "    python debug/test_formants.py hypothesis"
endif

appendInfoLine: ""
appendInfoLine: "═══ DONE ═══"
