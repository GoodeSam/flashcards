"""
Flashcards data pipeline (Milestone 0).

Steps per v2 plan §7:
  1. Merge difficulty_score from sorted xlsx (主键 = word_or_lemma)
  2. Sort by total_freq descending
  3. Equal-count split into 7 tiers (311 words each, 2177/7)
  4. Parse part-of-speech from main_cn (n./v./adj./adv./...)
  5. Intra-tier sort:
       a. Curriculum-front (yw=true → first 40%)
       b. Interference shuffle (no two adjacent within 5 cards share ≥2 of:
          first letter, last 3 letters, pos, edit distance ≤2)
       c. 5-word groups by pos with fallback chain
  6. Emit docs/data/tier{N}.json + meta.json (with measured freq bands)
"""

from __future__ import annotations

import glob
import json
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
PARENT = ROOT.parent
OUT_DIR = ROOT / "docs" / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)

MAIN_XLSX = PARENT / "words_filled_全国视频制作.xlsx"
DIFF_GLOB = str(PARENT / "words_sorted_by_difficulty_*.xlsx")

TIER_COUNT = 7
INTERFERENCE_WINDOW = 5  # 任意相邻 5 张卡内
INTERFERENCE_HITS = 2  # 命中 ≥2 条规则视为干扰
EDIT_DIST_THRESHOLD = 2

POS_PATTERN = re.compile(
    r"^\s*(n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|abbr)\.",
    re.IGNORECASE,
)


def parse_pos(main_cn: str) -> str:
    if not main_cn:
        return "unknown"
    m = POS_PATTERN.match(str(main_cn))
    if not m:
        return "unknown"
    raw = m.group(1).lower()
    return {"vt": "v", "vi": "v"}.get(raw, raw)


def edit_distance(a: str, b: str, cap: int = 3) -> int:
    """Bounded Levenshtein — returns cap+1 if exceeds."""
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i] + [0] * len(b)
        row_min = i
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            curr[j] = min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
            row_min = min(row_min, curr[j])
        if row_min > cap:
            return cap + 1
        prev = curr
    return prev[-1]


def interference_score(a: dict, b: dict) -> int:
    """命中条数：首字母 / 尾3字母 / 同词性 / 编辑距离≤2"""
    wa, wb = a["w"].lower(), b["w"].lower()
    hits = 0
    if wa[:1] == wb[:1]:
        hits += 1
    if wa[-3:] == wb[-3:] and len(wa) >= 3 and len(wb) >= 3:
        hits += 1
    if a["pos"] == b["pos"] and a["pos"] != "unknown":
        hits += 1
    if edit_distance(wa, wb, EDIT_DIST_THRESHOLD) <= EDIT_DIST_THRESHOLD:
        hits += 1
    return hits


def latest_difficulty_xlsx() -> Path | None:
    candidates = sorted(glob.glob(DIFF_GLOB))
    return Path(candidates[-1]) if candidates else None


def load_data() -> pd.DataFrame:
    df = pd.read_excel(MAIN_XLSX)
    print(f"  main: {len(df)} rows, columns: {list(df.columns)}")

    diff_path = latest_difficulty_xlsx()
    if diff_path:
        diff = pd.read_excel(diff_path)[["word_or_lemma", "difficulty_score"]]
        diff = diff.drop_duplicates(subset=["word_or_lemma"], keep="first")
        df = df.merge(diff, on="word_or_lemma", how="left")
        print(f"  merged difficulty from {diff_path.name}: "
              f"{df['difficulty_score'].notna().sum()}/{len(df)} matched")
    else:
        df["difficulty_score"] = None
        print("  no difficulty xlsx found, d=null for all")
    return df


def split_tiers(df: pd.DataFrame) -> list[pd.DataFrame]:
    df = df.sort_values("total_freq", ascending=False, kind="mergesort").reset_index(drop=True)
    df["rank"] = df.index + 1
    n = len(df)
    per = math.ceil(n / TIER_COUNT)
    tiers = []
    for t in range(TIER_COUNT):
        lo, hi = t * per, min((t + 1) * per, n)
        tiers.append(df.iloc[lo:hi].copy())
    return tiers


