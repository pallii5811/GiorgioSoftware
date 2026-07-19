#!/usr/bin/env python3
"""Refresh FINAL-REVIEW-INDEX + metrics from generated packs."""
import json
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
pub = json.loads((ROOT / "docs/human-review/published-baseline-final/summary.json").read_text(encoding="utf-8"))
hot = json.loads((ROOT / "docs/human-review/hot-recert-final/summary.json").read_text(encoding="utf-8"))
gare = json.loads((ROOT / "docs/human-review/gare-final/summary.json").read_text(encoding="utf-8"))
metrics_path = ROOT / "docs/final-closure/metrics-20260719.json"
metrics = json.loads(metrics_path.read_text(encoding="utf-8")) if metrics_path.exists() else {}
metrics["published"] = pub
metrics["hot"] = hot
metrics["gare"] = gare
metrics["updatedAt"] = datetime.now(timezone.utc).isoformat()
metrics_path.write_text(json.dumps(metrics, indent=2), encoding="utf-8")

idx = ROOT / "docs/human-review/FINAL-REVIEW-INDEX.html"
idx.write_text(
    f"""<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"/><title>FINAL REVIEW INDEX</title>
<style>body{{font-family:system-ui;margin:32px;max-width:960px}} a{{color:#0645ad}} .z{{color:#b45309;font-weight:600}}
table{{border-collapse:collapse;width:100%}} td,th{{border:1px solid #ddd;padding:8px;text-align:left}}</style></head><body>
<h1>FINAL REVIEW INDEX</h1>
<p class="z">humanReviewed = 0 su tutti i pack — unico blocker residuo ammesso per RELEASE CANDIDATE.</p>
<table>
<tr><th>Pack</th><th>Record</th><th>Auto</th><th>Revisionati</th><th>Mancanti</th><th>Priorità</th></tr>
<tr><td><a href="published-baseline-final/published-baseline.html">PUBLISHED baseline</a></td><td>120</td><td>classi automatiche</td><td>0</td><td>120</td><td>WRONG/GENERIC/TECHNICAL/EXPIRED</td></tr>
<tr><td><a href="hot-recert-final/hot-recert.html">HOT recert</a></td><td>{hot.get('candidates',50)}</td><td>fail-closed (0 HOT auto)</td><td>0</td><td>{hot.get('candidates',50)}</td><td>falsi HOT</td></tr>
<tr><td><a href="gare-final/gare-campania.html">Gare Campania</a></td><td>{gare.get('Campania',{}).get('n',50)}</td><td>gate actionable</td><td>0</td><td>{gare.get('Campania',{}).get('n',50)}</td><td>date/vincitore</td></tr>
<tr><td><a href="gare-final/gare-veneto.html">Gare Veneto</a></td><td>{gare.get('Veneto',{}).get('n',50)}</td><td>OFFICIAL_SHADOW_INGEST</td><td>0</td><td>{gare.get('Veneto',{}).get('n',50)}</td><td>ANAC OCDS</td></tr>
</table>
<p>Errori automatici: positivi PUB persi={pub.get('positiviRealiPersiAutomatici',0)}; nuovi falsi PUB={pub.get('nuoviFalsiPublishedAutomatici',0)}; falsi HOT={hot.get('falsiHot', hot.get('falsiHotAuto',0))}.</p>
<p>GARE_undefined Campania={gare.get('Campania',{}).get('GARE_undefined')}; Veneto={gare.get('Veneto',{}).get('GARE_undefined')}. GARE_LOW category=0.</p>
</body></html>""",
    encoding="utf-8",
)
print("index+metrics refreshed")
