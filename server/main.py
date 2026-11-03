"""
FactGuard — локальний сервер перехресної перевірки новин (FastAPI).

Як це працює:
  1. Із заголовка новини виділяємо ключові слова (без «і», «що», «the» тощо).
  2. Шукаємо ці слова на інших сайтах: Google Новини, DuckDuckGo (новини + звичайний пошук)
     і окремо «<слова> фейк» — чи не спростовували це фактчекери.
  3. Для кожного знайденого результату рахуємо, наскільки він схожий на нашу новину.
  4. Дивимося, ХТО написав: перевірені ЗМІ (білий список ІМІ, міжнародні агенції),
     фактчекери (StopFake, VoxCheck…) чи невідомі сайти. Довідник — у ../data/trusted-media.json.
  5. Виносимо вердикт:
       refuted      — фактчекери або перевірене ЗМІ назвали фейком САМЕ це твердження;
       confirmed    — новину підтверджують щонайменше 2 незалежні джерела, з них хоча б одне перевірене;
       disputed     — фактчекери спростовували СХОЖІ твердження на ту саму тему;
       insufficient — у решті випадків (з поясненням, чому саме).

Додатково (необов'язково): ШІ-аналіз новини — див. ai.py і файл .env.example.

Запуск:  python main.py   (сервер слухає http://127.0.0.1:8000)
Документація API для тестів:  http://127.0.0.1:8000/docs
"""
import html
import json
import os
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import ai

ai.load_env_file()  # читаємо server/.env (ключ ШІ, GOOGLE_FACTCHECK_API_KEY) до всього іншого

HOST = "127.0.0.1"
PORT = 8000
DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "trusted-media.json"
CACHE_SECONDS = 30 * 60          # однакові запити не шукаємо повторно 30 хвилин
MATCH_THRESHOLD = 0.5            # яка частка ключових слів має збігтися, щоб вважати результат «про те саме»
DIRECT_REFUTE_THRESHOLD = 0.67   # спростування саме цього твердження (майже всі ключові слова збігаються)
RELATED_REFUTE_THRESHOLD = 0.5   # спростування схожого твердження (та сама тема)

# Слова, за якими фактчекери та ЗМІ позначають неправду
REFUTE_MARKERS = [
    "фейк", "fake", "неправд", "маніпул", "дезінформ", "іпсо", "ipso", "вигадк", "спростов",
    "не відповідає дійсності", "false", "misleading", "hoax", "фейков", "ложь", "неправда",
]

# Службові слова, які не допомагають знайти новину
STOPWORDS = set("""
і й та та й а але або чи що як це цей ця ці той та те ті у в на з із зі до від для про по при над під за через після
перед між без він вона воно вони ми ви я його її їх їм нас вас був була було були буде будуть є має мають може можуть
вже ще так не ні також лише тільки навіть дуже більше менше який яка яке які котрий де коли чому тому щоб якщо хоча
свій своя своє свої весь вся все всі цього цієї цих тих тому році року рік роки сьогодні вчора заявив заявила заявили
повідомив повідомила повідомили розповів розповіла сказав сказала новини новина новий нова нове нові
и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет
о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя
ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж
the a an and or but of to in on at for with by from as is are was were be been it its this that these those
""".split())


# ---------- Довідник джерел ----------

def load_directory() -> Dict:
    with open(DATA_FILE, encoding="utf-8") as f:
        return json.load(f)


DIRECTORY = load_directory()

# Соцмережі, відеохостинги та пошуковики — це не ЗМІ, тому не рахуємо їх «незалежними джерелами»
PLATFORMS = {"youtube.com", "youtu.be", "facebook.com", "instagram.com", "tiktok.com", "t.me", "telegram.org",
             "x.com", "twitter.com", "reddit.com", "wikipedia.org", "google.com", "bing.com", "msn.com",
             "yahoo.com", "linkedin.com", "pinterest.com", "threads.net", "vk.com", "ok.ru", "dzen.ru"}

MULTI_PART_SUFFIXES = ["com.ua", "org.ua", "net.ua", "in.ua", "kiev.ua", "kyiv.ua", "gov.ua", "edu.ua",
                       "co.uk", "org.uk", "com.au", "com.pl", "co.jp", "com.br"]


def registrable_domain(hostname: str) -> str:
    """news.bbc.co.uk → bbc.co.uk, www.pravda.com.ua → pravda.com.ua"""
    hostname = (hostname or "").lower().strip(".")
    if hostname.startswith("www."):
        hostname = hostname[4:]
    parts = hostname.split(".")
    for suffix in MULTI_PART_SUFFIXES:
        if hostname.endswith("." + suffix):
            return ".".join(parts[-(suffix.count(".") + 2):])
    return ".".join(parts[-2:])


