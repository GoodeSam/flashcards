# Flashcards · 7-Tier Vocabulary Trainer

Static GitHub Pages site for vocabulary memorization, based on Nation's principles
(spaced retrieval, productive recall, interference avoidance).

Built per `wordCard.md` v2 plan.

## Layout

```
Flashcards/
├── build_data.py          # Data pipeline (run once after data updates)
├── docs/                  # ← GitHub Pages root (publish from main/docs)
│   ├── index.html         # Tier selector
│   ├── tier.html          # Per-tier learning page (?t=1..7)
│   ├── assets/
│   │   ├── css/cards.css
│   │   └── js/{srs,storage,grader,tts,card,app}.js
│   └── data/
│       ├── meta.json      # Tier ranges + freq bands (filled by pipeline)
│       └── tier1.json ~ tier7.json
└── README.md
```

## Pipeline

```bash
cd Flashcards
python3 build_data.py
```

Reads from sibling files:
- `../words_filled_全国视频制作.xlsx` (main table, 2177 words)
- `../words_sorted_by_difficulty_*.xlsx` (latest difficulty snapshot)

Outputs to `docs/data/`.

## Local preview

```bash
cd Flashcards/docs
python3 -m http.server 8000
# open http://localhost:8000
```

## GitHub Pages

Settings → Pages → Source = `main` branch, `/docs` folder.
All asset paths are relative — works under any base path.

## Decisions locked (v2)

| # | Decision |
|---|---|
| Tier split | Equal-count: 311 words × 7 tiers |
| Curriculum nudge | Sort within tier only, never cross tiers |
| Front-page quiz | None — direct entry to tier cards |
| Storage | localStorage v1 schema with checksum + JSON export |
| SRS | 5-box Leitner (intervals 1/2/4/8/16d) with 4-eval (Again/Hard/Good/Easy) |
| L1→L2 productive mode | Unlocks at ≥80% cards in box≥3 |
| TTS | Web Speech API (graceful degrade) |
