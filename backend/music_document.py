from __future__ import annotations

from typing import Any, Dict, List

SCHEMA_VERSION = "0.1.0"


def build_music_document(*, title: str, instrument: str, mode: str, duration_seconds: float,
                         notes: List[Dict[str, Any]], warnings: List[str],
                         midi_base64: str | None = None) -> Dict[str, Any]:
    """Create the canonical internal representation used by renderers and LLM reasoning.

    The schema is intentionally permissive in v0.1 so we can add beat/key/chord/section
    detection without breaking current clients.
    """
    return {
        "schema": "youtube-music-notes.music-document",
        "schema_version": SCHEMA_VERSION,
        "track": {
            "title": title,
            "source": "browser-tab-capture",
            "duration_seconds": duration_seconds,
        },
        "analysis": {
            "requested_instrument": instrument,
            "mode": mode,
            "confidence_summary": None,
            "warnings": warnings,
        },
        "tempo": {
            "bpm": None,
            "confidence": None,
        },
        "meter": {
            "time_signature": None,
            "confidence": None,
        },
        "key": {
            "tonic": None,
            "mode": None,
            "confidence": None,
        },
        "sections": [],
        "measures": [],
        "chords": [],
        "instruments": [
            {
                "name": instrument,
                "role": "target",
                "source": "transcribed" if mode == "transcribe" else "arranged",
            }
        ],
        "notes": notes,
        "exports": {
            "midi_base64": midi_base64,
        },
        "learning": {
            "difficulty": None,
            "skills": [],
            "practice_points": [],
        },
    }


def compact_for_llm(document: Dict[str, Any], max_notes: int = 300) -> Dict[str, Any]:
    """Reduce payload size while preserving the musical facts an LLM needs."""
    compact = dict(document)
    compact["exports"] = {"midi_base64": None}
    notes = list(document.get("notes", []))
    if len(notes) > max_notes:
        step = max(1, len(notes) // max_notes)
        notes = notes[::step][:max_notes]
        compact["analysis"] = dict(document.get("analysis", {}))
        compact["analysis"]["llm_note_sampling"] = {
            "original_count": len(document.get("notes", [])),
            "sent_count": len(notes),
        }
    compact["notes"] = notes
    return compact
