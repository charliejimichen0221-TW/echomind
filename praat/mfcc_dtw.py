"""
EchoMind MFCC-DTW Distance Calculator
Computes spectral similarity between two WAV files using:
  1. MFCC extraction (13 coefficients, mel-scale filterbank)
  2. DTW alignment (dynamic time warping)
  3. Normalized distance output

Usage:
    python mfcc_dtw.py <ref.wav> <user.wav>

Output (JSON):
    {"distance": 12.34, "normalizedDistance": 0.45}
"""

import sys
import json
import wave
import struct
import numpy as np


def load_wav(path: str) -> tuple:
    """Load WAV file, return (samples_float, sample_rate)."""
    with wave.open(path, 'rb') as w:
        n = w.getnframes()
        rate = w.getframerate()
        frames = w.readframes(n)
        samples = struct.unpack(f'<{len(frames)//2}h', frames)
        return np.array(samples, dtype=np.float64) / 32768.0, rate


def mel_filterbank(num_filters: int, fft_size: int, sample_rate: int) -> np.ndarray:
    """Create mel-scale triangular filterbank."""
    low_mel = 0
    high_mel = 2595 * np.log10(1 + (sample_rate / 2) / 700)
    mel_points = np.linspace(low_mel, high_mel, num_filters + 2)
    hz_points = 700 * (10 ** (mel_points / 2595) - 1)
    bins = np.floor((fft_size + 1) * hz_points / sample_rate).astype(int)

    fb = np.zeros((num_filters, fft_size // 2 + 1))
    for i in range(num_filters):
        for j in range(bins[i], bins[i + 1]):
            fb[i, j] = (j - bins[i]) / max(1, bins[i + 1] - bins[i])
        for j in range(bins[i + 1], bins[i + 2]):
            fb[i, j] = (bins[i + 2] - j) / max(1, bins[i + 2] - bins[i + 1])
    return fb


def extract_mfcc(samples: np.ndarray, sample_rate: int,
                 num_coeffs: int = 13, num_filters: int = 26,
                 frame_len: float = 0.025, frame_step: float = 0.010) -> np.ndarray:
    """Extract MFCC features from audio samples."""
    # Pre-emphasis
    emphasized = np.append(samples[0], samples[1:] - 0.97 * samples[:-1])

    # Framing
    frame_size = int(frame_len * sample_rate)
    step_size = int(frame_step * sample_rate)
    num_frames = max(1, 1 + (len(emphasized) - frame_size) // step_size)

    frames = np.zeros((num_frames, frame_size))
    for i in range(num_frames):
        start = i * step_size
        end = min(start + frame_size, len(emphasized))
        frames[i, :end - start] = emphasized[start:end]

    # Hamming window
    frames *= np.hamming(frame_size)

    # FFT
    fft_size = 512
    mag = np.abs(np.fft.rfft(frames, n=fft_size))
    power = mag ** 2 / fft_size

    # Mel filterbank
    fb = mel_filterbank(num_filters, fft_size, sample_rate)
    mel_energy = np.dot(power, fb.T)
    mel_energy = np.where(mel_energy == 0, np.finfo(float).eps, mel_energy)
    log_mel = np.log(mel_energy)

    # DCT (type-II) to get MFCCs
    from scipy.fft import dct
    mfcc = dct(log_mel, type=2, axis=1, norm='ortho')[:, :num_coeffs]

    # Cepstral mean normalization (removes channel effects)
    mfcc -= np.mean(mfcc, axis=0)

    return mfcc


def dtw_distance(mfcc1: np.ndarray, mfcc2: np.ndarray) -> float:
    """Compute DTW distance between two MFCC sequences."""
    n, m = len(mfcc1), len(mfcc2)

    # Cost matrix: Euclidean distance between each pair of frames
    cost = np.zeros((n, m))
    for i in range(n):
        cost[i] = np.sqrt(np.sum((mfcc1[i] - mfcc2) ** 2, axis=1))

    # Accumulated cost matrix with standard DTW constraints
    D = np.full((n + 1, m + 1), np.inf)
    D[0, 0] = 0

    for i in range(1, n + 1):
        for j in range(1, m + 1):
            D[i, j] = cost[i - 1, j - 1] + min(D[i - 1, j], D[i, j - 1], D[i - 1, j - 1])

    # Normalize by path length
    path_len = n + m  # approximate path length
    return D[n, m] / path_len


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: python mfcc_dtw.py <ref.wav> <user.wav>"}))
        sys.exit(1)

    ref_path = sys.argv[1]
    user_path = sys.argv[2]

    try:
        ref_samples, ref_rate = load_wav(ref_path)
        user_samples, user_rate = load_wav(user_path)

        # Resample to common rate if needed (simple decimation/interpolation)
        target_rate = 16000
        if ref_rate != target_rate:
            from scipy.signal import resample
            ref_samples = resample(ref_samples, int(len(ref_samples) * target_rate / ref_rate))
        if user_rate != target_rate:
            from scipy.signal import resample
            user_samples = resample(user_samples, int(len(user_samples) * target_rate / user_rate))

        # Extract MFCCs
        ref_mfcc = extract_mfcc(ref_samples, target_rate)
        user_mfcc = extract_mfcc(user_samples, target_rate)

        # Compute DTW distance
        dist = dtw_distance(ref_mfcc, user_mfcc)

        print(json.dumps({
            "distance": round(dist, 4),
            "refFrames": len(ref_mfcc),
            "userFrames": len(user_mfcc),
        }))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
