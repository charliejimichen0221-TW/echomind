# query_vowels.praat
# Query F1/F2 at intensity peaks within given vowel time ranges
#
# Usage: Praat --run query_vowels.praat <wav> <starts> <ends>
#   starts/ends are comma-separated time values
#
# Output: JSON array with per-vowel { f1, f2, time, int }

form input
    text wavFile
    text vowelStarts
    text vowelEnds
endform

sound = Read from file: wavFile$
formant = To Formant (burg): 0, 5, 5000, 0.025, 50
selectObject: sound
intensity = To Intensity: 100, 0, "yes"

# Parse comma-separated values into arrays using splitByWhitespace workaround
# Replace commas with spaces for easier parsing
starts$ = replace$(vowelStarts$, ",", " ", 0)
ends$ = replace$(vowelEnds$, ",", " ", 0)

# Count values
numVowels = 0
temp$ = starts$
repeat
    numVowels = numVowels + 1
    # Find space
    spacePos = index(temp$, " ")
    if spacePos > 0
        temp$ = mid$(temp$, spacePos + 1, length(temp$) - spacePos)
    endif
until spacePos = 0

scanStep = 0.005
result$ = "["

# Process each vowel
tempStarts$ = starts$
tempEnds$ = ends$

for vi from 1 to numVowels
    # Extract current start value
    spacePos = index(tempStarts$, " ")
    if spacePos > 0
        curStart$ = left$(tempStarts$, spacePos - 1)
        tempStarts$ = mid$(tempStarts$, spacePos + 1, length(tempStarts$) - spacePos)
    else
        curStart$ = tempStarts$
    endif
    startT = number(curStart$)
    
    # Extract current end value
    spacePos = index(tempEnds$, " ")
    if spacePos > 0
        curEnd$ = left$(tempEnds$, spacePos - 1)
        tempEnds$ = mid$(tempEnds$, spacePos + 1, length(tempEnds$) - spacePos)
    else
        curEnd$ = tempEnds$
    endif
    endT = number(curEnd$)
    
    # Measure formants by averaging over the middle 60% of the vowel
    # (standard phonetic practice: midpoint is most stable, avoid transitions)
    dur = endT - startT
    marginFrac = 0.2
    midStart = startT + dur * marginFrac
    midEnd = endT - dur * marginFrac
    if midEnd <= midStart
        midStart = (startT + endT) / 2 - 0.005
        midEnd = (startT + endT) / 2 + 0.005
    endif
    
    sumF1 = 0
    sumF2 = 0
    sumInt = 0
    nValid = 0
    bestInt = 0
    bestT = (startT + endT) / 2
    
    t = midStart
    while t <= midEnd
        selectObject: formant
        f1 = Get value at time: 1, t, "Hertz", "Linear"
        f2 = Get value at time: 2, t, "Hertz", "Linear"
        if f1 <> undefined and f2 <> undefined and f1 > 100
            sumF1 = sumF1 + f1
            sumF2 = sumF2 + f2
            nValid = nValid + 1
            selectObject: intensity
            intV = Get value at time: t, "Cubic"
            if intV = undefined
                intV = 0
            endif
            if intV > bestInt
                bestInt = intV
                bestT = t
            endif
            sumInt = sumInt + intV
        endif
        t = t + scanStep
    endwhile
    
    if nValid > 0
        bestF1 = sumF1 / nValid
        bestF2 = sumF2 / nValid
    else
        bestF1 = 0
        bestF2 = 0
    endif
    
    if vi > 1
        result$ = result$ + ","
    endif
    result$ = result$ + "{""f1"":" + fixed$(bestF1, 1) + ",""f2"":" + fixed$(bestF2, 1) + ",""time"":" + fixed$(bestT, 4) + ",""int"":" + fixed$(bestInt, 1) + "}"
endfor

result$ = result$ + "]"
writeInfoLine: result$

# Cleanup
selectObject: sound
plusObject: formant
plusObject: intensity
Remove
