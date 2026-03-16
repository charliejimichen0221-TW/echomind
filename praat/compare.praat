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

# Collect pitch contour in semitones first, then compute delta correlation
numSamples = 40
refBase = 100

# Pass 1: collect raw semitone values
for i from 1 to numSamples
    tNorm = (i - 0.5) / numSamples
    refTime = tNorm * refDuration
    userTime = tNorm * userDuration

    selectObject: refPitch
    refVal = Get value at time: refTime, "Hertz", "Linear"
    selectObject: userPitch
    userVal = Get value at time: userTime, "Hertz", "Linear"

    if refVal <> undefined and refVal > 0
        refST_'i' = 12 * ln(refVal / refBase) / ln(2)
    else
        refST_'i' = undefined
    endif
    if userVal <> undefined and userVal > 0
        userST_'i' = 12 * ln(userVal / refBase) / ln(2)
    else
        userST_'i' = undefined
    endif
endfor

# Pass 2: compute delta-semitone correlation (relative pitch changes)
sumXY = 0
sumX = 0
sumY = 0
sumX2 = 0
sumY2 = 0
validPairs = 0

for i from 2 to numSamples
    prev = i - 1
    if refST_'i' <> undefined and refST_'prev' <> undefined and userST_'i' <> undefined and userST_'prev' <> undefined
        refDelta = refST_'i' - refST_'prev'
        userDelta = userST_'i' - userST_'prev'
        sumXY = sumXY + refDelta * userDelta
        sumX = sumX + refDelta
        sumY = sumY + userDelta
        sumX2 = sumX2 + refDelta * refDelta
        sumY2 = sumY2 + userDelta * userDelta
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
refFormant = To Formant (burg): 0, 5, 5000, 0.025, 50

selectObject: userSound
userFormant = To Formant (burg): 0, 5, 5000, 0.025, 50

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
# Formant Track (40 time-normalized bins, intensity-gated)
# Sample F1/F2 directly from the Formant object at fixed time
# points, using Intensity to filter out silence/noise.
# This avoids PointProcess which can fail on AI-synthesized speech.
# ═══════════════════════════════════════════
formantBins = 40

# Get mean intensity for thresholding (speech = mean - 15 dB)
selectObject: refIntensity
refMeanInt = Get mean: 0, 0, "energy"
refIntThreshold = refMeanInt - 15

selectObject: userIntensity
userMeanInt = Get mean: 0, 0, "energy"
userIntThreshold = userMeanInt - 15

# Build output strings
refF1Track$ = ""
refF2Track$ = ""
userF1Track$ = ""
userF2Track$ = ""
refIntTrack$ = ""
userIntTrack$ = ""

for b from 1 to formantBins
    tNorm = (b - 0.5) / formantBins

    # --- REF ---
    tRef = tNorm * refDuration
    selectObject: refIntensity
    rIntV = Get value at time: tRef, "Cubic"
    if rIntV = undefined
        rIntV = 0
    endif
    avgRF1 = 0
    avgRF2 = 0
    avgRInt = 0
    if rIntV > refIntThreshold
        selectObject: refFormant
        rf1v = Get value at time: 1, tRef, "Hertz", "Linear"
        rf2v = Get value at time: 2, tRef, "Hertz", "Linear"
        if rf1v <> undefined and rf2v <> undefined and rf1v > 100 and rf2v > 300
            avgRF1 = rf1v
            avgRF2 = rf2v
            avgRInt = rIntV
        endif
    endif

    # --- USER ---
    tUser = tNorm * userDuration
    selectObject: userIntensity
    uIntV = Get value at time: tUser, "Cubic"
    if uIntV = undefined
        uIntV = 0
    endif
    avgUF1 = 0
    avgUF2 = 0
    avgUInt = 0
    if uIntV > userIntThreshold
        selectObject: userFormant
        uf1v = Get value at time: 1, tUser, "Hertz", "Linear"
        uf2v = Get value at time: 2, tUser, "Hertz", "Linear"
        if uf1v <> undefined and uf2v <> undefined and uf1v > 100 and uf2v > 300
            avgUF1 = uf1v
            avgUF2 = uf2v
            avgUInt = uIntV
        endif
    endif

    if b > 1
        refF1Track$ = refF1Track$ + ","
        refF2Track$ = refF2Track$ + ","
        userF1Track$ = userF1Track$ + ","
        userF2Track$ = userF2Track$ + ","
        refIntTrack$ = refIntTrack$ + ","
        userIntTrack$ = userIntTrack$ + ","
    endif
    refF1Track$ = refF1Track$ + fixed$(avgRF1, 1)
    refF2Track$ = refF2Track$ + fixed$(avgRF2, 1)
    userF1Track$ = userF1Track$ + fixed$(avgUF1, 1)
    userF2Track$ = userF2Track$ + fixed$(avgUF2, 1)
    refIntTrack$ = refIntTrack$ + fixed$(avgRInt, 1)
    userIntTrack$ = userIntTrack$ + fixed$(avgUInt, 1)
