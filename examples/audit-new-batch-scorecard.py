#!/usr/bin/env python3
"""Score the fresh generality batch.

Reads pinned projects from docs/audits/2026-10-05-new-batch/projects.json and
per-project scan JSON from a scans directory. Unknown/AI-reviewable contracts
are counted as incomplete in the deterministic score; they are reported
separately so the interactive AI gap review closure is measured honestly
instead of being treated as scanner correctness.

Usage:
  python3 examples/audit-new-batch-scorecard.py --scans /tmp/newbatch-scans \
      --manifest docs/audits/2026-10-05-new-batch/projects.json \
      --out docs/audits/2026-10-05-new-batch/results/scorecard.json
"""

import argparse
import collections
import json
import os

# Gap codes that mean "the deterministic pass cannot prove this from source".
# These are routed to the interactive AI review, not treated as false routes.
AI_REVIEWABLE = {
    "response-schema-unknown",
    "response-unknown",
    "sse-events-unknown",
}
REQUEST_GAPS = {
    "body-unknown",
    "body-schema-unknown",
    "query-unknown",
    "header-unknown",
}


def load_scan(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def score_project(spec, scan):
    report = scan["report"]
    operations = scan["project"]["operations"]
    detected = len(operations)
    expected = spec.get("expectedRoutes", detected)

    gap_by_route = {g["operationId"] if "operationId" in g else None: g for g in report.get("gaps", [])}
    gap_counter = collections.Counter()
    routes_with_response_gap = 0
    routes_with_request_gap = 0
    ai_review_routes = 0
    for item in report.get("gaps", []):
        codes = item.get("gaps", [])
        gap_counter.update(codes)
        if any(c in AI_REVIEWABLE for c in codes):
            routes_with_response_gap += 1
        if any(c in REQUEST_GAPS for c in codes):
            routes_with_request_gap += 1
        if codes and all(c in AI_REVIEWABLE for c in codes):
            ai_review_routes += 1

    route_recall = min(1.0, detected / expected) if expected else 1.0
    # False routes are supplied from source verification in the manifest.
    false_routes = spec.get("falseRoutes", 0)
    route_precision = 1.0 if detected == 0 else max(0.0, (detected - false_routes) / detected)

    request_completeness = 1.0 if detected == 0 else 1.0 - routes_with_request_gap / detected
    response_deterministic = 1.0 if detected == 0 else 1.0 - routes_with_response_gap / detected
    unresolved_ratio = 0.0 if detected == 0 else sum(1 for i in report.get("gaps", []) if i.get("gaps")) / detected

    return {
        "key": spec["key"],
        "framework": spec["framework"],
        "repo": spec["repo"],
        "commit": spec["commit"],
        "scanRoot": spec.get("scanRoot", ""),
        "routesDetected": detected,
        "routesExpected": expected,
        "falseRoutes": false_routes,
        "routeRecall": round(route_recall, 4),
        "routePrecision": round(route_precision, 4),
        "requestCompleteness": round(request_completeness, 4),
        "responseCompletenessDeterministic": round(response_deterministic, 4),
        "aiReviewRoutes": ai_review_routes,
        "unresolvedRatio": round(unresolved_ratio, 4),
        "gapCounts": dict(gap_counter),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scans", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    with open(args.manifest, encoding="utf-8") as handle:
        manifest = json.load(handle)

    rows = []
    for spec in manifest["projects"]:
        scan_path = os.path.join(args.scans, f"{spec['key']}.json")
        if not os.path.exists(scan_path):
            rows.append({"key": spec["key"], "framework": spec["framework"], "missing": True})
            continue
        rows.append(score_project(spec, load_scan(scan_path)))

    scored = [r for r in rows if not r.get("missing")]

    def axis(name):
        values = [r[name] for r in scored]
        return round(sum(values) / len(values), 4) if values else 0.0

    summary = {
        "gate": manifest["scoring"]["gate"],
        "projects": len(scored),
        "routeRecall": axis("routeRecall"),
        "routePrecision": axis("routePrecision"),
        "requestCompleteness": axis("requestCompleteness"),
        "responseCompletenessDeterministic": axis("responseCompletenessDeterministic"),
        "aiReviewRoutesTotal": sum(r["aiReviewRoutes"] for r in scored),
        "note": "responseCompletenessDeterministic excludes contracts proven only via the interactive AI review.",
    }
    summary["deterministicPass96"] = all(
        r["routeRecall"] >= 0.96 and r["routePrecision"] >= 0.96
        and r["requestCompleteness"] >= 0.96
        for r in scored
    )

    result = {"summary": summary, "projects": rows}
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
