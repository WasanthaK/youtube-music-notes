from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Dict, Any
from urllib import request as urllib_request

import pretty_midi
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from basic_pitch.inference import predict

from guitar_ear_gate import analyze_guitar_audio, guitar_ear_status
from guitar_engine import build_guitar_transcription
from music_document import build_music_document
from reasoning import reason_about_music

load_dotenv(Path(__file__).with_name('.env'))

app = FastAPI(title="YouTube Music Notes API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
GUITAR_OPEN = [40, 45, 50, 55, 59, 64]
DIAGNOSTICS_PATH = Path(__file__).with_name("transcription_diagnostics.jsonl")


class ReasonRequest(BaseModel):
    music_document: Dict[str, Any]
    question: str
    provider: str | None = None


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


def make_midi(notes: List[Dict[str, Any]]) -> pretty_midi.PrettyMIDI:
    midi = pretty_midi.PrettyMIDI()
    instrument = pretty_midi.Instrument(program=25)
    for note in notes:
        velocity = max(1, min(127, int(round(float(note.get("confidence", 0.5)) * 127))))
        instrument.notes.append(pretty_midi.Note(
            velocity=velocity,
            pitch=int(note["midi"]),
            start=float(note["start"]),
            end=max(float(note["start"]) + 0.04, float(note["end"])),
        ))
    midi.instruments.append(instrument)
    return midi


def record_diagnostic(row: Dict[str, Any]) -> Dict[str, Any]:
    local_row = {**row, "created_at": datetime.now(timezone.utc).isoformat()}
    with DIAGNOSTICS_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(local_row, ensure_ascii=False) + "\n")

    supabase_url = os.getenv("SUPABASE_URL", "").rstrip("/")
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if supabase_url and service_key:
        payload = json.dumps(row).encode("utf-8")
        req = urllib_request.Request(
            f"{supabase_url}/rest/v1/transcription_diagnostics",
            data=payload,
            method="POST",
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
        )
        try:
            with urllib_request.urlopen(req, timeout=8) as response:
                local_row["supabase_status"] = response.status
        except Exception as exc:
            local_row["supabase_error"] = str(exc)
    else:
        local_row["supabase_status"] = "not-configured"

    return local_row


def compact_guitar_ear_diagnostic(summary: Dict[str, Any] | None) -> Dict[str, Any] | None:
    if not summary:
        return None
    guitar_ear = summary.get("guitarEar") or {}
    gate = summary.get("guitarEarGate") or {}
    return {
        "available": guitar_ear.get("available"),
        "device": guitar_ear.get("device"),
        "model": guitar_ear.get("model"),
        "mean_presence": guitar_ear.get("meanPresence"),
        "active_fraction": guitar_ear.get("activeFraction"),
        "attack_count": guitar_ear.get("attackCount"),
        "active_intervals": guitar_ear.get("activeIntervals", []),
        "gate": gate,
    }


def diagnostic_row(
    *,
    youtube_video_id: str | None,
    youtube_url: str | None,
    title: str,
    source: str,
    instrument: str,
    duration: float,
    engine: str,
    summary: Dict[str, Any] | None,
    start_seconds: float | None,
    end_seconds: float | None,
    requested_duration_seconds: float | None,
) -> Dict[str, Any]:
    summary = summary or {}
    raw = summary.get("rawByPass") or {}
    playable = int(summary.get("playableNotes", 0) or 0)
    return {
        "user_id": None,
        "youtube_video_id": youtube_video_id,
        "youtube_url": youtube_url,
        "reference_label": f"{youtube_video_id or 'local'}:{start_seconds if start_seconds is not None else 0:.1f}-{end_seconds if end_seconds is not None else duration:.1f}",
        "engine": engine,
        "instrument": instrument,
        "track_title": title,
        "source": source,
        "duration_seconds": round(float(duration), 3),
        "raw_strict": raw.get("strict"),
        "raw_balanced": raw.get("balanced"),
        "raw_sensitive": raw.get("sensitive"),
        "merged_candidates": summary.get("mergedCandidates"),
        "teaching_candidates": summary.get("teachingCandidates"),
        "rejected_as_noise": summary.get("rejectedAsNoise"),
        "sensitive_only": summary.get("sensitiveOnly"),
        "playable_notes": playable,
        "onset_groups": summary.get("onsetGroups"),
        "high_confidence": summary.get("highConfidence"),
        "uncertain": summary.get("uncertain"),
        "average_confidence": summary.get("averageConfidence"),
        "playable_notes_per_second": round(playable / duration, 4) if duration > 0 else 0,
        "source_histogram": {},
        "confidence_buckets": {},
        "browser_user_agent": None,
        "extra": {
            "sampling_mode": "fixed-30s-v1" if youtube_video_id and start_seconds == 30 and end_seconds == 60 else "manual-or-other",
            "start_seconds": start_seconds,
            "end_seconds": end_seconds,
            "requested_duration_seconds": requested_duration_seconds,
            "guitar_ear": compact_guitar_ear_diagnostic(summary),
        },
    }


