"""
FactGuard — оцінювання ефективності (для розділу «Оцінювання» курсової/дипломної роботи).

Проганяє набір новин із відомою відповіддю (фейк / правда) через перевірку FactGuard
і рахує метрики: точність (accuracy), precision, recall, F1 для класу «фейк», а також покриття
(для скількох новин програма взагалі дала відповідь, а не «недостатньо даних»).

1) Заповніть dataset.csv: колонки title,label[,url], де label = fake або true.
   Фейки беріть з архівів StopFake / VoxCheck / «По той бік новин», правдиві новини — з білого списку ІМІ.
   Бажано ~50 фейків і ~50 правдивих. Рядки, що починаються з #, пропускаються.
2) Запустіть:   python evaluate.py              (лише пошук на інших сайтах)
                python evaluate.py --ai         (пошук + ШІ; потрібен ключ у .env)
3) Результат — у консолі та у файлі evaluation_results.csv (можна відкрити в Excel).
"""
import argparse
import csv
import time
from pathlib import Path

import ai
import main

HERE = Path(__file__).resolve().parent

# Як перетворити вердикт у відповідь «fake» / «true» / None (утрималась)
SEARCH_MAP = {"refuted": "fake", "disputed": "fake", "confirmed": "true", "insufficient": None}
AI_MAP = {"false": "fake", "likely_false": "fake", "misleading": "fake", "true": "true", "likely_true": "true", "unverified": None}


def metrics(rows, key):
    answered = [r for r in rows if r[key] in ("fake", "true")]
    tp = sum(1 for r in answered if r[key] == "fake" and r["label"] == "fake")
    fp = sum(1 for r in answered if r[key] == "fake" and r["label"] == "true")
    fn = sum(1 for r in answered if r[key] == "true" and r["label"] == "fake")
    correct = sum(1 for r in answered if r[key] == r["label"])
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "всього": len(rows), "з відповіддю": len(answered),
        "покриття": len(answered) / len(rows) if rows else 0.0,
        "точність (accuracy)": correct / len(answered) if answered else 0.0,
        "precision (фейк)": precision, "recall (фейк)": recall, "F1 (фейк)": f1,
    }


def print_metrics(title, m):
    print(f"\n=== {title} ===")
    for k, v in m.items():
        print(f"  {k:22s} {v:.1%}" if isinstance(v, float) else f"  {k:22s} {v}")


def main_cli():
    parser = argparse.ArgumentParser(description="Оцінювання ефективності FactGuard")
    parser.add_argument("dataset", nargs="?", default=str(HERE / "dataset.csv"))
    parser.add_argument("--ai", action="store_true", help="додатково перевіряти через ШІ")
    parser.add_argument("--pause", type=float, default=3.0, help="пауза між запитами, с (щоб пошуковики не блокували)")
    args = parser.parse_args()

    with open(args.dataset, encoding="utf-8-sig") as f:
        items = [r for r in csv.DictReader(line for line in f if not line.lstrip().startswith("#"))
                 if (r.get("title") or "").strip() and (r.get("label") or "").strip() in ("fake", "true")]
    if not items:
        raise SystemExit("У файлі немає рядків з label = fake або true.")
    if args.ai and not ai.get_config()["enabled"]:
        raise SystemExit("ШІ не підключено: " + ai.get_config()["reason"])

    rows = []
    for i, item in enumerate(items, 1):
        title, label, url = item["title"].strip(), item["label"].strip(), (item.get("url") or "").strip()
        row = {"title": title, "label": label, "search_verdict": "", "search": None, "ai_verdict": "", "ai": None, "seconds": 0}
        started = time.time()
        evidence = {}
        try:
            evidence = main.verify(title, "", url)
            row["search_verdict"] = evidence["status"]
            row["search"] = SEARCH_MAP.get(evidence["status"])
        except Exception as e:
            row["search_verdict"] = "помилка: " + str(e)[:60]
        if args.ai:
            try:
                result = ai.analyze_news(title, "", url, evidence)
                row["ai_verdict"] = result["verdict"]
                row["ai"] = AI_MAP.get(result["verdict"])
            except Exception as e:
                row["ai_verdict"] = "помилка: " + str(e)[:60]
        row["seconds"] = round(time.time() - started, 1)
        rows.append(row)
        print(f"[{i}/{len(items)}] {label:4s} | пошук: {row['search_verdict']:12s} | ШІ: {row['ai_verdict'] or '—':12s} | {title[:60]}")
        time.sleep(args.pause)

    print_metrics("Пошук на інших сайтах", metrics(rows, "search"))
    if args.ai:
        print_metrics("ШІ-аналіз", metrics(rows, "ai"))
    print(f"\nСередній час перевірки: {sum(r['seconds'] for r in rows) / len(rows):.1f} с")

    out = HERE / "evaluation_results.csv"
    with open(out, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print("Детальні результати збережено у", out)


if __name__ == "__main__":
    main_cli()