def classify_domain(hostname: str) -> Dict:
    """Повертає {'category': 'imi'|'international'|'factchecker'|'official'|None, 'name': ...}"""
    hostname = (hostname or "").lower()
    for key, category in (("factcheckers", "factchecker"), ("imi", "imi"), ("international", "international")):
        for entry in DIRECTORY.get(key, []):
            for d in entry["domains"]:
                if hostname == d or hostname.endswith("." + d):
                    return {"category": category, "name": entry["name"]}
    if hostname.endswith(".gov.ua"):
        return {"category": "official", "name": "Державний сайт"}
    return {"category": None, "name": None}


# ---------- Ключові слова та схожість ----------

def tokenize(text: str) -> List[str]:
    return re.findall(r"[0-9a-zа-яіїєґё'’]+", (text or "").lower())


def stem(word: str) -> str:
    # Дуже проста «основа» слова: відкидаємо закінчення, щоб «бюджет», «бюджету», «бюджетом» збігалися
    word = word.replace("’", "'")
    return word[:6] if len(word) > 6 else word


def extract_keywords(title: str, text: str = "", limit: int = 7) -> List[str]:
    """Ключові слова із заголовка (якщо їх мало — додаємо з першого речення тексту)."""
    words: List[str] = []
    seen = set()
    sources = [title or ""]
    first_sentence = re.split(r"(?<=[.!?])\s", (text or "").strip(), maxsplit=1)[0] if text else ""
    sources.append(first_sentence)
    for source in sources:
        for w in tokenize(source):
            if w in STOPWORDS or len(w) < 3 or stem(w) in seen:
                continue
            seen.add(stem(w))
            words.append(w)
        if len(words) >= 4:
            break
    return words[:limit]


def similarity(keywords: List[str], text: str) -> float:
    """Яка частка ключових слів новини трапляється в тексті результату пошуку (0…1)."""
    if not keywords:
        return 0.0
    found = {stem(w) for w in tokenize(text)}
    hits = sum(1 for k in keywords if stem(k) in found)
    return hits / len(keywords)


def plural(n: int, one: str, few: str, many: str) -> str:
    """Українські відмінки після числа: 1 сайт, 3 сайти, 5 сайтів."""
    if n % 10 == 1 and n % 100 != 11:
        return f"{n} {one}"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return f"{n} {few}"
    return f"{n} {many}"


def has_refute_marker(text: str) -> bool:
    lower = (text or "").lower()
    return any(m in lower for m in REFUTE_MARKERS)


# ---------- Пошук ----------

class SearchError(Exception):
    pass


def ddg_search(query: str, kind: str = "text", max_results: int = 20) -> List[Dict]:
    """Пошук через DuckDuckGo. Повертає [{'title', 'url', 'body'}]."""
    try:
        from ddgs import DDGS  # нова назва бібліотеки
    except ImportError:  # стара назва
        from duckduckgo_search import DDGS
    try:
        engine = DDGS()
        if kind == "news":
            raw = engine.news(query, region="ua-uk", max_results=max_results) or []
        else:
            raw = engine.text(query, region="ua-uk", max_results=max_results) or []
    except Exception as e:
        # Бібліотека повідомляє «нічого не знайдено» винятком — для нас це просто порожній результат
        if "no results" in str(e).lower():
            return []
        raise SearchError(str(e)) from e  # обмеження частоти запитів, немає інтернету тощо
    return [{"title": r.get("title", ""), "url": r.get("href") or r.get("url", ""), "body": r.get("body", "")}
            for r in raw if (r.get("href") or r.get("url"))]


