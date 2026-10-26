"""Speech to text for Cutroom auto captions (faster-whisper, local).

Prints JSON lines: {"progress": 0..1} while working, then
{"language": "..", "segments": [{start, end, text, words: [{start, end, word}]}]}.

GPU: uses CUDA when its runtime DLLs are available (for example after
`pip install nvidia-cublas-cu12 nvidia-cudnn-cu12`); otherwise, or if CUDA
fails mid-run, it falls back to the CPU.
"""

import argparse
import json
import os
import site
import sys


def add_cuda_dll_dirs() -> None:
    """Make pip-installed NVIDIA runtime DLLs (nvidia/*/bin) loadable."""
    bases = [site.getusersitepackages(), *site.getsitepackages()]
    for base in bases:
        nv = os.path.join(base, "nvidia")
        if not os.path.isdir(nv):
            continue
        for sub in os.listdir(nv):
            path = os.path.join(nv, sub, "bin")
            if os.path.isdir(path):
                if hasattr(os, "add_dll_directory"):
                    os.add_dll_directory(path)
                os.environ["PATH"] = path + os.pathsep + os.environ.get("PATH", "")


def emit(obj) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


# Whisper tends to drop hesitations; a disfluent prompt makes it keep them.
FILLER_PROMPT = "Umm, let me think like, hmm... Okay, uh, here's what I'm, like, thinking."


def run(model, path, language, fillers=False):
    segments, info = model.transcribe(path, language=language, vad_filter=True, word_timestamps=True, initial_prompt=FILLER_PROMPT if fillers else None)
    total = info.duration or 1.0
    out = []
    for s in segments:
        out.append(
            {
                "start": s.start,
                "end": s.end,
                "text": s.text.strip(),
                "words": [{"start": w.start, "end": w.end, "word": w.word} for w in (s.words or [])],
            }
        )
        emit({"progress": min(1.0, s.end / total)})
    return info.language, out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--model", default="large-v3")
    ap.add_argument("--language", default="auto")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--fillers", action="store_true", help="keep um/uh (for text-based editing)")
    args = ap.parse_args()
    language = None if args.language in ("", "auto") else args.language

    add_cuda_dll_dirs()
    from faster_whisper import WhisperModel

    if args.device in ("auto", "cuda"):
        try:
            lang, segs = run(WhisperModel(args.model, device="cuda", compute_type="float16"), args.path, language, args.fillers)
            emit({"language": lang, "segments": segs, "device": "cuda"})
            return 0
        except Exception as exc:  # no GPU, or CUDA runtime DLLs missing
            emit({"note": f"GPU unavailable ({str(exc).splitlines()[0]}); using CPU"})
    lang, segs = run(WhisperModel(args.model, device="cpu", compute_type="int8"), args.path, language, args.fillers)
    emit({"language": lang, "segments": segs, "device": "cpu"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
