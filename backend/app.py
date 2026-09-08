from __future__ import annotations

import base64
import math
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import List, Dict, Any

from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from basic_pitch.inference import predict

app = FastAPI(title="YouTube Music Notes Transcription Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
GUITAR_OPEN = [40, 45, 50, 55, 59, 64]  # low E to high E, MIDI


def midi_name(midi: int) -> str:
    octave = midi // 12 - 1
    return f"{NOTE_NAMES[midi % 12]}{octave}"


def midi_freq(midi: int) -> float:
    return 440.0 * (2 ** ((midi - 69) / 12))


def guitar_position(midi: int) -> Dict[str, int] | None:
    candidates = []
    for i, open_pitch in enumerate(GUITAR_OPEN, start=1):
        fret = midi - open_pitch
        if 0 <= fret <= 20:
            candidates.append((fret, i))
    if not candidates:
        return None
    fret, string_no = sorted(candidates, key=lambda x: (x[0], -x[1]))[0]
    return {"string": string_no, "fret": fret}


def reduce_to_melody(events: List[Dict[str, Any]], min_midi: int, max_midi: int) -> List[Dict[str, Any]]:
    filtered = [e for e in events if min_midi <= e["midi"] <= max_midi and e["confidence"] >= 0.18]
    filtered.sort(key=lambda e: (e["start"], -e["midi"], -e["confidence"]))
    if not filtered:
        return []

    groups: List[List[Dict[str, Any]]] = []
    for e in filtered:
        if not groups or e["start"] - groups[-1][0]["start"] > 0.09:
            groups.append([e])
        else:
            groups[-1].append(e)

    melody = []
    for group in groups:
        chosen = max(group, key=lambda e: e["confidence"] + 0.004 * e["midi"])
        if melody and chosen["start"] < melody[-1]["end"]:
            melody[-1]["end"] = max(melody[-1]["start"] + 0.05, chosen["start"])
        if chosen["end"] - chosen["start"] >= 0.05:
            melody.append(chosen.copy())

    compact = []
    for e in melody:
        if compact and e["midi"] == compact[-1]["midi"] and e["start"] - compact[-1]["end"] < 0.07:
            compact[-1]["end"] = max(compact[-1]["end"], e["end"])
            compact[-1]["confidence"] = max(compact[-1]["confidence"], e["confidence"])
        else:
            compact.append(e)
    return compact


def run_ffmpeg(src: Path, dst: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg was not found in PATH. Install ffmpeg and restart the server.")
    cmd = [ffmpeg, "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "22050", str(dst)]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError("ffmpeg could not decode the captured audio: " + p.stderr[-600:])


def try_guitar_stem(wav_path: Path, workdir: Path) -> Path:
    if not shutil.which("demucs"):
        return wav_path
    out_dir = workdir / "demucs"
    cmd = ["demucs", "-n", "htdemucs_6s", "--out", str(out_dir), str(wav_path)]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        return wav_path
    candidates = list(out_dir.rglob("guitar.wav"))
    return candidates[0] if candidates else wav_path


@app.get("/health")
def health():
    return {"ok": True, "ffmpeg": bool(shutil.which("ffmpeg")), "demucs": bool(shutil.which("demucs"))}


@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    instrument: str = Form("guitar"),
    mode: str = Form("arrange"),
    title: str = Form("Captured audio"),
):
    instrument = instrument.lower().strip()
    mode = mode.lower().strip()
    if instrument not in {"guitar", "flute"}:
        raise HTTPException(400, "instrument must be guitar or flute")
    if mode not in {"arrange", "transcribe"}:
        raise HTTPException(400, "mode must be arrange or transcribe")

    with tempfile.TemporaryDirectory(prefix="musicnotes-") as tmp:
        workdir = Path(tmp)
        src = workdir / "capture.webm"
        wav = workdir / "capture.wav"
        src.write_bytes(await audio.read())

        try:
            run_ffmpeg(src, wav)
            analysis_source = wav
            if mode == "transcribe" and instrument == "guitar":
                analysis_source = try_guitar_stem(wav, workdir)

            min_freq = midi_freq(40 if instrument == "guitar" else 60)
            max_freq = midi_freq(88 if instrument == "guitar" else 96)
            _, midi_data, note_events = predict(
                analysis_source,
                minimum_frequency=min_freq,
                maximum_frequency=max_freq,
                minimum_note_length=80,
            )
        except Exception as e:
            raise HTTPException(500, str(e)) from e

        events = []
        for event in note_events:
            start, end, pitch, amplitude = event[:4]
            events.append({
                "start": float(start),
                "end": float(end),
                "midi": int(pitch),
                "confidence": float(amplitude),
                "name": midi_name(int(pitch)),
            })

        if mode == "arrange" or instrument == "flute":
            if instrument == "flute":
                events = reduce_to_melody(events, 60, 96)
            else:
                events = reduce_to_melody(events, 40, 88)
        else:
            events = [e for e in events if e["confidence"] >= 0.22]
            events.sort(key=lambda e: (e["start"], -e["confidence"]))

        if instrument == "guitar":
            playable = []
            for e in events:
                pos = guitar_position(e["midi"])
                if pos:
                    e["guitar"] = pos
                    playable.append(e)
            events = playable

        midi_path = workdir / "raw.mid"
        midi_data.write(str(midi_path))
        midi_b64 = base64.b64encode(midi_path.read_bytes()).decode("ascii")

        duration = max((e["end"] for e in events), default=0.0)
        return {
            "title": title,
            "instrument": instrument,
            "mode": mode,
            "duration_seconds": duration,
            "notes": events,
            "midi_base64": midi_b64,
            "warnings": [
                "Automatic transcription is approximate, especially on dense full mixes.",
                "Guitar TAB fingering is an MVP heuristic and is not yet optimized for hand position or chords."
            ] if instrument == "guitar" else [
                "Flute mode extracts an approximate monophonic upper melody and may need manual correction."
            ]
        }
