from __future__ import annotations

from statistics import median
from typing import Any, Dict, List

from basic_pitch import ICASSP_2022_MODEL_PATH
from basic_pitch.inference import run_inference
from basic_pitch.note_creation import model_frames_to_time, output_to_notes_polyphonic

STRINGS = [
    {"string": 1, "stringName": "e", "openMidi": 64},
    {"string": 2, "stringName": "B", "openMidi": 59},
    {"string": 3, "stringName": "G", "openMidi": 55},
    {"string": 4, "stringName": "D", "openMidi": 50},
    {"string": 5, "stringName": "A", "openMidi": 45},
    {"string": 6, "stringName": "E", "openMidi": 40},
]

GUITAR_MIN_HZ = 80.0
GUITAR_MAX_HZ = 1320.0
MAX_FRET = 24
ONSET_CLUSTER_SECONDS = 0.065
SAME_NOTE_MERGE_SECONDS = 0.055

PASSES = [
    {"id": "strict", "onset": 0.40, "frame": 0.28, "minFrames": 5, "energyTolerance": 10},
    {"id": "balanced", "onset": 0.30, "frame": 0.22, "minFrames": 4, "energyTolerance": 11},
    {"id": "sensitive", "onset": 0.22, "frame": 0.17, "minFrames": 3, "energyTolerance": 12},
]


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def decode_pass(model_output: Dict[str, Any], pass_config: Dict[str, Any]) -> List[Dict[str, Any]]:
    frames = model_output["note"].copy()
    onsets = model_output["onset"].copy()
    note_frames = output_to_notes_polyphonic(
        frames=frames,
        onsets=onsets,
        onset_thresh=pass_config["onset"],
        frame_thresh=pass_config["frame"],
        min_note_len=pass_config["minFrames"],
        infer_onsets=True,
        max_freq=GUITAR_MAX_HZ,
        min_freq=GUITAR_MIN_HZ,
        melodia_trick=True,
        energy_tol=pass_config["energyTolerance"],
    )
    times = model_frames_to_time(model_output["note"].shape[0])
    decoded: List[Dict[str, Any]] = []
    for start_frame, end_frame, pitch_midi, amplitude in note_frames:
        start = float(times[start_frame])
        end = float(times[min(end_frame, len(times) - 1)])
        decoded.append({
            "pass": pass_config["id"],
            "start": start,
            "end": max(start + 0.04, end),
            "duration": max(0.04, end - start),
            "midi": int(pitch_midi),
            "amplitude": float(amplitude),
            "pitchBends": [],
        })
    return decoded


