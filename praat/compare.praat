# ===================================================
# EchoMind Pronunciation Comparison Script v2
# 
# Compares user speech against AI reference using:
# 1. Pitch contour correlation (semitone-based)
# 2. Voiced-only formant comparison (F1/F2)
# 3. Intensity pattern correlation
# 4. Duration ratio
#
# Note: MFCC-DTW is computed separately via Python.
# Both files are resampled to 16kHz for fair comparison.
# ===================================================

form Compare pronunciation
    text refFile
    text userFile
endform

# === Read and resample to common 16kHz ===
refSound = Read from file: refFile$
refRate = Get sampling frequency
userSound = Read from file: userFile$
userRate = Get sampling frequency

targetRate = 16000

if refRate <> targetRate
    selectObject: refSound
    refResampled = Resample: targetRate, 50
    selectObject: refSound
    Remove
    refSound = refResampled
endif

if userRate <> targetRate
    selectObject: userSound
    userResampled = Resample: targetRate, 50
    selectObject: userSound
    Remove
    userSound = userResampled
endif

selectObject: refSound
refDuration = Get total duration
selectObject: userSound
userDuration = Get total duration

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

# ═══════════════════════════════════════════
# 1. Duration Ratio
# ═══════════════════════════════════════════
if refDuration > 0
    durationRatio = userDuration / refDuration
else
    durationRatio = 0
endif

# ═══════════════════════════════════════════
# 2. Pitch Analysis (semitone-based contour)
# ═══════════════════════════════════════════
selectObject: refSound
refPitch = To Pitch: 0, 75, 600
refMeanPitch = Get mean: 0, 0, "Hertz"
if refMeanPitch = undefined
    refMeanPitch = 0
endif

selectObject: userSound
userPitch = To Pitch: 0, 75, 600
userMeanPitch = Get mean: 0, 0, "Hertz"
if userMeanPitch = undefined
    userMeanPitch = 0
endif

# Pearson correlation on semitone contours (40 samples)
numSamples = 40
sumXY = 0
sumX = 0
sumY = 0
sumX2 = 0
sumY2 = 0
validPairs = 0
refBase = 100

for i from 1 to numSamples
    tNorm = (i - 0.5) / numSamples
    refTime = tNorm * refDuration
    userTime = tNorm * userDuration

    selectObject: refPitch
    refVal = Get value at time: refTime, "Hertz", "Linear"
    selectObject: userPitch
    userVal = Get value at time: userTime, "Hertz", "Linear"

    if refVal <> undefined and userVal <> undefined and refVal > 0 and userVal > 0
        refST = 12 * ln(refVal / refBase) / ln(2)
        userST = 12 * ln(userVal / refBase) / ln(2)
        sumXY = sumXY + refST * userST
        sumX = sumX + refST
        sumY = sumY + userST
        sumX2 = sumX2 + refST * refST
        sumY2 = sumY2 + userST * userST
        validPairs = validPairs + 1
    endif
endfor

if validPairs >= 3
    meanX = sumX / validPairs
    meanY = sumY / validPairs
    numerator = sumXY - validPairs * meanX * meanY
    denomX2 = sumX2 - validPairs * meanX * meanX
    denomY2 = sumY2 - validPairs * meanY * meanY
    if denomX2 > 0 and denomY2 > 0
        pitchCorrelation = numerator / (sqrt(denomX2) * sqrt(denomY2))
    else
        if refMeanPitch > 0 and userMeanPitch > 0
            pitchDiff = abs(refMeanPitch - userMeanPitch)
            if pitchDiff < 30
                pitchCorrelation = 1 - pitchDiff / 30
            else
                pitchCorrelation = 0
            endif
        endif
    endif
else
    if refMeanPitch > 0 and userMeanPitch > 0
        pitchDiff = abs(refMeanPitch - userMeanPitch)
        pitchCorrelation = exp(-pitchDiff / 50)
    endif
endif

if pitchCorrelation > 1
    pitchCorrelation = 1
