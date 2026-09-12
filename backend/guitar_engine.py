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

# These are integration tolerances, not model decision thresholds. The model
# thresholds remain frozen in guitar_ear_calibration.json from validation data.
GUITAR_EAR_ATTACK_MATCH_SECONDS = 0.18
GUITAR_EAR_ACTIVE_PAD_SECONDS = 0.08
GUITAR_EAR_STRONG_FALLBACK_CONFIDENCE = 0.88

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


def _in_active_interval(anchor: float, intervals: List[Dict[str, Any]]) -> bool:
    return any(
        float(interval.get("start", 0.0)) - GUITAR_EAR_ACTIVE_PAD_SECONDS
        <= anchor
        <= float(interval.get("end", 0.0)) + GUITAR_EAR_ACTIVE_PAD_SECONDS
        for interval in intervals
    )


def _nearest_attack_distance(anchor: float, attacks: List[float]) -> float | None:
    if not attacks:
        return None
    return min(abs(anchor - float(value)) for value in attacks)


def _strong_cluster_fallback(cluster: Dict[str, Any]) -> bool:
    notes = cluster.get("notes") or []
    return any(
        float(note.get("confidence", 0.0)) >= GUITAR_EAR_STRONG_FALLBACK_CONFIDENCE
        and float(note.get("consensus", 0.0)) >= 0.999
        for note in notes
    )


def apply_guitar_ear_gate(
    clusters: List[Dict[str, Any]],
    guitar_ear: Dict[str, Any] | None,
) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
    pre_count = len(clusters)
    if not guitar_ear or not guitar_ear.get("available"):
        return clusters, {
            "enabled": False,
            "preGateOnsetGroups": pre_count,
            "postGateOnsetGroups": pre_count,
            "gateRejectedGroups": 0,
            "rejectedOutsideActiveRegions": 0,
            "rejectedWithoutAttackSupport": 0,
            "attackMatchedGroups": 0,
            "strongFallbackGroups": 0,
        }

    intervals = list(guitar_ear.get("active_intervals") or [])
    attacks = [float(value) for value in (guitar_ear.get("attack_times") or [])]
    kept: List[Dict[str, Any]] = []
    attack_matched = 0
    fallback = 0
    rejected_inactive = 0
    rejected_no_attack = 0

    for cluster in clusters:
        anchor = float(cluster["anchor"])
        if not _in_active_interval(anchor, intervals):
            rejected_inactive += 1
            continue

        distance = _nearest_attack_distance(anchor, attacks)
        if distance is not None and distance <= GUITAR_EAR_ATTACK_MATCH_SECONDS:
            cluster = dict(cluster)
            cluster["guitarEarSupport"] = "attack"
            cluster["guitarEarAttackDistance"] = round(distance, 4)
            kept.append(cluster)
            attack_matched += 1
            continue

        if _strong_cluster_fallback(cluster):
            cluster = dict(cluster)
            cluster["guitarEarSupport"] = "strong-basic-pitch-fallback"
            kept.append(cluster)
            fallback += 1
            continue

        rejected_no_attack += 1

    return kept, {
        "enabled": True,
        "preGateOnsetGroups": pre_count,
        "postGateOnsetGroups": len(kept),
        "gateRejectedGroups": pre_count - len(kept),
        "rejectedOutsideActiveRegions": rejected_inactive,
        "rejectedWithoutAttackSupport": rejected_no_attack,
        "attackMatchedGroups": attack_matched,
        "strongFallbackGroups": fallback,
        "attackMatchWindowSeconds": GUITAR_EAR_ATTACK_MATCH_SECONDS,
        "activeRegionPaddingSeconds": GUITAR_EAR_ACTIVE_PAD_SECONDS,
    }


def _compact_guitar_ear(guitar_ear: Dict[str, Any] | None) -> Dict[str, Any]:
    if not guitar_ear:
        return {"available": False}
    return {
        "available": bool(guitar_ear.get("available")),
        "device": guitar_ear.get("device"),
        "model": guitar_ear.get("model"),
        "presenceSegmentThreshold": guitar_ear.get("presence_segment_threshold"),
        "attackThreshold": guitar_ear.get("attack_threshold"),
        "meanPresence": guitar_ear.get("mean_presence"),
        "activeFraction": guitar_ear.get("active_fraction"),
        "attackCount": guitar_ear.get("attack_count", 0),
        "activeIntervals": guitar_ear.get("active_intervals", []),
        "error": guitar_ear.get("error"),
    }


def build_guitar_transcription(audio_path, guitar_ear: Dict[str, Any] | None = None) -> Dict[str, Any]:
    model_output = run_inference(audio_path, ICASSP_2022_MODEL_PATH)
    pass_results = [decode_pass(model_output, pass_config) for pass_config in PASSES]
    merged = merge_pass_detections(pass_results)
    teaching_candidates = [note for note in merged if is_teaching_candidate(note)]
    pre_gate_clusters = group_into_onsets(teaching_candidates)
    clusters, gate_stats = apply_guitar_ear_gate(pre_gate_clusters, guitar_ear)

    playable: List[Dict[str, Any]] = []
    previous_hand_position = 3.0
    for chord_id, cluster in enumerate(clusters):
        assigned, previous_hand_position = assign_cluster_to_guitar(cluster["notes"], previous_hand_position)
        for note in assigned:
            note["chordId"] = chord_id
            note["bendSemitones"] = 0.0
            note["guitarEarSupport"] = cluster.get("guitarEarSupport", "not-enabled")
            if "guitarEarAttackDistance" in cluster:
                note["guitarEarAttackDistance"] = cluster["guitarEarAttackDistance"]
            playable.append(note)

    playable.sort(key=lambda n: (n["start"], n["guitar"]["string"]))
    high_confidence = sum(1 for note in playable if note["confidence"] >= 0.67)
    uncertain = sum(1 for note in playable if note["confidence"] < 0.48)
    average_confidence = sum(note["confidence"] for note in playable) / len(playable) if playable else 0.0
    sensitive_only = sum(1 for note in merged if note["detectionSources"] == ["sensitive"])
    gate_enabled = bool(gate_stats["enabled"])

    return {
        "engine": "guitar-ear-v0.2d+basic-pitch-ensemble-v2-python" if gate_enabled else "guitar-basic-pitch-ensemble-v1.1-python",
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
            "guitarEar": _compact_guitar_ear(guitar_ear),
            "guitarEarGate": gate_stats,
        },
    }