@app.get("/health")
def health():
    gate_status = guitar_ear_status()
    return {
        "ok": True,
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "demucs": bool(shutil.which("demucs")),
        "reasoning": ["openai", "gemini"],
        "diagnostics_file": str(DIAGNOSTICS_PATH),
        "supabase_diagnostics": bool(os.getenv("SUPABASE_URL") and os.getenv("SUPABASE_SERVICE_ROLE_KEY")),
        "guitar_engine": "guitar-ear-v0.2d+basic-pitch-ensemble-v2-python" if gate_status.get("available") else "guitar-basic-pitch-ensemble-v1.1-python",
        "guitar_ear": gate_status,
    }


@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    instrument: str = Form("guitar"),
    mode: str = Form("arrange"),
    title: str = Form("Captured audio"),
    youtube_video_id: str | None = Form(None),
    youtube_url: str | None = Form(None),
    start_seconds: float | None = Form(None),
    end_seconds: float | None = Form(None),
    requested_duration_seconds: float | None = Form(None),
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
        guitar_ear_result: Dict[str, Any] | None = None

        try:
            run_ffmpeg(src, wav)

            if instrument == "guitar":
                # Guitar Ear always evaluates the original mix. Basic Pitch may
                # optionally run on the Demucs guitar stem, but timestamps remain
                # aligned so Guitar Ear can gate its onset groups.
                guitar_ear_result = analyze_guitar_audio(wav)
                analysis_source = wav
                if mode == "transcribe":
                    analysis_source = try_guitar_stem(wav, workdir)
                guitar_result = build_guitar_transcription(analysis_source, guitar_ear=guitar_ear_result)
                events = []
                for note in guitar_result["notes"]:
                    events.append({
                        **note,
                        "name": midi_name(int(note["midi"])),
                    })
                engine = guitar_result["engine"]
                summary = guitar_result["summary"]
                midi_data = make_midi(events)
            else:
                min_freq = midi_freq(60)
                max_freq = midi_freq(96)
                _, midi_data, note_events = predict(
                    wav,
                    minimum_frequency=min_freq,
                    maximum_frequency=max_freq,
                    minimum_note_length=80,
                )
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
                events = reduce_to_melody(events, 60, 96)
                engine = "basic-pitch-flute-melody-v1"
                summary = {"playableNotes": len(events)}
        except Exception as e:
            raise HTTPException(500, str(e)) from e

        midi_path = workdir / "raw.mid"
        midi_data.write(str(midi_path))
        midi_b64 = base64.b64encode(midi_path.read_bytes()).decode("ascii")
        detected_duration = max((e["end"] for e in events), default=0.0)
        duration = float(requested_duration_seconds or detected_duration)

        if instrument == "guitar":
            if guitar_ear_result and guitar_ear_result.get("available"):
                warnings = [
                    "Automatic transcription is approximate, especially on dense full mixes.",
                    "Guitar Ear v0.2d gates Basic Pitch onset groups using frozen validation thresholds; strong three-pass Basic Pitch consensus is retained as a safety fallback.",
                ]
            else:
                warnings = [
                    "Automatic transcription is approximate, especially on dense full mixes.",
                    "Guitar Ear v0.2d is unavailable, so this result used the legacy Basic Pitch teaching-note gate.",
                ]
        else:
            warnings = ["Flute mode extracts an approximate monophonic melody and may need manual correction."]

        document = build_music_document(
            title=title,
            instrument=instrument,
            mode=mode,
            duration_seconds=duration,
            notes=events,
            warnings=warnings,
            midi_base64=midi_b64,
        )

        diagnostic = diagnostic_row(
            youtube_video_id=youtube_video_id,
            youtube_url=youtube_url,
            title=title,
            source="chrome-extension",
            instrument=instrument,
            duration=duration,
            engine=engine,
            summary=summary,
            start_seconds=start_seconds,
            end_seconds=end_seconds,
            requested_duration_seconds=requested_duration_seconds,
        )
        diagnostic_status = record_diagnostic(diagnostic)

        return {
            "title": title,
            "instrument": instrument,
            "mode": mode,
            "duration_seconds": duration,
            "notes": events,
            "midi_base64": midi_b64,
            "warnings": warnings,
            "music_document": document,
            "engine": engine,
            "summary": summary,
            "benchmark": {
                "videoId": youtube_video_id,
                "videoUrl": youtube_url,
                "startSeconds": start_seconds,
                "endSeconds": end_seconds,
                "requestedDurationSeconds": requested_duration_seconds,
            } if youtube_video_id else None,
            "diagnostic": {
                "local_file": str(DIAGNOSTICS_PATH),
                "supabase_status": diagnostic_status.get("supabase_status"),
                "supabase_error": diagnostic_status.get("supabase_error"),
            },
        }


@app.post("/reason")
def reason(request: ReasonRequest):
    question = request.question.strip()
    if not question:
        raise HTTPException(400, "question is required")
    if request.music_document.get("schema") != "youtube-music-notes.music-document":
        raise HTTPException(400, "invalid MusicDocument schema")
    try:
        return reason_about_music(request.music_document, question, request.provider)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        raise HTTPException(500, str(e)) from e