endif
if pitchCorrelation < -1
    pitchCorrelation = -1
endif

# ═══════════════════════════════════════════
# 3. Formant Comparison (voiced-only sampling)
# ═══════════════════════════════════════════
selectObject: refSound
refFormant = To Formant (burg): 0, 5, 4500, 0.025, 50

selectObject: userSound
userFormant = To Formant (burg): 0, 5, 4500, 0.025, 50

# Get voiced glottal pulses for precision sampling
selectObject: refSound
plus refPitch
refPP = To PointProcess (cc)

selectObject: userSound
plus userPitch
userPP = To PointProcess (cc)

# Sample ref formants at voiced pulses only
selectObject: refPP
refNumVoiced = Get number of points
sumRefF1 = 0
sumRefF2 = 0
validRefFormants = 0

for i from 1 to refNumVoiced
    selectObject: refPP
    t = Get time from index: i
    selectObject: refFormant
    rf1 = Get value at time: 1, t, "Hertz", "Linear"
    rf2 = Get value at time: 2, t, "Hertz", "Linear"
    if rf1 <> undefined and rf2 <> undefined and rf1 > 100 and rf2 > 500
        sumRefF1 = sumRefF1 + rf1
        sumRefF2 = sumRefF2 + rf2
        validRefFormants = validRefFormants + 1
    endif
endfor

# Sample user formants at voiced pulses only
selectObject: userPP
userNumVoiced = Get number of points
sumUserF1 = 0
sumUserF2 = 0
validUserFormants = 0

for i from 1 to userNumVoiced
    selectObject: userPP
    t = Get time from index: i
    selectObject: userFormant
    uf1 = Get value at time: 1, t, "Hertz", "Linear"
    uf2 = Get value at time: 2, t, "Hertz", "Linear"
    if uf1 <> undefined and uf2 <> undefined and uf1 > 100 and uf2 > 500
        sumUserF1 = sumUserF1 + uf1
        sumUserF2 = sumUserF2 + uf2
        validUserFormants = validUserFormants + 1
    endif
endfor

if validRefFormants > 0
    refF1 = sumRefF1 / validRefFormants
    refF2 = sumRefF2 / validRefFormants
endif
if validUserFormants > 0
    userF1 = sumUserF1 / validUserFormants
    userF2 = sumUserF2 / validUserFormants
endif

if refF1 > 0 and userF1 > 0
    f1Diff = abs(refF1 - userF1)
    f1Similarity = exp(-f1Diff / 200) * 100
endif

if refF2 > 0 and userF2 > 0
    f2Diff = abs(refF2 - userF2)
    f2Similarity = exp(-f2Diff / 300) * 100
endif

# ═══════════════════════════════════════════
# 4. Intensity Pattern Correlation
# ═══════════════════════════════════════════
selectObject: refSound
refIntensity = To Intensity: 100, 0, "yes"
refMeanIntensity = Get mean: 0, 0, "dB"
if refMeanIntensity = undefined
    refMeanIntensity = 0
endif

selectObject: userSound
userIntensity = To Intensity: 100, 0, "yes"
userMeanIntensity = Get mean: 0, 0, "dB"
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
    denomIX2 = sumIX2 - validIPairs * meanIX * meanIX
    denomIY2 = sumIY2 - validIPairs * meanIY * meanIY
    if denomIX2 > 0 and denomIY2 > 0
        intensityCorrelation = numI / (sqrt(denomIX2) * sqrt(denomIY2))
    endif
endif

if intensityCorrelation > 1
    intensityCorrelation = 1
endif
if intensityCorrelation < -1
    intensityCorrelation = -1
endif

# ═══════════════════════════════════════════
# Pitch Contour Visualization (10 points)
# ═══════════════════════════════════════════
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

# ═══════════════════════════════════════════
# JSON Output
# ═══════════════════════════════════════════
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
selectObject: refPP
Remove
selectObject: userPP
Remove
