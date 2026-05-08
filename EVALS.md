# GeoChatBot Evaluation Leaderboard

> No runs yet — see `packages/eval/README.md` to run.

| Model | Pass rate | Plan-shape pass | Answer pass | Mean latency | Notes |
|---|---|---|---|---|---|
| *(no data)* | — | — | — | — | Run the harness to populate this table. |

## How to generate this table

```bash
cd packages/eval
python -m geochatbot_eval run \
  --site http://localhost:5173/app \
  --tasks tasks/nyc_311_v1.json \
  --models claude-sonnet-4-6,claude-haiku-4-5-20251001 \
  --api-key $ANTHROPIC_API_KEY \
  --out runs/run-$(date +%Y%m%d-%H%M%S).json

python -m geochatbot_eval leaderboard \
  --runs runs/*.json \
  --out ../../EVALS.md
```

---
*Last updated: 2026-05-08*