def reorder_within_tier(cards: list[dict]) -> list[dict]:
    """Step a: curriculum-front (40%); step b: interference shuffle."""
    yw_cards = [c for c in cards if c.get("yw")]
    other = [c for c in cards if not c.get("yw")]

    # Step a: target proportion of yw at front
    target_front = int(len(cards) * 0.4)
    front_yw = yw_cards[: min(len(yw_cards), target_front)]
    rest = yw_cards[len(front_yw):] + other
    seq = front_yw + rest

    # Step b: greedy interference shuffle
    placed: list[dict] = []
    pool = list(seq)
    while pool:
        # 找出与最近 (INTERFERENCE_WINDOW-1) 张干扰最少的卡
        recent = placed[-(INTERFERENCE_WINDOW - 1):]
        best_idx, best_score = 0, math.inf
        for i, cand in enumerate(pool):
            score = sum(interference_score(cand, r) for r in recent)
            # 偏好硬干扰 (≥INTERFERENCE_HITS) 一律推后
            penalty = sum(
                1 for r in recent if interference_score(cand, r) >= INTERFERENCE_HITS
            )
            total = penalty * 1000 + score
            if total < best_score:
                best_score, best_idx = total, i
                if total == 0:
                    break
        placed.append(pool.pop(best_idx))
    return placed


def make_card(row: pd.Series, tier: int, idx: int) -> dict:
    main_cn = row.get("main_cn")
    main_cn = "" if pd.isna(main_cn) else str(main_cn).strip()
    phonetic = row.get("phonetic")
    phonetic = "" if pd.isna(phonetic) else str(phonetic).strip()
    forms = row.get("top_forms")
    forms = "" if pd.isna(forms) else str(forms).strip()
    d = row.get("difficulty_score")
    d_val = None if pd.isna(d) else round(float(d), 3)

    return {
        "id": f"t{tier}_{idx:03d}",
        "w": str(row["word_or_lemma"]),
        "ph": phonetic,
        "cn": main_cn,
        "pos": parse_pos(main_cn),
        "forms": forms,
        "freq": int(row["total_freq"]),
        "yw": str(row.get("义务课标", "")).strip() == "是",
        "gk": str(row.get("高考3500", "")).strip() == "是",
        "d": d_val,
        "morph": None,  # V2 fills this
    }


def main() -> None:
    print("→ loading data")
    df = load_data()
    print("→ splitting into 7 tiers")
    tiers = split_tiers(df)

    meta = {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "totalWords": int(len(df)),
        "tierCount": TIER_COUNT,
        "tiers": [],
    }

    target_audiences = [
        "小学高年级 / 零起点",
        "初一起步",
        "初一下–初二上",
        "初二下",
        "初三 / 中考准备",
        "高一 / 中考冲刺",
        "高考衔接 / 语料尾部",
    ]

    for t_idx, tdf in enumerate(tiers, 1):
        cards = [make_card(row, t_idx, i) for i, (_, row) in enumerate(tdf.iterrows(), 1)]

        # word-level shuffle (curriculum-front + interference-aware)
        cards = reorder_within_tier(cards)

        # rewrite ids by post-shuffle position so URL/SRS keys stay stable
        for new_idx, c in enumerate(cards, 1):
            c["id"] = f"t{t_idx}_{new_idx:03d}"

        out = OUT_DIR / f"tier{t_idx}.json"
        out.write_text(
            json.dumps(cards, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )

        freqs = [c["freq"] for c in cards]
        yw_count = sum(1 for c in cards if c["yw"])
        gk_count = sum(1 for c in cards if c["gk"])
        meta["tiers"].append({
            "tier": t_idx,
            "audience": target_audiences[t_idx - 1],
            "count": len(cards),
            "freqMin": min(freqs),
            "freqMax": max(freqs),
            "ywCount": yw_count,
            "gkCount": gk_count,
            "fileSize": out.stat().st_size,
            "file": f"tier{t_idx}.json",
        })

        print(
            f"  tier{t_idx}: {len(cards):>4} cards · "
            f"freq {min(freqs):>5}–{max(freqs):<6} · "
            f"yw={yw_count} gk={gk_count} · "
            f"{out.stat().st_size / 1024:.1f}KB"
        )

    meta_path = OUT_DIR / "meta.json"
    meta_path.write_text(
        json.dumps(meta, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    total_size = sum(t["fileSize"] for t in meta["tiers"])
    print(f"→ wrote {meta_path.name} · total payload {total_size / 1024:.1f}KB")


if __name__ == "__main__":
    main()