endfor

# ═══════════════════════════════════════════
# Vowel Nuclei Detection
# Find intensity local maxima → these are vowel centers.
# At each peak, get F1/F2 directly from the Formant object.
# Output up to 8 nuclei per audio (more than enough for any word).
# ═══════════════════════════════════════════
maxNuclei = 8
minPeakDist = 0.06
scanStep = 0.01

# --- REF nuclei ---
selectObject: refIntensity
refMaxInt = Get maximum: 0, 0, "Parabolic"
refNucleiThreshold = refMaxInt - 20

refNucleiF1$ = ""
refNucleiF2$ = ""
refNucleiTime$ = ""
refNucleiInt$ = ""
refNucleiCount = 0
prevRefPeakTime = -1

# Scan for local maxima
scanTime = scanStep
while scanTime < refDuration - scanStep
    selectObject: refIntensity
    valC = Get value at time: scanTime, "Cubic"
    valL = Get value at time: scanTime - scanStep, "Cubic"
    valR = Get value at time: scanTime + scanStep, "Cubic"
    # Also check ±2 steps for broader peaks
    valL2 = Get value at time: scanTime - scanStep*3, "Cubic"
    valR2 = Get value at time: scanTime + scanStep*3, "Cubic"
    if valC = undefined
        valC = 0
    endif
    if valL = undefined
        valL = 0
    endif
    if valR = undefined
        valR = 0
    endif
    if valL2 = undefined
        valL2 = 0
    endif
    if valR2 = undefined
        valR2 = 0
    endif
    
    # Local maximum: higher than all neighbors and above threshold
    if valC > valL and valC > valR and valC > valL2 and valC > valR2 and valC > refNucleiThreshold
        # Check minimum distance from previous peak
        if prevRefPeakTime < 0 or (scanTime - prevRefPeakTime) >= minPeakDist
            # Get F1/F2 at this time
            selectObject: refFormant
            nf1 = Get value at time: 1, scanTime, "Hertz", "Linear"
            nf2 = Get value at time: 2, scanTime, "Hertz", "Linear"
            if nf1 <> undefined and nf2 <> undefined and nf1 > 300 and nf2 > 800
                if refNucleiCount > 0
                    refNucleiF1$ = refNucleiF1$ + ","
                    refNucleiF2$ = refNucleiF2$ + ","
                    refNucleiTime$ = refNucleiTime$ + ","
                    refNucleiInt$ = refNucleiInt$ + ","
                endif
                refNucleiF1$ = refNucleiF1$ + fixed$(nf1, 1)
                refNucleiF2$ = refNucleiF2$ + fixed$(nf2, 1)
                refNucleiTime$ = refNucleiTime$ + fixed$(scanTime, 3)
                refNucleiInt$ = refNucleiInt$ + fixed$(valC, 1)
                refNucleiCount = refNucleiCount + 1
                prevRefPeakTime = scanTime
            endif
        endif
        endif
        endif
    if refNucleiCount >= maxNuclei
        scanTime = refDuration
    endif
    scanTime = scanTime + scanStep
endwhile

# --- USER nuclei ---
selectObject: userIntensity
userMaxInt = Get maximum: 0, 0, "Parabolic"
userNucleiThreshold = userMaxInt - 20

