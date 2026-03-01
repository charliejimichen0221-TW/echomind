# ===================================================
# EchoMind Pronunciation Comparison Script for Praat
# Compares user speech against AI reference audio
# 
# Uses normalized-time sampling with voiced-only
# filtering for pitch correlation accuracy.
#
# IMPORTANT: Both files should be resampled to the
# same rate before calling this script.
#
# Outputs JSON-formatted comparison results to stdout
# ===================================================

form Compare pronunciation
    text refFile
    text userFile
endform

# === Read both sound files ===
refSound = Read from file: refFile$
refRate = Get sampling frequency
refDuration = Get total duration

userSound = Read from file: userFile$
userRate = Get sampling frequency
userDuration = Get total duration

# === Resample to a common rate (16kHz) for fair comparison ===
targetRate = 16000

if refRate <> targetRate
    selectObject: refSound
    refSound_resampled = Resample: targetRate, 50
    selectObject: refSound
    Remove
    refSound = refSound_resampled
    selectObject: refSound
    refDuration = Get total duration
endif

if userRate <> targetRate
    selectObject: userSound
    userSound_resampled = Resample: targetRate, 50
    selectObject: userSound
    Remove
    userSound = userSound_resampled
    selectObject: userSound
    userDuration = Get total duration
endif

# === Initialize defaults ===
pitchCorrelation = 0
durationRatio = 0
f1Similarity = 0
f2Similarity = 0
intensityCorrelation = 0
refMeanPitch = 0
userMeanPitch = 0
refF1 = 0
refF2 = 0
userF1 = 0
userF2 = 0
refMeanIntensity = 0
userMeanIntensity = 0

# === Duration ratio ===
if refDuration > 0
    durationRatio = userDuration / refDuration
else
    durationRatio = 0
endif

# === Pitch Analysis ===
selectObject: refSound
refPitch = To Pitch: 0, 75, 600
refMeanPitch = Get mean: 0, 0, "Hertz"
refStdevPitch = Get standard deviation: 0, 0, "Hertz"

if refMeanPitch = undefined
    refMeanPitch = 0
endif
if refStdevPitch = undefined
    refStdevPitch = 0
endif

selectObject: userSound
userPitch = To Pitch: 0, 75, 600
userMeanPitch = Get mean: 0, 0, "Hertz"
userStdevPitch = Get standard deviation: 0, 0, "Hertz"

if userMeanPitch = undefined
    userMeanPitch = 0
endif
if userStdevPitch = undefined
    userStdevPitch = 0
endif

# === Pitch Contour Comparison ===
# 40 sample points, only voiced pairs counted
numSamples = 40
sumXY = 0
sumX = 0
sumY = 0
sumX2 = 0
sumY2 = 0
validPairs = 0

for i from 1 to numSamples
    tNorm = (i - 0.5) / numSamples

    refTime = tNorm * refDuration
    userTime = tNorm * userDuration

    selectObject: refPitch
    refVal = Get value at time: refTime, "Hertz", "Linear"

    selectObject: userPitch
    userVal = Get value at time: userTime, "Hertz", "Linear"

    if refVal <> undefined and userVal <> undefined
        sumXY = sumXY + refVal * userVal
        sumX = sumX + refVal
        sumY = sumY + userVal
        sumX2 = sumX2 + refVal * refVal
        sumY2 = sumY2 + userVal * userVal
        validPairs = validPairs + 1
    endif
endfor

# Pearson correlation for pitch
if validPairs >= 3
    meanX = sumX / validPairs
    meanY = sumY / validPairs
    numerator = sumXY - validPairs * meanX * meanY
    denomX = sqrt(sumX2 - validPairs * meanX * meanX)
    denomY = sqrt(sumY2 - validPairs * meanY * meanY)
    if denomX > 0 and denomY > 0
        pitchCorrelation = numerator / (denomX * denomY)
    else
        if refMeanPitch > 0 and userMeanPitch > 0
            pitchDiff = abs(refMeanPitch - userMeanPitch)
            if pitchDiff < 30
                pitchCorrelation = 1 - pitchDiff / 30
            else
                pitchCorrelation = 0
            endif
        else
            pitchCorrelation = 0
        endif
    endif