def google_news_search(query: str, max_results: int = 20) -> List[Dict]:
    """Пошук у Google Новинах через відкритий RSS (ключ не потрібен). Повертає [{'title','url','body','source_url'}]."""
    params = urllib.parse.urlencode({"q": query, "hl": "uk", "gl": "UA", "ceid": "UA:uk"})
    request = urllib.request.Request("https://news.google.com/rss/search?" + params,
                                     headers={"User-Agent": "Mozilla/5.0 FactGuard"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            root = ET.fromstring(response.read())
    except Exception as e:
        raise SearchError("Google Новини: " + str(e)) from e
    out = []
    for item in root.iter("item"):
        source = item.find("source")
        publisher = (source.text or "").strip() if source is not None else ""
        title = (item.findtext("title") or "").strip()
        if publisher and title.endswith(" - " + publisher):
            title = title[: -len(publisher) - 3]  # «Заголовок - Назва видання» → «Заголовок»
        body = re.sub(r"<[^>]+>", " ", html.unescape(item.findtext("description") or ""))
        body = body.replace(title, " ").replace(publisher, " ") if title else body  # опис RSS дублює заголовок
        out.append({"title": title, "url": (item.findtext("link") or "").strip(), "body": " ".join(body.split()),
                    "source_url": source.get("url", "") if source is not None else "", "date": item.findtext("pubDate") or ""})
        if len(out) >= max_results:
            break
    return out


def web_search(query: str, kind: str = "text", max_results: int = 20) -> List[Dict]:
    """Єдина точка пошуку: kind = news | text (DuckDuckGo) або gnews (Google Новини)."""
    if kind == "gnews":
        return google_news_search(query, max_results)
    return ddg_search(query, kind, max_results)


def google_factcheck(query: str) -> List[Dict]:
    """Google Fact Check Tools API (необов'язково). Потрібен ключ у змінній GOOGLE_FACTCHECK_API_KEY."""
    key = os.environ.get("GOOGLE_FACTCHECK_API_KEY")
    if not key:
        return []
    params = urllib.parse.urlencode({"query": query, "languageCode": "uk", "pageSize": 10, "key": key})
    try:
        with urllib.request.urlopen("https://factchecktools.googleapis.com/v1alpha1/claims:search?" + params, timeout=8) as r:
            data = json.load(r)
    except Exception:
        return []
    out = []
    for claim in data.get("claims", []):
        for review in claim.get("claimReview", []):
            rating = review.get("textualRating", "")
            out.append({
                "title": review.get("title") or claim.get("text", ""),
                "url": review.get("url", ""),
                "body": claim.get("text", ""),
                "publisher": (review.get("publisher") or {}).get("name", "Google Fact Check"),
                "rating": rating,
                "refutes": has_refute_marker(rating),
            })
    return out


# ---------- Вердикт ----------

def verify(title: str, text: str = "", url: str = "", style_score: Optional[float] = None,
           search: Callable = web_search, factcheck_api: Callable = google_factcheck) -> Dict:
    keywords = extract_keywords(title, text)
    if len(keywords) < 2:
        raise ValueError("Замало змістовних слів для пошуку. Виділіть повніший заголовок або речення.")
    query = " ".join(keywords)
    own_domain = registrable_domain(urllib.parse.urlparse(url).hostname or "") if url else ""

    # Для пошуку спростувань беремо 3 найдовші (найзмістовніші) слова: фактчекери переказують фейк
    # своїми словами, і точний довгий запит їх не знаходить
    longest = sorted(keywords, key=len, reverse=True)[:3]
    core_query = " ".join(w for w in keywords if w in longest)

    # Чотири пошуки паралельно: Google Новини, новини DuckDuckGo, звичайний DuckDuckGo
    # і окремо — чи не називав хтось це фейком. Якщо один пошуковик недоступний, працюють інші.
    plan = ((query, "gnews"), (query, "news"), (query, "text"), (core_query + " фейк", "text"))

    def run(job):
        try:
            return search(job[0], job[1]), None
        except SearchError as e:
            return [], str(e)
        except Exception as e:  # будь-яка інша несподівана помилка одного пошуковика не повинна ламати решту
            return [], str(e)

    with ThreadPoolExecutor(max_workers=len(plan)) as pool:
        outcomes = list(pool.map(run, plan))
    results: List[Dict] = [r for found, _ in outcomes for r in found]
    errors = [err for _, err in outcomes if err]
    if len(errors) == len(plan):
        raise SearchError(errors[0])

    sources: Dict[str, Dict] = {}
    factchecks: List[Dict] = []
    seen_urls = set()
    for r in results:
        if r["url"] in seen_urls:
            continue
        seen_urls.add(r["url"])
        # Для Google Новин посилання веде на news.google.com, а справжній сайт — у source_url
        host = (urllib.parse.urlparse(r.get("source_url") or r["url"]).hostname or "").lower()
        domain = registrable_domain(host)
        if not domain or domain == own_domain or domain in PLATFORMS:
            continue
        score = similarity(keywords, r["title"] + " " + r["body"])
        if score < MATCH_THRESHOLD:
            continue
        info = classify_domain(host)
        snippet = r["body"][:220]
        refutes = has_refute_marker(r["title"] + " " + r["body"])

        if info["category"] == "factchecker" or (info["category"] in ("imi", "international", "official") and refutes):
            direct = score >= DIRECT_REFUTE_THRESHOLD
            duplicate = any(f["publisher"] == info["name"] and f["title"] == r["title"] for f in factchecks)
            if not duplicate:  # та сама стаття могла прийти і з Google Новин, і з DuckDuckGo
                factchecks.append({
                    "title": r["title"], "url": r["url"], "publisher": info["name"], "snippet": snippet,
                    "rating": ("ФЕЙК" if direct else "схожий фейк") if refutes else "розбір",
                    "refutes": refutes and direct, "related": refutes and not direct, "similarity": round(score, 2),
                    "read_url": None if "news.google." in r["url"] else r["url"],
                })
            if info["category"] == "factchecker":
                continue  # фактчекера не рахуємо як «ще одне ЗМІ, що підтверджує»
        if refutes:
            continue  # стаття «Фейк: …» не підтверджує новину
        is_direct = "news.google." not in r["url"]
        if domain not in sources or score > sources[domain]["similarity"]:
            previous = sources.get(domain, {}).get("read_url")
            sources[domain] = {
                "title": r["title"], "url": r["url"], "domain": domain, "name": info["name"], "snippet": snippet,
                "trusted": info["category"] in ("imi", "international", "official"), "similarity": round(score, 2),
                "read_url": r["url"] if is_direct else previous,
            }
        elif is_direct and not sources[domain].get("read_url"):
            sources[domain]["read_url"] = r["url"]  # пряме посилання на статтю — щоб ШІ міг її прочитати

    for fc in factcheck_api(query):
        score = similarity(keywords, fc["title"] + " " + fc["body"])
        if score >= RELATED_REFUTE_THRESHOLD:
            direct = score >= DIRECT_REFUTE_THRESHOLD
            factchecks.append({
                "title": fc["title"], "url": fc["url"], "publisher": fc["publisher"], "rating": fc["rating"],
                "refutes": fc["refutes"] and direct, "related": fc["refutes"] and not direct, "similarity": round(score, 2),
            })

    source_list = sorted(sources.values(), key=lambda s: (not s["trusted"], -s["similarity"]))
    independent = len(source_list)
    trusted = sum(1 for s in source_list if s["trusted"])
    factchecks.sort(key=lambda f: (not f["refutes"], not f.get("related"), -f.get("similarity", 0)))
    refuting = [f for f in factchecks if f["refutes"]]
    related = [f for f in factchecks if f.get("related")]

    if refuting:
        status, label = "refuted", "Спростовано"
        summary = f"Знайдено {plural(len(refuting), 'спростування', 'спростування', 'спростувань')} саме цього твердження від фактчекерів або перевірених ЗМІ. Відкрийте розбір нижче."
    elif trusted >= 2 or (trusted >= 1 and independent >= 2):
        status, label = "confirmed", "Підтверджують незалежні ЗМІ"
        summary = f"Про це пишуть {plural(independent, 'незалежне джерело', 'незалежні джерела', 'незалежних джерел')}, з них перевірених — {trusted}."
        if related:
            summary += " Фактчекери раніше спростовували схожі твердження на цю тему — подивіться, чи це не інша історія."
    elif related:
        status, label = "disputed", "Схожі твердження спростовували"
        summary = (f"Фактчекери вже спростовували схожі твердження на цю тему ({len(related)}). "
                   "Перевірте, чи це не та сама вигадка в новій обгортці.")
    elif independent == 0:
        status, label = "insufficient", "Інші ЗМІ не пишуть"
        summary = "Схожих публікацій в інших ЗМІ не знайдено. Це не доводить, що новина фейкова, але вона нічим не підтверджена."
    elif trusted == 0:
        status, label = "insufficient", "Лише неперевірені сайти"
        summary = f"Про це пишуть {plural(independent, 'сайт', 'сайти', 'сайтів')}, але жодне з перевірених ЗМІ. Фейки часто передруковують десятки сайтів."
    else:
        status, label = "insufficient", "Лише одне джерело"
        summary = "Знайдено лише одне незалежне джерело. Зачекайте на підтвердження від інших ЗМІ."

    if style_score is not None and style_score >= 60:
        summary += " Подача новини має багато ознак маніпуляції — будьте особливо уважні."

    return {
        "status": status,
        "label": label,
        "summary": summary,
        "query": query,
        "keywords": keywords,
        "counts": {"independent": independent, "trusted": trusted, "factchecks": len(factchecks)},
        "sources": source_list[:8],
        "factchecks": factchecks[:6],
        "search_url": "https://news.google.com/search?" + urllib.parse.urlencode({"q": query, "hl": "uk", "gl": "UA", "ceid": "UA:uk"}),
        "partial_search": bool(errors),
    }


# ---------- API ----------

app = FastAPI(title="FactGuard API", version="2.1.0",
              description="Перехресна перевірка новин у незалежних ЗМІ та у фактчекерів.")
app.add_middleware(CORSMiddleware, allow_origin_regex=r"chrome-extension://.*", allow_methods=["GET", "POST"],
                   allow_headers=["Content-Type"])


class NewsIn(BaseModel):
    title: str = ""
    text: str = ""
    url: str = ""
    style_score: Optional[float] = None


class AiIn(BaseModel):
    title: str = ""
    text: str = ""
    url: str = ""
    evidence: Optional[Dict] = None  # результат /api/verify-news (щоб не шукати вдруге)


_cache: Dict[str, tuple] = {}
_ai_cache: Dict[str, tuple] = {}


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "google_factcheck": bool(os.environ.get("GOOGLE_FACTCHECK_API_KEY")),
        "trusted_sources": sum(len(DIRECTORY.get(k, [])) for k in ("imi", "international", "factcheckers")),
        "directory_updated": DIRECTORY.get("updated"),
        "ai": ai.public_config(),
    }


@app.post("/api/verify-news")
def verify_news(news: NewsIn):
    title = news.title.strip() or news.text.strip()[:250]
    if not title:
        raise HTTPException(status_code=400, detail="Порожній запит: немає ні заголовка, ні тексту.")
    key = title.lower()
    cached = _cache.get(key)
    if cached and time.time() - cached[0] < CACHE_SECONDS:
        result = dict(cached[1])
    else:
        try:
            result = verify(title, news.text, news.url)  # style_score додаємо нижче, щоб не потрапив у кеш
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except SearchError:
            raise HTTPException(status_code=503, detail="Пошук (Google Новини, DuckDuckGo) тимчасово недоступний: "
                                                        "немає інтернету або обмеження частоти запитів. "
                                                        "Зачекайте хвилину і спробуйте ще раз.")
        if not result["partial_search"]:
            _cache[key] = (time.time(), dict(result))  # копія: нижче відповідь ще доповнюється
    # Пояснення про стиль залежить від конкретного запиту, а не від кешу
    if news.style_score is not None and news.style_score >= 60 and "ознак маніпуляції" not in result["summary"]:
        result["summary"] += " Подача новини має багато ознак маніпуляції — будьте особливо уважні."
    return result


@app.post("/api/ai-check")
def ai_check(news: AiIn):
    """ШІ-аналіз: модель читає новину, результати пошуку та тексти статей інших сайтів і робить висновок."""
    cfg = ai.public_config()
    if not cfg["enabled"]:
        return {"enabled": False, "reason": cfg["reason"]}
    title = news.title.strip() or news.text.strip()[:250]
    if not title:
        raise HTTPException(status_code=400, detail="Порожній запит: немає ні заголовка, ні тексту.")
    key = cfg["provider"] + "|" + cfg["model"] + "|" + title.lower()
    cached = _ai_cache.get(key)
    if cached and time.time() - cached[0] < CACHE_SECONDS:
        return cached[1]

    evidence = news.evidence
    if not evidence:  # розширення не передало результат пошуку — шукаємо самі (помилку пошуку не вважаємо фатальною)
        try:
            evidence = verify(title, news.text, news.url)
        except (ValueError, SearchError):
            evidence = {}
    try:
        result = ai.analyze_news(title, news.text, news.url, evidence)
    except ai.AIUnavailable as e:
        # Модель тимчасово перевантажена (503) / ліміт (429) — навіть після повторів і резервних моделей
        raise HTTPException(status_code=503, detail=str(e))
    except ai.AIError as e:
        raise HTTPException(status_code=502, detail=str(e))
    result["enabled"] = True
    _ai_cache[key] = (time.time(), result)
    return result


if __name__ == "__main__":
    import uvicorn

    print("FactGuard: сервер запускається на http://%s:%d  (зупинка — Ctrl+C)" % (HOST, PORT))
    _ai = ai.public_config()
    print("FactGuard: ШІ-аналіз —", f"увімкнено ({_ai['name']}, {_ai['model']})" if _ai["enabled"] else _ai["reason"])
    uvicorn.run(app, host=HOST, port=PORT)