userNucleiF1$ = ""
userNucleiF2$ = ""
userNucleiTime$ = ""
userNucleiInt$ = ""
userNucleiCount = 0
prevUserPeakTime = -1

scanTime = scanStep
while scanTime < userDuration - scanStep
    selectObject: userIntensity
    valC = Get value at time: scanTime, "Cubic"
    valL = Get value at time: scanTime - scanStep, "Cubic"
    valR = Get value at time: scanTime + scanStep, "Cubic"
    valL2 = Get value at time: scanTime - scanStep*3, "Cubic"
    valR2 = Get value at time: scanTime + scanStep*3, "Cubic"
    if valC = undefined
        valC = 0
    endif
    if valL = undefined
        valL = 0
    endif
    if valR = undefined
        valR = 0
    endif
    if valL2 = undefined
        valL2 = 0
    endif
    if valR2 = undefined
        valR2 = 0
    endif
    
    if valC > valL and valC > valR and valC > valL2 and valC > valR2 and valC > userNucleiThreshold
        if prevUserPeakTime < 0 or (scanTime - prevUserPeakTime) >= minPeakDist
            selectObject: userFormant
            nf1 = Get value at time: 1, scanTime, "Hertz", "Linear"
            nf2 = Get value at time: 2, scanTime, "Hertz", "Linear"
            if nf1 <> undefined and nf2 <> undefined and nf1 > 300 and nf2 > 800
                if userNucleiCount > 0
                    userNucleiF1$ = userNucleiF1$ + ","
                    userNucleiF2$ = userNucleiF2$ + ","
                    userNucleiTime$ = userNucleiTime$ + ","
                    userNucleiInt$ = userNucleiInt$ + ","
                endif
                userNucleiF1$ = userNucleiF1$ + fixed$(nf1, 1)
                userNucleiF2$ = userNucleiF2$ + fixed$(nf2, 1)
                userNucleiTime$ = userNucleiTime$ + fixed$(scanTime, 3)
                userNucleiInt$ = userNucleiInt$ + fixed$(valC, 1)
                userNucleiCount = userNucleiCount + 1
                prevUserPeakTime = scanTime
            endif
        endif
    endif
    if userNucleiCount >= maxNuclei
        scanTime = userDuration
    endif
    scanTime = scanTime + scanStep
endwhile

# ═══════════════════════════════════════════
# JSON Output
# ═══════════════════════════════════════════
writeInfoLine: "{""success"":true,""pitchCorrelation"":", fixed$(pitchCorrelation, 4), ",""durationRatio"":", fixed$(durationRatio, 4), ",""f1Similarity"":", fixed$(f1Similarity, 2), ",""f2Similarity"":", fixed$(f2Similarity, 2), ",""intensityCorrelation"":", fixed$(intensityCorrelation, 4), ",""ref"":{""meanPitch"":", fixed$(refMeanPitch, 2), ",""f1"":", fixed$(refF1, 2), ",""f2"":", fixed$(refF2, 2), ",""duration"":", fixed$(refDuration, 4), ",""meanIntensity"":", fixed$(refMeanIntensity, 2), "},""user"":{""meanPitch"":", fixed$(userMeanPitch, 2), ",""f1"":", fixed$(userF1, 2), ",""f2"":", fixed$(userF2, 2), ",""duration"":", fixed$(userDuration, 4), ",""meanIntensity"":", fixed$(userMeanIntensity, 2), "},""pitchContour"":{""ref"":[", refPitchPoints$, "],""user"":[", userPitchPoints$, "]},""formantTrack"":{""refF1"":[", refF1Track$, "],""refF2"":[", refF2Track$, "],""userF1"":[", userF1Track$, "],""userF2"":[", userF2Track$, "],""refInt"":[", refIntTrack$, "],""userInt"":[", userIntTrack$, "]},""vowelNuclei"":{""ref"":{""f1"":[", refNucleiF1$, "],""f2"":[", refNucleiF2$, "],""time"":[", refNucleiTime$, "],""int"":[", refNucleiInt$, "]},""user"":{""f1"":[", userNucleiF1$, "],""f2"":[", userNucleiF2$, "],""time"":[", userNucleiTime$, "],""int"":[", userNucleiInt$, "]}}}"

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
