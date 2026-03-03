"""
Prototype: DTW-aligned Pitch vs Linear Pitch Comparison
Verifies the effect of using DTW warping path to align pitch contours
instead of linear time normalization.

Runs on existing debug audio files and outputs a side-by-side comparison.
"""
import os, sys, json, wave, struct
import numpy as np

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

# ═══════════════════════════════════════════
# Reuse from mfcc_dtw.py
# ═══════════════════════════════════════════

def load_wav(path):
    with wave.open(path, 'rb') as w:
        n = w.getnframes()
        rate = w.getframerate()
        frames = w.readframes(n)
        samples = struct.unpack(f'<{n}h', frames)
        return np.array(samples, dtype=np.float64) / 32768.0, rate


def mel_filterbank(num_filters, fft_size, sample_rate):
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


def extract_mfcc(samples, sample_rate, num_coeffs=13, num_filters=26,
                 frame_len=0.025, frame_step=0.010):
    emphasized = np.append(samples[0], samples[1:] - 0.97 * samples[:-1])
    frame_size = int(frame_len * sample_rate)
    step_size = int(frame_step * sample_rate)
    num_frames = max(1, 1 + (len(emphasized) - frame_size) // step_size)

    frames = np.zeros((num_frames, frame_size))
    for i in range(num_frames):
        start = i * step_size
        end = min(start + frame_size, len(emphasized))
        frames[i, :end - start] = emphasized[start:end]

    frames *= np.hamming(frame_size)
    fft_size = 512
    mag = np.abs(np.fft.rfft(frames, n=fft_size))
    power = mag ** 2 / fft_size
    fb = mel_filterbank(num_filters, fft_size, sample_rate)
    mel_energy = np.dot(power, fb.T)
    mel_energy = np.where(mel_energy == 0, np.finfo(float).eps, mel_energy)
    log_mel = np.log(mel_energy)
    from scipy.fft import dct
    mfcc = dct(log_mel, type=2, axis=1, norm='ortho')[:, :num_coeffs]
    mfcc -= np.mean(mfcc, axis=0)
    return mfcc


# ═══════════════════════════════════════════
# DTW with warping path backtracking
# ═══════════════════════════════════════════

def dtw_with_path(mfcc1, mfcc2):
    """Compute DTW distance AND return the warping path."""
    n, m = len(mfcc1), len(mfcc2)

    cost = np.zeros((n, m))
    for i in range(n):
        cost[i] = np.sqrt(np.sum((mfcc1[i] - mfcc2) ** 2, axis=1))

    D = np.full((n + 1, m + 1), np.inf)
    D[0, 0] = 0

    for i in range(1, n + 1):
        for j in range(1, m + 1):
            D[i, j] = cost[i - 1, j - 1] + min(D[i - 1, j], D[i, j - 1], D[i - 1, j - 1])

    # Backtrack to find warping path
    path = []
    i, j = n, m
    while i > 0 and j > 0:
        path.append((i - 1, j - 1))
        candidates = [
            (D[i - 1, j - 1], i - 1, j - 1),
            (D[i - 1, j], i - 1, j),
            (D[i, j - 1], i, j - 1),
        ]
        _, i, j = min(candidates, key=lambda x: x[0])
    path.reverse()

    distance = D[n, m] / (n + m)
    return distance, path


# ═══════════════════════════════════════════
# Pitch extraction (autocorrelation-based F0)
# ═══════════════════════════════════════════

def extract_pitch_per_frame(samples, sample_rate, frame_len=0.025, frame_step=0.010,
                            f0_min=75, f0_max=600):
    """Extract F0 (pitch) for each frame using autocorrelation."""
    frame_size = int(frame_len * sample_rate)
    step_size = int(frame_step * sample_rate)
    num_frames = max(1, 1 + (len(samples) - frame_size) // step_size)

    min_lag = int(sample_rate / f0_max)
    max_lag = int(sample_rate / f0_min)

    pitches = np.zeros(num_frames)

    for i in range(num_frames):
        start = i * step_size
        end = min(start + frame_size, len(samples))
        frame = samples[start:end]

        if len(frame) < max_lag + 1:
            continue

        # Apply Hamming window
        frame = frame * np.hamming(len(frame))

        # Normalized autocorrelation
        frame_energy = np.sum(frame ** 2)
        if frame_energy < 1e-10:
            continue

        best_corr = 0
        best_lag = 0

        for lag in range(min_lag, min(max_lag + 1, len(frame))):
            corr = np.sum(frame[:len(frame) - lag] * frame[lag:])
            # Normalize
            lag_energy = np.sqrt(np.sum(frame[:len(frame) - lag] ** 2) * np.sum(frame[lag:] ** 2))
            if lag_energy > 0:
                corr /= lag_energy

            if corr > best_corr:
                best_corr = corr
                best_lag = lag

        # Only accept if correlation is strong enough (voiced speech)
        if best_corr > 0.3 and best_lag > 0:
            pitches[i] = sample_rate / best_lag

    return pitches


# ═══════════════════════════════════════════
# Linear pitch correlation (current Praat method)
# ═══════════════════════════════════════════

def linear_pitch_correlation(ref_pitch, user_pitch, num_samples=40):
    """Simulate Praat's linear time normalization pitch correlation."""
    ref_len = len(ref_pitch)
    user_len = len(user_pitch)

    ref_vals = []
    user_vals = []

    for i in range(num_samples):
        t_norm = (i + 0.5) / num_samples
        ref_idx = min(int(t_norm * ref_len), ref_len - 1)
        user_idx = min(int(t_norm * user_len), user_len - 1)

        rv = ref_pitch[ref_idx]
        uv = user_pitch[user_idx]

        if rv > 0 and uv > 0:
            # Convert to semitone (base 100Hz)
            ref_vals.append(12 * np.log2(rv / 100))
            user_vals.append(12 * np.log2(uv / 100))

    if len(ref_vals) < 3:
        return 0.0, ref_vals, user_vals

    corr = np.corrcoef(ref_vals, user_vals)[0, 1]
    return float(corr) if not np.isnan(corr) else 0.0, ref_vals, user_vals


# ═══════════════════════════════════════════
# DTW-aligned pitch correlation (new method)
# ═══════════════════════════════════════════

def dtw_aligned_pitch_correlation(ref_pitch, user_pitch, warping_path):
    """Use DTW warping path to align pitch, then compute correlation."""
    ref_vals = []
    user_vals = []

    for ref_idx, user_idx in warping_path:
        if ref_idx < len(ref_pitch) and user_idx < len(user_pitch):
            rv = ref_pitch[ref_idx]
            uv = user_pitch[user_idx]
            if rv > 0 and uv > 0:
                ref_vals.append(12 * np.log2(rv / 100))
                user_vals.append(12 * np.log2(uv / 100))

    if len(ref_vals) < 3:
        return 0.0, ref_vals, user_vals

    corr = np.corrcoef(ref_vals, user_vals)[0, 1]
    return float(corr) if not np.isnan(corr) else 0.0, ref_vals, user_vals


def extract_contour_points(ref_pitch, user_pitch, warping_path, n_points=10):
    """Extract n evenly-spaced aligned pitch points for visualization."""
    # Only keep path points where both have voiced pitch
    voiced_pairs = [(ref_pitch[i], user_pitch[j])
                    for i, j in warping_path
                    if i < len(ref_pitch) and j < len(user_pitch)]

    if len(voiced_pairs) < n_points:
        return [p[0] for p in voiced_pairs], [p[1] for p in voiced_pairs]

    step = len(voiced_pairs) / n_points
    ref_pts = []
    user_pts = []
    for k in range(n_points):
        idx = int(k * step)
        ref_pts.append(round(voiced_pairs[idx][0], 1))
        user_pts.append(round(voiced_pairs[idx][1], 1))

    return ref_pts, user_pts


# ═══════════════════════════════════════════
# Main: Run comparison
# ═══════════════════════════════════════════

def main():
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "debug")
    ref_path = os.path.join(base, "ref_recording.wav")
    user_path = os.path.join(base, "user_recording.wav")

    for p in [ref_path, user_path]:
        if not os.path.exists(p):
            print(f"ERROR: {p} not found")
            sys.exit(1)

    print("=" * 60)
    print("DTW-ALIGNED PITCH vs LINEAR PITCH — COMPARISON TEST")
    print("=" * 60)

    # Load audio
    ref_samples, ref_rate = load_wav(ref_path)
    user_samples, user_rate = load_wav(user_path)

    target_rate = 16000
    if ref_rate != target_rate:
        from scipy.signal import resample
        ref_samples = resample(ref_samples, int(len(ref_samples) * target_rate / ref_rate))
    if user_rate != target_rate:
        from scipy.signal import resample
        user_samples = resample(user_samples, int(len(user_samples) * target_rate / user_rate))

    print(f"\nRef:  {len(ref_samples)/target_rate:.2f}s")
    print(f"User: {len(user_samples)/target_rate:.2f}s")
    print(f"Speed ratio: {len(user_samples)/len(ref_samples):.2f}x")

    # Extract MFCCs
    ref_mfcc = extract_mfcc(ref_samples, target_rate)
    user_mfcc = extract_mfcc(user_samples, target_rate)
    print(f"\nMFCC frames — Ref: {len(ref_mfcc)}, User: {len(user_mfcc)}")

    # Extract pitch per frame (same frame grid as MFCC)
    print("\nExtracting pitch per frame...")
    ref_pitch = extract_pitch_per_frame(ref_samples, target_rate)
    user_pitch = extract_pitch_per_frame(user_samples, target_rate)

    ref_voiced = np.sum(ref_pitch > 0)
    user_voiced = np.sum(user_pitch > 0)
    print(f"Voiced frames — Ref: {ref_voiced}/{len(ref_pitch)} ({100*ref_voiced/len(ref_pitch):.0f}%), "
          f"User: {user_voiced}/{len(user_pitch)} ({100*user_voiced/len(user_pitch):.0f}%)")

    if ref_voiced > 0:
        print(f"Ref pitch range: {ref_pitch[ref_pitch>0].min():.0f} - {ref_pitch[ref_pitch>0].max():.0f} Hz "
              f"(mean: {ref_pitch[ref_pitch>0].mean():.0f} Hz)")
    if user_voiced > 0:
        print(f"User pitch range: {user_pitch[user_pitch>0].min():.0f} - {user_pitch[user_pitch>0].max():.0f} Hz "
              f"(mean: {user_pitch[user_pitch>0].mean():.0f} Hz)")

    # DTW with warping path
    print("\nComputing DTW + warping path...")
    distance, path = dtw_with_path(ref_mfcc, user_mfcc)
    print(f"DTW distance: {distance:.4f}")
    print(f"Warping path length: {len(path)} steps")

    # === Method 1: Linear pitch correlation (current) ===
    linear_corr, linear_ref, linear_user = linear_pitch_correlation(ref_pitch, user_pitch)

    # === Method 2: DTW-aligned pitch correlation (new) ===
    dtw_corr, dtw_ref, dtw_user = dtw_aligned_pitch_correlation(ref_pitch, user_pitch, path)

    # === Contour visualization points ===
    contour_ref, contour_user = extract_contour_points(ref_pitch, user_pitch, path, 10)

    print("\n" + "=" * 60)
    print("RESULTS")
    print("=" * 60)

    print(f"\n{'Method':<30} {'Correlation':>12} {'Valid Pairs':>12}")
    print("-" * 56)
    print(f"{'Linear (current Praat)':<30} {linear_corr:>12.4f} {len(linear_ref):>12}")
    print(f"{'DTW-aligned (proposed)':<30} {dtw_corr:>12.4f} {len(dtw_ref):>12}")

    improvement = dtw_corr - linear_corr
    print(f"\n{'Improvement:':<30} {improvement:>+12.4f}")

    if abs(improvement) > 0.1:
        if improvement > 0:
            print(">>> DTW alignment SIGNIFICANTLY improves pitch correlation!")
        else:
            print(">>> DTW alignment changes pitch correlation significantly (in negative direction)")
    elif abs(improvement) > 0.02:
        print(">>> DTW alignment shows moderate improvement")
    else:
        print(">>> Similar results (audio may be well-aligned already)")

    print(f"\nDTW-aligned contour (10 points):")
    print(f"  Ref:  {contour_ref}")
    print(f"  User: {contour_user}")

    # Show pitch score impact
    linear_score = max(0, round(linear_corr * 100))
    dtw_score = max(0, round(dtw_corr * 100))
    print(f"\nPitch Score impact:")
    print(f"  Linear method: {linear_score}/100 (current)")
    print(f"  DTW method:    {dtw_score}/100 (proposed)")

    # Weighted overall impact (pitch = 25%)
    print(f"\n  Overall score impact (pitch is 25% weight):")
    print(f"    Linear → contributes {linear_score * 0.25:.1f} pts")
    print(f"    DTW    → contributes {dtw_score * 0.25:.1f} pts")
    print(f"    Delta:   {(dtw_score - linear_score) * 0.25:+.1f} pts to overall")


if __name__ == "__main__":
    main()