def merge_pass_detections(pass_results: List[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    buckets: List[Dict[str, Any]] = []
    for note in [note for notes in pass_results for note in notes]:
        bucket = next((candidate for candidate in buckets if candidate["midi"] == note["midi"] and abs(candidate["anchorStart"] - note["start"]) <= SAME_NOTE_MERGE_SECONDS), None)
        if bucket is None:
            bucket = {"midi": note["midi"], "anchorStart": note["start"], "detections": []}
            buckets.append(bucket)
        bucket["detections"].append(note)
        bucket["anchorStart"] = sum(n["start"] for n in bucket["detections"]) / len(bucket["detections"])

    merged: List[Dict[str, Any]] = []
    for bucket in buckets:
        detections = bucket["detections"]
        best = max(detections, key=lambda n: n["amplitude"])
        sources = list(dict.fromkeys(n["pass"] for n in detections))
        support = len(sources)
        weight_total = sum(max(0.05, n["amplitude"]) for n in detections)
        weighted_start = sum(n["start"] * max(0.05, n["amplitude"]) for n in detections) / weight_total
        weighted_end = sum(n["end"] * max(0.05, n["amplitude"]) for n in detections) / weight_total
        consensus = support / len(PASSES)
        confidence = clamp01(best["amplitude"] * 0.62 + consensus * 0.38)
        merged.append({
            "start": weighted_start,
            "end": max(weighted_start + 0.04, weighted_end),
            "duration": max(0.04, weighted_end - weighted_start),
            "midi": bucket["midi"],
            "amplitude": best["amplitude"],
            "confidence": confidence,
            "consensus": consensus,
            "detectionSources": sources,
            "pitchBends": [],
        })
    return sorted((n for n in merged if n["duration"] >= 0.04), key=lambda n: (n["start"], n["midi"]))


def is_teaching_candidate(note: Dict[str, Any]) -> bool:
    sources = set(note["detectionSources"])
    if len(sources) >= 2:
        return note["confidence"] >= 0.38 and note["duration"] >= 0.05
    if "strict" in sources:
        return note["amplitude"] >= 0.38 and note["duration"] >= 0.06
    if "balanced" in sources:
        return note["amplitude"] >= 0.46 and note["duration"] >= 0.08
    if "sensitive" in sources:
        return note["amplitude"] >= 0.66 and note["duration"] >= 0.14
    return False


def position_candidates(midi: int) -> List[Dict[str, Any]]:
    positions = []
    for string in STRINGS:
        fret = midi - string["openMidi"]
        if 0 <= fret <= MAX_FRET:
            positions.append({"string": string["string"], "stringName": string["stringName"], "fret": fret})
    return positions


def assignment_cost(assignment: List[Dict[str, Any]], previous_hand_position: float) -> float:
    fretted = [item["position"]["fret"] for item in assignment if item["position"]["fret"] > 0]
    max_fret = max(fretted) if fretted else 0
    min_fret = min(fretted) if fretted else 0
    hand = float(median(fretted)) if fretted else previous_hand_position
    spread = max_fret - min_fret if len(fretted) > 1 else 0
    cost = 0.0
    for item in assignment:
        fret = item["position"]["fret"]
        open_bonus = -0.35 if fret == 0 else 0.0
        high_fret_penalty = (fret - 12) * 0.08 if fret > 12 else 0.0
        cost += fret * 0.04 + open_bonus + high_fret_penalty
    cost += spread * 0.55
    cost += abs(hand - previous_hand_position) * 0.22
    return cost


def solve_assignment(notes: List[Dict[str, Any]], previous_hand_position: float):
    candidate_lists = [{"note": note, "positions": position_candidates(note["midi"])} for note in notes]
    if any(not item["positions"] for item in candidate_lists):
        return None
    best = {"cost": float("inf"), "assignment": None}

    def visit(index: int, used_strings: set[int], assignment: List[Dict[str, Any]]):
        if index == len(candidate_lists):
            cost = assignment_cost(assignment, previous_hand_position)
            if cost < best["cost"]:
                best["cost"] = cost
                best["assignment"] = [{"note": item["note"], "position": dict(item["position"])} for item in assignment]
            return
        item = candidate_lists[index]
        for position in item["positions"]:
            string_no = position["string"]
            if string_no in used_strings:
                continue
            used_strings.add(string_no)
            assignment.append({"note": item["note"], "position": position})
            visit(index + 1, used_strings, assignment)
            assignment.pop()
            used_strings.remove(string_no)

    visit(0, set(), [])
    return None if best["assignment"] is None else best


def assign_cluster_to_guitar(cluster: List[Dict[str, Any]], previous_hand_position: float):
    working = sorted(cluster, key=lambda n: n["confidence"], reverse=True)[:6]
    solution = solve_assignment(working, previous_hand_position)
    while solution is None and len(working) > 1:
        working = working[:-1]
        solution = solve_assignment(working, previous_hand_position)
    if solution is None:
        return [], previous_hand_position
    frets = [item["position"]["fret"] for item in solution["assignment"] if item["position"]["fret"] > 0]
    hand_position = float(median(frets)) if frets else previous_hand_position
    assigned = []
    for item in solution["assignment"]:
        note = dict(item["note"])
        note["guitar"] = item["position"]
        assigned.append(note)
    return assigned, hand_position


def group_into_onsets(notes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    clusters: List[Dict[str, Any]] = []
    for note in notes:
        last = clusters[-1] if clusters else None
        if last is None or note["start"] - last["anchor"] > ONSET_CLUSTER_SECONDS:
            clusters.append({"anchor": note["start"], "notes": [note]})
        else:
            last["notes"].append(note)
            last["anchor"] = sum(n["start"] for n in last["notes"]) / len(last["notes"])
    return clusters


def build_guitar_transcription(audio_path) -> Dict[str, Any]:
    model_output = run_inference(audio_path, ICASSP_2022_MODEL_PATH)
    pass_results = [decode_pass(model_output, pass_config) for pass_config in PASSES]
    merged = merge_pass_detections(pass_results)
    teaching_candidates = [note for note in merged if is_teaching_candidate(note)]
    clusters = group_into_onsets(teaching_candidates)

    playable: List[Dict[str, Any]] = []
    previous_hand_position = 3.0
    for chord_id, cluster in enumerate(clusters):
        assigned, previous_hand_position = assign_cluster_to_guitar(cluster["notes"], previous_hand_position)
        for note in assigned:
            note["chordId"] = chord_id
            note["bendSemitones"] = 0.0
            playable.append(note)

    playable.sort(key=lambda n: (n["start"], n["guitar"]["string"]))
    high_confidence = sum(1 for note in playable if note["confidence"] >= 0.67)
    uncertain = sum(1 for note in playable if note["confidence"] < 0.48)
    average_confidence = sum(note["confidence"] for note in playable) / len(playable) if playable else 0.0
    sensitive_only = sum(1 for note in merged if note["detectionSources"] == ["sensitive"])

    return {
        "engine": "guitar-basic-pitch-ensemble-v1.1-python",
        "notes": playable,
        "summary": {
            "rawByPass": {pass_config["id"]: len(pass_results[index]) for index, pass_config in enumerate(PASSES)},
            "mergedCandidates": len(merged),
            "teachingCandidates": len(teaching_candidates),
            "rejectedAsNoise": len(merged) - len(teaching_candidates),
            "sensitiveOnly": sensitive_only,
            "playableNotes": len(playable),
            "onsetGroups": len(clusters),
            "highConfidence": high_confidence,
            "uncertain": uncertain,
            "averageConfidence": average_confidence,
        },
    }
