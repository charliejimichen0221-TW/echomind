"""
Forced alignment using MMS_FA (torchaudio).
Input: WAV file path + transcript word
Output: JSON with phoneme time ranges (vowels expanded to fill inter-consonant gaps)

Usage: python forced_align.py <wav_path> <word> <phonemes_comma_separated>
Example: python forced_align.py audio.wav hypothesis HH,AY,P,AA,TH,AH,S,IH,S
"""
import sys, json, torch, torchaudio
import scipy.io.wavfile as wavfile
import numpy as np

wav_path = sys.argv[1]
word = sys.argv[2]
phonemes_arpabet = sys.argv[3].split(',')

VOWELS = {'AA','AE','AH','AO','AW','AY','EH','ER','EY','IH','IY','OW','OY','UH','UW'}

# Load model
device = torch.device("cpu")
bundle = torchaudio.pipelines.MMS_FA
model = bundle.get_model().to(device)
DICTIONARY = bundle.get_dict()

# Load audio
sr, audio_np = wavfile.read(wav_path)
if audio_np.dtype == np.int16:
    audio_np = audio_np.astype(np.float32) / 32768.0
elif audio_np.dtype == np.int32:
    audio_np = audio_np.astype(np.float32) / 2147483648.0
waveform = torch.from_numpy(audio_np).unsqueeze(0)
if waveform.ndim == 3:
    waveform = waveform[:, :, 0]
if sr != bundle.sample_rate:
    waveform = torchaudio.functional.resample(waveform, sr, bundle.sample_rate)

# Tokenize
transcript = word.lower()
chars = [c for c in transcript if c in DICTIONARY]
tokens = [DICTIONARY[c] for c in chars]

# Run model
with torch.inference_mode():
    emission, _ = model(waveform.to(device))

# Force align
token_tensor = torch.tensor([tokens], dtype=torch.int32)
aligned_tokens, scores = torchaudio.functional.forced_align(emission, token_tensor, blank=0)

# Convert to time
ratio = waveform.shape[1] / emission.shape[1] / bundle.sample_rate

# Group into characters
alignments = []
token_idx = 0
i = 0
while i < aligned_tokens.shape[1]:
    if aligned_tokens[0, i] != 0:
        start_frame = i
        current_token = aligned_tokens[0, i].item()
        while i < aligned_tokens.shape[1] and aligned_tokens[0, i] == current_token:
            i += 1
        end_frame = i
        if token_idx < len(chars):
            alignments.append({
                'char': chars[token_idx],
                'start': round(start_frame * ratio, 4),
                'end': round(end_frame * ratio, 4),
                'score': round(scores[0, start_frame:end_frame].mean().item(), 3)
            })
            token_idx += 1
    else:
        i += 1

# Map characters to phonemes
phoneme_ranges = []
ci = 0
for phoneme in phonemes_arpabet:
    if phoneme == 'TH' or phoneme == 'DH' or phoneme == 'CH' or phoneme == 'JH' or phoneme == 'SH' or phoneme == 'ZH' or phoneme == 'NG':
        # Digraph phonemes: check if spans 2 characters
        # TH='t'+'h', SH='s'+'h', CH='c'+'h', NG='n'+'g', etc.
        if ci + 1 < len(alignments):
            phoneme_ranges.append({
                'phoneme': phoneme,
                'start': alignments[ci]['start'],
                'end': alignments[ci + 1]['end'],
                'is_vowel': phoneme in VOWELS
            })
            ci += 2
        elif ci < len(alignments):
            phoneme_ranges.append({
                'phoneme': phoneme,
                'start': alignments[ci]['start'],
                'end': alignments[ci]['end'],
                'is_vowel': phoneme in VOWELS
            })
            ci += 1
    else:
        if ci < len(alignments):
            phoneme_ranges.append({
                'phoneme': phoneme,
                'start': alignments[ci]['start'],
                'end': alignments[ci]['end'],
                'is_vowel': phoneme in VOWELS
            })
            ci += 1

# Expand vowel ranges to fill inter-consonant gaps
for i, p in enumerate(phoneme_ranges):
    if not p['is_vowel']:
        continue
    if i > 0:
        phoneme_ranges[i]['start'] = phoneme_ranges[i - 1]['end']
    if i < len(phoneme_ranges) - 1:
        phoneme_ranges[i]['end'] = phoneme_ranges[i + 1]['start']

# Build output: only vowel ranges needed for formant analysis
vowel_ranges = []
syl_idx = 0
for p in phoneme_ranges:
    if p['is_vowel']:
        vowel_ranges.append({
            'phoneme': p['phoneme'],
            'start': p['start'],
            'end': p['end'],
            'syllable_index': syl_idx
        })
        syl_idx += 1

result = {
    'word': word,
    'phonemes': phoneme_ranges,
    'vowels': vowel_ranges
}

print(json.dumps(result))