else
    if refMeanPitch > 0 and userMeanPitch > 0
        pitchDiff = abs(refMeanPitch - userMeanPitch)
        pitchCorrelation = exp(-pitchDiff / 50)
    else
        pitchCorrelation = 0
    endif
endif

if pitchCorrelation > 1
    pitchCorrelation = 1
endif
if pitchCorrelation < -1
    pitchCorrelation = -1
endif

# === Formant Comparison ===
# Use 4500Hz ceiling — correct for 16kHz audio (Nyquist=8kHz)
# Previous 5500Hz was too high for 16kHz, causing unreliable F1/F2
selectObject: refSound
refFormant = To Formant (burg): 0, 5, 4500, 0.025, 50

selectObject: userSound
userFormant = To Formant (burg): 0, 5, 4500, 0.025, 50

formantSamples = 10
sumRefF1 = 0
sumRefF2 = 0
sumUserF1 = 0
sumUserF2 = 0
validFormantPairs = 0

for i from 1 to formantSamples
    tNorm = (i - 0.5) / formantSamples
    refTime = tNorm * refDuration
    userTime = tNorm * userDuration

    selectObject: refFormant
    rf1 = Get value at time: 1, refTime, "Hertz", "Linear"
    rf2 = Get value at time: 2, refTime, "Hertz", "Linear"

    selectObject: userFormant
    uf1 = Get value at time: 1, userTime, "Hertz", "Linear"
    uf2 = Get value at time: 2, userTime, "Hertz", "Linear"

    if rf1 <> undefined and rf2 <> undefined and uf1 <> undefined and uf2 <> undefined
        sumRefF1 = sumRefF1 + rf1
        sumRefF2 = sumRefF2 + rf2
        sumUserF1 = sumUserF1 + uf1
        sumUserF2 = sumUserF2 + uf2
        validFormantPairs = validFormantPairs + 1
    endif
endfor

if validFormantPairs > 0
    refF1 = sumRefF1 / validFormantPairs
    refF2 = sumRefF2 / validFormantPairs
    userF1 = sumUserF1 / validFormantPairs
    userF2 = sumUserF2 / validFormantPairs
else
    selectObject: refFormant
    refF1 = Get mean: 1, 0, 0, "Hertz"
    refF2 = Get mean: 2, 0, 0, "Hertz"
    selectObject: userFormant
    userF1 = Get mean: 1, 0, 0, "Hertz"
    userF2 = Get mean: 2, 0, 0, "Hertz"
    if refF1 = undefined
        refF1 = 0
    endif
    if refF2 = undefined
        refF2 = 0
    endif
    if userF1 = undefined
        userF1 = 0
    endif
    if userF2 = undefined
        userF2 = 0
    endif
endif

# F1/F2 similarity using exponential decay
if refF1 > 0 and userF1 > 0
    f1Diff = abs(refF1 - userF1)
    f1Similarity = exp(-f1Diff / 200) * 100
else
    f1Similarity = 0
endif

if refF2 > 0 and userF2 > 0
    f2Diff = abs(refF2 - userF2)
    f2Similarity = exp(-f2Diff / 300) * 100
else
    f2Similarity = 0
endif

# === Intensity Pattern Comparison ===
selectObject: refSound
refIntensity = To Intensity: 100, 0, "yes"
refMeanIntensity = Get mean: 0, 0, "dB"

selectObject: userSound
userIntensity = To Intensity: 100, 0, "yes"
userMeanIntensity = Get mean: 0, 0, "dB"

if refMeanIntensity = undefined
    refMeanIntensity = 0
endif
if userMeanIntensity = undefined
    userMeanIntensity = 0
