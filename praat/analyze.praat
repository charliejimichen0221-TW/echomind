# ===================================================
# EchoMind Pronunciation Analysis Script for Praat
# Analyzes: Pitch, Formants, Intensity, Duration, HNR
# Outputs JSON-formatted results to stdout
# Robust: all values initialized, all edge cases handled
# ===================================================

form Analyze pronunciation
    text wavFile
endform

# Read the sound file
sound = Read from file: wavFile$

# Get basic info
duration = Get total duration
sampleRate = Get sampling frequency

# Initialize all values to safe defaults
meanPitch = 0
minPitch = 0
maxPitch = 0
stdevPitch = 0
voicedRatio = 0
f1_mean = 0
f2_mean = 0
f3_mean = 0
meanIntensity = 0
minIntensity = 0
maxIntensity = 0
stdevIntensity = 0
jitter = 0
shimmer = 0
hnr = 0
speechRate = 0
numPeaks = 0

# --- Intensity Analysis ---
selectObject: sound
intensity_obj = To Intensity: 100, 0, "yes"
meanIntensity = Get mean: 0, 0, "dB"

if meanIntensity = undefined
    meanIntensity = 0
endif

# If mean intensity is too low, output silence result
if meanIntensity < 25
    writeInfoLine: "{""success"":true,""pitch"":{""mean"":0,""min"":0,""max"":0,""stdev"":0},""formants"":{""f1_mean"":0,""f2_mean"":0,""f3_mean"":0},""intensity"":{""mean"":", fixed$(meanIntensity, 2), ",""min"":0,""max"":0,""stdev"":0},""duration"":", fixed$(duration, 4), ",""voicedFraction"":0,""jitter"":0,""shimmer"":0,""hnr"":0,""speechRate"":0}"
    selectObject: intensity_obj
    Remove
    selectObject: sound
    Remove
    exitScript ()
endif

selectObject: intensity_obj
minIntensity = Get minimum: 0, 0, "Parabolic"
maxIntensity = Get maximum: 0, 0, "Parabolic"
stdevIntensity = Get standard deviation: 0, 0

if minIntensity = undefined
    minIntensity = 0
endif
if maxIntensity = undefined
    maxIntensity = 0
endif
if stdevIntensity = undefined
    stdevIntensity = 0
endif

# --- Pitch Analysis ---
selectObject: sound
pitch = To Pitch: 0, 75, 600

meanPitch = Get mean: 0, 0, "Hertz"
minPitch = Get minimum: 0, 0, "Hertz", "Parabolic"
maxPitch = Get maximum: 0, 0, "Hertz", "Parabolic"
stdevPitch = Get standard deviation: 0, 0, "Hertz"
voicedFraction = Count voiced frames
totalFrames = Get number of frames
if totalFrames > 0
    voicedRatio = voicedFraction / totalFrames
else
    voicedRatio = 0
endif

if meanPitch = undefined
    meanPitch = 0
endif
if minPitch = undefined
    minPitch = 0
endif
if maxPitch = undefined
    maxPitch = 0
endif
if stdevPitch = undefined
    stdevPitch = 0
endif

# --- Formant Analysis ---
selectObject: sound
formant = To Formant (burg): 0, 5, 5500, 0.025, 50

f1_mean = Get mean: 1, 0, 0, "Hertz"
f2_mean = Get mean: 2, 0, 0, "Hertz"
f3_mean = Get mean: 3, 0, 0, "Hertz"

if f1_mean = undefined
    f1_mean = 0
endif
if f2_mean = undefined
    f2_mean = 0
endif
if f3_mean = undefined
    f3_mean = 0
endif

# --- Jitter (from PointProcess only) ---
# Get jitter (local) is a PointProcess-only command
selectObject: sound
pointProcess = noprogress To PointProcess (periodic, cc): 75, 600
numPoints = Get number of points

if numPoints >= 3
    selectObject: pointProcess
    jitter = Get jitter (local): 0, 0, 0.0001, 0.02, 1.3
    if jitter = undefined
        jitter = 0
    endif
else
    jitter = 0
endif

# --- Shimmer (requires Sound + PointProcess) ---
if numPoints >= 3
    selectObject: sound
    plusObject: pointProcess
    shimmer = Get shimmer (local): 0, 0, 0.0001, 0.02, 1.3, 1.6
    if shimmer = undefined
        shimmer = 0
    endif
else
    shimmer = 0
endif

# --- Harmonics-to-Noise Ratio ---
selectObject: sound
harmonicity = noprogress To Harmonicity (cc): 0.01, 75, 0.1, 1.0
hnr = Get mean: 0, 0

if hnr = undefined
    hnr = 0
endif

# --- Estimate speech rate (syllable nuclei count) ---
selectObject: intensity_obj
numPeaks = 0
nframes = Get number of frames
for i from 2 to nframes - 1
    val = Get value in frame: i
    prev_val = Get value in frame: i - 1
    next_val = Get value in frame: i + 1
    if val <> undefined and prev_val <> undefined and next_val <> undefined
        if val > prev_val and val > next_val and val > meanIntensity - 5
            numPeaks = numPeaks + 1
        endif
    endif
endfor

if duration > 0
    speechRate = numPeaks / duration
else
    speechRate = 0
endif

# --- Output as JSON ---
writeInfoLine: "{""success"":true,""pitch"":{""mean"":", fixed$(meanPitch, 2), ",""min"":", fixed$(minPitch, 2), ",""max"":", fixed$(maxPitch, 2), ",""stdev"":", fixed$(stdevPitch, 2), "},""formants"":{""f1_mean"":", fixed$(f1_mean, 2), ",""f2_mean"":", fixed$(f2_mean, 2), ",""f3_mean"":", fixed$(f3_mean, 2), "},""intensity"":{""mean"":", fixed$(meanIntensity, 2), ",""min"":", fixed$(minIntensity, 2), ",""max"":", fixed$(maxIntensity, 2), ",""stdev"":", fixed$(stdevIntensity, 2), "},""duration"":", fixed$(duration, 4), ",""voicedFraction"":", fixed$(voicedRatio, 4), ",""jitter"":", fixed$(jitter, 6), ",""shimmer"":", fixed$(shimmer, 6), ",""hnr"":", fixed$(hnr, 2), ",""speechRate"":", fixed$(speechRate, 2), "}"

# Cleanup all objects
selectObject: intensity_obj
Remove
selectObject: pitch
Remove
selectObject: formant
Remove
selectObject: pointProcess
Remove
selectObject: harmonicity
Remove
selectObject: sound
Remove
