"""Split a recording into voice, effects (game sound) and music for Cutroom.

Uses the CDX23 cinematic demixing models (ZFTurbo, trained on the Divide and
Remaster set): each one splits a mix into music / sfx / speech. All models in
--models run and their results are averaged. Plain Demucs can't do this: it
lumps game sound in with the music.

Input: a 16-bit stereo WAV at the models' sample rate (Cutroom converts first).
Prints JSON lines: {"progress": 0..1} while working, then
{"stems": {"speech": path, "sfx": path, "music": path}, "device": ".."}.
Needs torch, numpy and demucs (`pip install demucs`) plus the CDX23 .th
checkpoints (https://github.com/ZFTurbo/MVSEP-CDX23-Cinematic-Sound-Demixing).
"""

import argparse
import glob
import json
import os
import sys
import types
import wave


def emit(obj) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def read_wav(path):
    import numpy as np

    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise SystemExit("expected 16-bit PCM input")
        rate, channels = w.getframerate(), w.getnchannels()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return rate, data.reshape(-1, channels).T.astype(np.float32) / 32768.0


def write_wav(path, rate, audio):
    import numpy as np

    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).round().astype(np.int16).T.copy()
    tmp = path + ".part"
    with wave.open(tmp, "wb") as w:
        w.setnchannels(pcm.shape[1])
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    os.replace(tmp, path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("outdir")
    ap.add_argument("--models", default=os.path.join(os.path.expanduser("~"), ".cache", "cdx23", "models"))
    ap.add_argument("--shifts", type=int, default=2)
    ap.add_argument("--overlap", type=float, default=0.8)
    args = ap.parse_args()

    paths = sorted(glob.glob(os.path.join(args.models, "*.th")))
    if not paths:
        raise SystemExit(f"No CDX23 models (*.th) in {args.models}. Download them or set CUTROOM_STEM_MODELS.")

    import torch
    import demucs.apply
    from demucs.apply import apply_model
    from demucs.states import load_model

    device = "cuda" if torch.cuda.is_available() else "cpu"
    rate, audio = read_wav(args.input)
    mix = torch.from_numpy(audio)[None]

    # demucs shows chunk progress with tqdm; turn it into JSON progress lines.
    passes = len(paths) * max(1, args.shifts)
    done = {"passes": 0}

    def tracked(items, **_):
        items = list(items)
        for i, item in enumerate(items):
            yield item
            emit({"progress": min(0.999, (done["passes"] + (i + 1) / len(items)) / passes)})
        done["passes"] += 1

    demucs.apply.tqdm = types.SimpleNamespace(tqdm=tracked)

    total = None
    sources = None
    for path in paths:
        model = load_model(path)
        if model.samplerate != rate:
            raise SystemExit(f"input is {rate} Hz, the model needs {model.samplerate} Hz")
        model.to(device).eval()
        with torch.no_grad():
            est = apply_model(model, mix, shifts=args.shifts, overlap=args.overlap, split=True, device=device, progress=True)[0].cpu()
        total = est if total is None else total + est
        sources = sources or list(model.sources)
        del model
        if device == "cuda":
            torch.cuda.empty_cache()

    total = (total / len(paths)).numpy()
    os.makedirs(args.outdir, exist_ok=True)
    stems = {}
    for i, name in enumerate(sources):
        stems[name] = os.path.join(args.outdir, f"{name}.wav")
        write_wav(stems[name], rate, total[i])
    emit({"stems": stems, "device": device})
    return 0


if __name__ == "__main__":
    sys.exit(main())