endif

sumIXY = 0
sumIX = 0
sumIY = 0
sumIX2 = 0
sumIY2 = 0
validIPairs = 0

for i from 1 to numSamples
    tNorm = (i - 0.5) / numSamples
    refTime = tNorm * refDuration
    userTime = tNorm * userDuration

    selectObject: refIntensity
    refIVal = Get value at time: refTime, "Cubic"

    selectObject: userIntensity
    userIVal = Get value at time: userTime, "Cubic"

    if refIVal <> undefined and userIVal <> undefined
        sumIXY = sumIXY + refIVal * userIVal
        sumIX = sumIX + refIVal
        sumIY = sumIY + userIVal
        sumIX2 = sumIX2 + refIVal * refIVal
        sumIY2 = sumIY2 + userIVal * userIVal
        validIPairs = validIPairs + 1
    endif
endfor

if validIPairs >= 3
    meanIX = sumIX / validIPairs
    meanIY = sumIY / validIPairs
    numI = sumIXY - validIPairs * meanIX * meanIY
    denomIX = sqrt(sumIX2 - validIPairs * meanIX * meanIX)
    denomIY = sqrt(sumIY2 - validIPairs * meanIY * meanIY)
    if denomIX > 0 and denomIY > 0
        intensityCorrelation = numI / (denomIX * denomIY)
    else
        intensityCorrelation = 0
    endif
else
    intensityCorrelation = 0
endif

if intensityCorrelation > 1
    intensityCorrelation = 1
endif
if intensityCorrelation < -1
    intensityCorrelation = -1
endif

# === Pitch contour data for visualization (10 points each) ===
refPitchPoints$ = ""
userPitchPoints$ = ""
vizSamples = 10

for i from 1 to vizSamples
    tNorm = (i - 0.5) / vizSamples

    selectObject: refPitch
    rpv = Get value at time: tNorm * refDuration, "Hertz", "Linear"
    if rpv = undefined
        rpv = 0
    endif

    selectObject: userPitch
    upv = Get value at time: tNorm * userDuration, "Hertz", "Linear"
    if upv = undefined
        upv = 0
    endif

    if i > 1
        refPitchPoints$ = refPitchPoints$ + ","
        userPitchPoints$ = userPitchPoints$ + ","
    endif
    refPitchPoints$ = refPitchPoints$ + fixed$(rpv, 1)
    userPitchPoints$ = userPitchPoints$ + fixed$(upv, 1)
endfor

# === Output as JSON ===
writeInfoLine: "{""success"":true,""pitchCorrelation"":", fixed$(pitchCorrelation, 4), ",""durationRatio"":", fixed$(durationRatio, 4), ",""f1Similarity"":", fixed$(f1Similarity, 2), ",""f2Similarity"":", fixed$(f2Similarity, 2), ",""intensityCorrelation"":", fixed$(intensityCorrelation, 4), ",""ref"":{""meanPitch"":", fixed$(refMeanPitch, 2), ",""f1"":", fixed$(refF1, 2), ",""f2"":", fixed$(refF2, 2), ",""duration"":", fixed$(refDuration, 4), ",""meanIntensity"":", fixed$(refMeanIntensity, 2), "},""user"":{""meanPitch"":", fixed$(userMeanPitch, 2), ",""f1"":", fixed$(userF1, 2), ",""f2"":", fixed$(userF2, 2), ",""duration"":", fixed$(userDuration, 4), ",""meanIntensity"":", fixed$(userMeanIntensity, 2), "},""pitchContour"":{""ref"":[", refPitchPoints$, "],""user"":[", userPitchPoints$, "]}}"

# Cleanup
selectObject: refSound
Remove
selectObject: userSound
Remove
selectObject: refPitch
Remove
selectObject: userPitch
Remove
selectObject: refFormant
Remove
selectObject: userFormant
Remove
selectObject: refIntensity
Remove
selectObject: userIntensity
Remove
