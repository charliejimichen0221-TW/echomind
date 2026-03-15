# ground_truth.praat — Measure F1/F2 at multiple points within vowel ranges
# This provides "ground truth" by measuring at:
#   1. Exact midpoint
#   2. 25% point
#   3. 75% point
# Output: JSON array with midpoint, p25, p75 values

form input
    text wavFile
    text starts
    text ends
endform

sound = Read from file: wavFile$
formant = To Formant (burg): 0, 5, 5000, 0.025, 50

numVowels = 0
# Count commas to determine number of vowels
temp$ = starts$
while index(temp$, ",") > 0
    numVowels = numVowels + 1
    temp$ = right$(temp$, length(temp$) - index(temp$, ","))
endwhile
numVowels = numVowels + 1

result$ = "["
for vi from 1 to numVowels
    # Parse start/end for this vowel
    if vi = 1
        if index(starts$, ",") > 0
            curStart$ = left$(starts$, index(starts$, ",") - 1)
        else
            curStart$ = starts$
        endif
        if index(ends$, ",") > 0
            curEnd$ = left$(ends$, index(ends$, ",") - 1)
        else
            curEnd$ = ends$
        endif
    else
        tmpS$ = starts$
        tmpE$ = ends$
        for skip from 1 to vi - 1
            tmpS$ = right$(tmpS$, length(tmpS$) - index(tmpS$, ","))
            tmpE$ = right$(tmpE$, length(tmpE$) - index(tmpE$, ","))
        endfor
        if index(tmpS$, ",") > 0
            curStart$ = left$(tmpS$, index(tmpS$, ",") - 1)
        else
            curStart$ = tmpS$
        endif
        if index(tmpE$, ",") > 0
            curEnd$ = left$(tmpE$, index(tmpE$, ",") - 1)
        else
            curEnd$ = tmpE$
        endif
    endif
    startT = number(curStart$)
    endT = number(curEnd$)
    dur = endT - startT
    
    # Measure at 3 points: 25%, 50%, 75%
    t25 = startT + dur * 0.25
    t50 = startT + dur * 0.50
    t75 = startT + dur * 0.75
    
    selectObject: formant
    f1_25 = Get value at time: 1, t25, "Hertz", "Linear"
    f2_25 = Get value at time: 2, t25, "Hertz", "Linear"
    f1_50 = Get value at time: 1, t50, "Hertz", "Linear"
    f2_50 = Get value at time: 2, t50, "Hertz", "Linear"
    f1_75 = Get value at time: 1, t75, "Hertz", "Linear"
    f2_75 = Get value at time: 2, t75, "Hertz", "Linear"
    
    if f1_25 = undefined
        f1_25 = 0
    endif
    if f2_25 = undefined
        f2_25 = 0
    endif
    if f1_50 = undefined
        f1_50 = 0
    endif
    if f2_50 = undefined
        f2_50 = 0
    endif
    if f1_75 = undefined
        f1_75 = 0
    endif
    if f2_75 = undefined
        f2_75 = 0
    endif
    
    if vi > 1
        result$ = result$ + ","
    endif
    result$ = result$ + "{""mid"":{""f1"":" + fixed$(f1_50, 1) + ",""f2"":" + fixed$(f2_50, 1) + ",""t"":" + fixed$(t50, 4) + "},"
    ... + """p25"":{""f1"":" + fixed$(f1_25, 1) + ",""f2"":" + fixed$(f2_25, 1) + "},"
    ... + """p75"":{""f1"":" + fixed$(f1_75, 1) + ",""f2"":" + fixed$(f2_75, 1) + "}}"
endfor

result$ = result$ + "]"
writeInfoLine: result$

selectObject: sound
plusObject: formant
Remove
