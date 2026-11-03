"""
FactGuard — модуль штучного інтелекту (ШІ-аналіз новини).

Працює з будь-якою моделлю, що має OpenAI-сумісний API (/chat/completions):
  • gemini  — Google Gemini (є безкоштовний ключ: https://aistudio.google.com/apikey)   ← рекомендовано
  • groq    — Groq, моделі Llama (безкоштовний ключ: https://console.groq.com/keys)
  • openai  — OpenAI GPT (платно: https://platform.openai.com/api-keys)
  • ollama  — локальна модель на вашому комп'ютері, без інтернету і без ключа (https://ollama.com)
  • custom  — будь-який інший OpenAI-сумісний сервіс (OpenRouter, LM Studio…): задайте AI_BASE_URL

Налаштування — у файлі server/.env (зразок: server/.env.example):
  AI_PROVIDER=gemini
  AI_API_KEY=ваш_ключ
  AI_MODEL=            (необов'язково — інакше береться модель за замовчуванням)
  AI_BASE_URL=         (необов'язково — лише для custom)

Перевірити підключення:  python ai.py
Бібліотеки не потрібні: запити робимо стандартним urllib.
"""
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import date
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable, Dict, List, Optional

ENV_FILE = Path(__file__).resolve().parent / ".env"

PROVIDERS = {
    "gemini": {"name": "Google Gemini", "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
               "model": "gemini-3.8-flash", "needs_key": True},
    "groq": {"name": "Groq", "base_url": "https://api.groq.com/openai/v1",
             "model": "llama-3.3-70b-versatile", "needs_key": True},
    "openai": {"name": "OpenAI", "base_url": "https://api.openai.com/v1", "model": "gpt-4o-mini", "needs_key": True},
    "ollama": {"name": "Ollama (локально)", "base_url": "http://127.0.0.1:11434/v1", "model": "qwen2.5:7b",
               "needs_key": False},
    "custom": {"name": "Власний сервіс", "base_url": "", "model": "", "needs_key": False},
}

AI_TIMEOUT = 90          # секунд на відповідь хмарної моделі (можна змінити: AI_TIMEOUT=120 у .env)
OLLAMA_TIMEOUT = 240     # локальна модель на звичайному ПК думає значно довше
MAX_ANSWER_TOKENS = 1500
PAGE_TIMEOUT = 6         # секунд на завантаження однієї сторінки іншого сайту
PAGE_CHARS = 1500        # скільки тексту з кожної сторінки передаємо моделі
MAX_PAGES = 4            # скільки сторінок інших сайтів читаємо

VERDICTS = {
    "true": ("Правда", "good"),
    "likely_true": ("Ймовірно правда", "good"),
    "unverified": ("Не вдалося перевірити", "neutral"),
    "misleading": ("Маніпуляція / напівправда", "warn"),
    "likely_false": ("Ймовірно фейк", "bad"),
    "false": ("Фейк", "bad"),
}
ASSESSMENTS = {"confirmed": "підтверджено", "refuted": "спростовано", "unconfirmed": "не підтверджено", "no_data": "немає даних"}


class AIError(Exception):
    pass


class AITimeout(AIError):
    """Модель не встигла відповісти — можна спробувати ще раз з коротшим запитом."""


class AIUnavailable(AIError):
    """Сервіс ШІ тимчасово перевантажений або недоступний (429/500/502/503/504) — варто повторити пізніше."""

    def __init__(self, message: str, code: int = 503, retry_after: Optional[float] = None):
        super().__init__(message)
        self.code = code
        self.retry_after = retry_after


# ---------- Повтори та резервні моделі ----------
# Помилка 503 «This model is currently experiencing high demand» означає, що модель на боці Google
# тимчасово перевантажена. Це не помилка FactGuard: запит треба повторити трохи згодом
# або надіслати іншій (резервній) моделі, яка зараз вільніша.
_last = threading.local()  # яка модель фактично відповіла (могла бути резервна) — окремо для кожного запиту
RETRY_STATUS = {429, 500, 502, 503, 504}
RETRIES_PER_MODEL = 3    # спроб на одну модель (можна змінити: AI_RETRIES=2 у .env)
RETRY_BASE_DELAY = 2     # секунд перед першим повтором; далі пауза подвоюється: 2 с, 4 с…
RETRY_MAX_DELAY = 20     # не чекаємо довше за цю кількість секунд між спробами
# Резервні моделі за замовчуванням (можна задати свої: AI_FALLBACK_MODELS=модель1,модель2 у .env)
# Gemini 2.5 Google тепер дає лише тим, хто вже користувався ними раніше, тому резервні — актуальні моделі 3.x.
# «Lite»-моделі легші й рідше бувають перевантажені.
FALLBACK_MODELS = {
    "gemini": ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
    "groq": ["llama-3.1-8b-instant"],
}


# ---------- Налаштування ----------

def load_env_file(path: Path = ENV_FILE) -> None:
    """Читає server/.env (рядки КЛЮЧ=значення). Змінні, вже задані в системі, не перезаписуються."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and value and key not in os.environ:
            os.environ[key] = value


def get_config() -> Dict:
    provider = (os.environ.get("AI_PROVIDER") or "").strip().lower()
    if not provider or provider in ("none", "off", "0", "false"):
        return {"enabled": False, "reason": "ШІ не підключено: у файлі server/.env не задано AI_PROVIDER."}
    preset = PROVIDERS.get(provider)
    if not preset:
        return {"enabled": False, "reason": f"Невідомий AI_PROVIDER «{provider}». Можливі: {', '.join(PROVIDERS)}."}
    key = (os.environ.get("AI_API_KEY") or "").strip()
    base_url = (os.environ.get("AI_BASE_URL") or preset["base_url"]).strip().rstrip("/")
    model = (os.environ.get("AI_MODEL") or preset["model"]).strip()
    fallback_env = os.environ.get("AI_FALLBACK_MODELS")
    if fallback_env is not None:
        fallbacks = [m.strip() for m in fallback_env.split(",") if m.strip()]
    else:
        fallbacks = list(FALLBACK_MODELS.get(provider, []))
    fallbacks = [m for m in dict.fromkeys(fallbacks) if m != model]  # без повторів і без основної моделі
    try:
        retries = max(1, int(os.environ.get("AI_RETRIES") or RETRIES_PER_MODEL))
    except ValueError:
        retries = RETRIES_PER_MODEL
    if preset["needs_key"] and not key:
        return {"enabled": False, "reason": f"Для {preset['name']} потрібен ключ: задайте AI_API_KEY у файлі server/.env."}
    if not base_url or not model:
        return {"enabled": False, "reason": "Для custom задайте AI_BASE_URL і AI_MODEL у файлі server/.env."}
    try:
        timeout = int(os.environ.get("AI_TIMEOUT") or (OLLAMA_TIMEOUT if provider == "ollama" else AI_TIMEOUT))
    except ValueError:
        timeout = AI_TIMEOUT
    return {"enabled": True, "provider": provider, "name": preset["name"], "base_url": base_url, "model": model,
            "key": key, "timeout": max(10, timeout), "fallback_models": fallbacks, "retries": retries}


def public_config() -> Dict:
    """Те, що можна показати в розширенні (без ключа)."""
    cfg = get_config()
    if not cfg["enabled"]:
        return {"enabled": False, "reason": cfg["reason"]}
    return {"enabled": True, "provider": cfg["provider"], "name": cfg["name"], "model": cfg["model"]}


# ---------- Запит до моделі ----------

def _post_json(url: str, body: Dict, key: str, timeout: int) -> Dict:
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    request = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        if e.code in (401, 403):
            raise AIError(f"Ключ ШІ не підходить (помилка {e.code}). Перевірте AI_API_KEY у server/.env.") from e
        if e.code == 404:
            raise AIError(f"Модель або адресу не знайдено (404). Перевірте AI_MODEL / AI_BASE_URL. {detail}") from e
        if e.code in RETRY_STATUS:
            retry_after = None
            try:
                retry_after = float(e.headers.get("Retry-After")) if e.headers and e.headers.get("Retry-After") else None
            except (TypeError, ValueError):
                pass
            if e.code == 429:
                message = "Перевищено ліміт запитів до ШІ (429). Зачекайте хвилину."
            else:
                message = f"Сервіс ШІ тимчасово перевантажений або недоступний (помилка {e.code})."
            print(f"FactGuard: відповідь сервісу ШІ ({e.code}): {' '.join(detail.split())[:200]}", flush=True)
            raise AIUnavailable(message, e.code, retry_after) from e
        raise AIError(f"Сервіс ШІ повернув помилку {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        if isinstance(e.reason, TimeoutError) or "timed out" in str(e.reason):
            raise AITimeout(f"Сервіс ШІ не відповів за {timeout} с.") from e
        raise AIError(f"Не вдалося з'єднатися з сервісом ШІ ({url}): {e.reason}. "
                      "Перевірте інтернет (або чи запущено Ollama).") from e
    except TimeoutError as e:  # socket.timeout під час читання відповіді
        raise AITimeout(f"Сервіс ШІ не відповів за {timeout} с.") from e


def _chat_once(messages: List[Dict], cfg: Dict, model: str, json_mode: bool) -> Dict:
    """Один запит до конкретної моделі (без повторів при перевантаженні)."""
    body = {"model": model, "messages": messages, "temperature": 0.2, "max_tokens": MAX_ANSWER_TOKENS}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    low = model.lower()
    if cfg["provider"] == "gemini" and "2.5" in low:
        # Gemini 2.5 за замовчуванням спершу довго «думає» (thinking) — через це запит міг тривати понад хвилину.
        # Для фактчекінгу за готовими матеріалами це не потрібно: вимикаємо (Flash) або зменшуємо (Pro).
        body["reasoning_effort"] = "low" if "pro" in low else "none"
    elif cfg["provider"] == "gemini" and low.startswith(("gemini-3", "gemini-4")):
        # Gemini 3.x теж «думає»; повністю вимкнути не можна, але «low» — швидше й менше навантажує модель.
        # Якщо модель не прийме параметр (помилка 400), нижче запит повториться без нього.
        body["reasoning_effort"] = "low"
    url = cfg["base_url"] + "/chat/completions"
    timeout = cfg.get("timeout", AI_TIMEOUT)
    try:
        return _post_json(url, body, cfg["key"], timeout)
    except (AITimeout, AIUnavailable):
        raise
    except AIError as e:
        # Деякі моделі не підтримують JSON-режим чи інші параметри — пробуємо ще раз у найпростішому вигляді
        if "400" in str(e):
            for extra in ("response_format", "reasoning_effort", "max_tokens"):
                body.pop(extra, None)
            return _post_json(url, body, cfg["key"], timeout)
        raise


def chat(messages: List[Dict], cfg: Optional[Dict] = None, json_mode: bool = True,
         sleep: Callable = time.sleep) -> str:
    """Надсилає повідомлення моделі й повертає текст відповіді.

    Якщо модель перевантажена (503) чи перевищено ліміт (429), запит повторюється з паузою,
    що зростає (2 с, 4 с…), а потім — надсилається резервним моделям (AI_FALLBACK_MODELS).
    """
    cfg = cfg or get_config()
    if not cfg.get("enabled"):
        raise AIError(cfg.get("reason", "ШІ не підключено."))
    models = [cfg["model"]] + [m for m in cfg.get("fallback_models", []) if m != cfg["model"]]
    retries = max(1, int(cfg.get("retries", RETRIES_PER_MODEL)))
    started = time.time()
    last_error: Optional[AIError] = None
    data = None
    used_model = cfg["model"]
    for index, model in enumerate(models):
        if index:
            print(f"FactGuard: модель {models[index - 1]} недоступна, пробуємо резервну {model}…", flush=True)
        for attempt in range(retries):
            try:
                data = _chat_once(messages, cfg, model, json_mode)
                used_model = model
                break
            except AIUnavailable as e:
                last_error = e
                if attempt + 1 < retries:
                    delay = e.retry_after if e.retry_after else RETRY_BASE_DELAY * (2 ** attempt)
                    delay = min(RETRY_MAX_DELAY, max(0.0, delay))
                    print(f"FactGuard: ШІ ({model}) повернув {e.code}, повтор через {delay:.0f} с "
                          f"(спроба {attempt + 2} з {retries})…", flush=True)
                    sleep(delay)
            except AITimeout:
                raise
            except AIError as e:
                # Неправильний ключ на основній моделі — інші моделі не допоможуть, повідомляємо одразу
                if index == 0 and "Ключ ШІ не підходить" in str(e):
                    raise
                # Модель недоступна для цього ключа (404/403/400…) — пробуємо наступну резервну
                print(f"FactGuard: модель {model} не підійшла: {str(e)[:150]}", flush=True)
                if not isinstance(last_error, AIUnavailable):
                    last_error = e
                break
        if data is not None:
            break
    if data is None:
        if last_error is not None and not isinstance(last_error, AIUnavailable):
            raise last_error  # жодна модель не підійшла з іншої причини (наприклад, 404) — показуємо її
        tried = ", ".join(models)
        code = getattr(last_error, "code", 503)
        raise AIUnavailable(
            f"Сервіс ШІ зараз перевантажений (помилка {code}) — це тимчасово й не залежить від FactGuard. "
            f"Спробуйте ще раз за 1–2 хвилини. Перепробувано моделі: {tried}. "
            "Якщо помилка повторюється часто — у server/.env змініть AI_MODEL (наприклад, на gemini-3.5-flash-lite) "
            "або підключіть інший сервіс ШІ (наприклад, безкоштовний Groq), потім перезапустіть сервер.", code) from last_error
    _last.model = used_model
    print(f"FactGuard: ШІ ({used_model}) відповів за {time.time() - started:.1f} с", flush=True)
    try:
        return data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as e:
        raise AIError("Незрозуміла відповідь сервісу ШІ: " + json.dumps(data, ensure_ascii=False)[:300]) from e


def parse_json(text: str) -> Dict:
    """Дістає JSON з відповіді моделі (модель іноді обгортає його в ```json … ``` або додає пояснення)."""
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    try:
        return json.loads(text)
    except ValueError:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except ValueError:
                pass
    raise AIError("ШІ відповів не у форматі JSON. Спробуйте ще раз або виберіть іншу модель.")


# ---------- Читання сторінок інших сайтів ----------

class _TextExtractor(HTMLParser):
    """Збирає текст абзаців <p> (і заголовків) сторінки, пропускаючи скрипти, стилі, меню."""
    SKIP = {"script", "style", "noscript", "nav", "footer", "header", "aside", "form"}
    KEEP = {"p", "h1", "h2", "li", "blockquote"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip_depth = 0
        self.keep_depth = 0
        self.parts: List[str] = []
        self.buf: List[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip_depth += 1
        elif tag in self.KEEP:
            self.keep_depth += 1

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip_depth:
            self.skip_depth -= 1
        elif tag in self.KEEP and self.keep_depth:
            self.keep_depth -= 1
            if not self.keep_depth:
                chunk = " ".join("".join(self.buf).split())
                if len(chunk) >= 40:
                    self.parts.append(chunk)
                self.buf = []

    def handle_data(self, data):
        if self.keep_depth and not self.skip_depth:
            self.buf.append(data)


def fetch_page_text(url: str, limit: int = PAGE_CHARS) -> str:
    """Завантажує сторінку іншого сайту і повертає її основний текст (до limit символів)."""
    request = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        "Accept-Language": "uk-UA,uk;q=0.9,en;q=0.6",
    })
    with urllib.request.urlopen(request, timeout=PAGE_TIMEOUT) as response:
        if "html" not in (response.headers.get("Content-Type") or "html"):
            return ""
        raw = response.read(1_500_000)
        charset = response.headers.get_content_charset() or "utf-8"
    parser = _TextExtractor()
    parser.feed(raw.decode(charset, "replace"))
    return " ".join(parser.parts)[:limit]


def read_other_sites(evidence: Dict, fetch: Callable = fetch_page_text) -> List[Dict]:
    """Читає кілька знайдених публікацій (спершу перевірені ЗМІ та фактчекерів), щоб ШІ бачив не лише заголовки."""
    from concurrent.futures import ThreadPoolExecutor

    candidates = []
    sources = sorted(evidence.get("sources") or [], key=lambda s: not s.get("trusted"))
    for item in (evidence.get("factchecks") or [])[:2] + sources:
        url = item.get("read_url") or item.get("url") or ""
        if not url.startswith("http") or "news.google.com" in url or any(c["url"] == url for c in candidates):
            continue  # посилання Google Новин — це переадресація, текст статті з неї не прочитати
        candidates.append({"url": url, "name": item.get("publisher") or item.get("name") or item.get("domain") or ""})
        if len(candidates) >= MAX_PAGES:
            break

    def load(c):
        try:
            return dict(c, text=fetch(c["url"]))
        except Exception:
            return dict(c, text="")

    if not candidates:
        return []
    with ThreadPoolExecutor(max_workers=len(candidates)) as pool:
        pages = list(pool.map(load, candidates))
    return [p for p in pages if len(p["text"]) >= 100]


# ---------- ШІ-аналіз новини ----------

SYSTEM_PROMPT = """Ти — досвідчений український фактчекер (стандарти StopFake, VoxCheck, IFCN).
Твоє завдання — оцінити достовірність новини, спираючись ПЕРЕДУСІМ на надані матеріали інших сайтів
(результати пошуку, тексти статей, розбори фактчекерів), а не лише на власні знання.
Правила:
- Не вигадуй фактів і посилань. Якщо даних замало — так і скажи (verdict "unverified").
- Твої знання можуть бути застарілими: свіжу новину, якої ти не знаєш, не називай фейком лише через це.
- Перевірені ЗМІ (позначка "перевірене") і фактчекери важать більше, ніж невідомі сайти.
- Звертай увагу на маніпуляції: перебільшення, вирваний контекст, стара новина як нова, емоційний тиск, анонімні джерела.
- Пиши ЛИШЕ українською мовою, коротко і зрозуміло для звичайного читача.
Відповідай СТРОГО одним JSON-об'єктом такого вигляду:
{
  "verdict": "true | likely_true | unverified | misleading | likely_false | false",
  "confidence": число від 0 до 100,
  "summary": "2–3 речення: висновок і чому",
  "claims": [{"claim": "ключове твердження з новини", "assessment": "confirmed | refuted | unconfirmed | no_data", "evidence": "що про це кажуть інші джерела (з назвою джерела)"}],
  "manipulation": ["прийом маніпуляції, якщо є"],
  "advice": "одна порада читачеві, що перевірити самостійно"
}
claims — від 1 до 4 найважливіших тверджень. manipulation — порожній список, якщо прийомів немає."""


def build_prompt(title: str, text: str, url: str, evidence: Dict, pages: List[Dict]) -> str:
    lines = [f"Сьогодні: {date.today().isoformat()}", "", "НОВИНА ДЛЯ ПЕРЕВІРКИ",
             f"Заголовок: {title}", f"Адреса: {url or 'невідома'}"]
    if text:
        lines.append("Текст (уривок): " + " ".join(text.split())[:2500])

    lines += ["", "ЩО ЗНАЙДЕНО НА ІНШИХ САЙТАХ (пошук)"]
    sources = evidence.get("sources") or []
    if not sources:
        lines.append("— схожих публікацій в інших ЗМІ не знайдено")
    for s in sources[:8]:
        mark = "перевірене ЗМІ" if s.get("trusted") else "неперевірений сайт"
        lines.append(f"- [{mark}] {s.get('name') or s.get('domain')}: «{s.get('title', '')}» {s.get('snippet', '')}".strip())

    factchecks = evidence.get("factchecks") or []
    lines += ["", "РОЗБОРИ ФАКТЧЕКЕРІВ"]
    if not factchecks:
        lines.append("— не знайдено")
    for f in factchecks[:6]:
        lines.append(f"- {f.get('publisher', '')}: «{f.get('title', '')}» (оцінка: {f.get('rating', '')}, "
                     f"схожість з новиною: {f.get('similarity', '?')})")

    if evidence.get("label"):
        lines += ["", f"Автоматичний вердикт пошуку FactGuard: {evidence['label']} — {evidence.get('summary', '')}"]

    if pages:
        lines += ["", "ТЕКСТИ СТАТЕЙ З ІНШИХ САЙТІВ"]
        for p in pages:
            lines.append(f"[{p['name']}] {p['url']}\n{p['text']}\n")
    return "\n".join(lines)


def normalize(result: Dict) -> Dict:
    """Перевіряє відповідь моделі й приводить її до очікуваного формату (модель може помилитися з полями)."""
    verdict = str(result.get("verdict", "unverified")).strip().lower().replace(" ", "_")
    if verdict not in VERDICTS:
        verdict = "unverified"
    try:
        confidence = max(0, min(100, int(float(result.get("confidence", 50)))))
    except (TypeError, ValueError):
        confidence = 50
    claims = []
    for c in result.get("claims") or []:
        if not isinstance(c, dict) or not c.get("claim"):
            continue
        assessment = str(c.get("assessment", "no_data")).strip().lower()
        if assessment not in ASSESSMENTS:
            assessment = "no_data"
        claims.append({"claim": str(c["claim"])[:300], "assessment": assessment,
                       "assessment_label": ASSESSMENTS[assessment], "evidence": str(c.get("evidence", ""))[:400]})
    manipulation = [str(m)[:200] for m in (result.get("manipulation") or []) if str(m).strip()][:5]
    label, tone = VERDICTS[verdict]
    return {
        "verdict": verdict, "verdict_label": label, "tone": tone, "confidence": confidence,
        "summary": str(result.get("summary", ""))[:800], "claims": claims[:4], "manipulation": manipulation,
        "advice": str(result.get("advice", ""))[:300],
    }


def analyze_news(title: str, text: str = "", url: str = "", evidence: Optional[Dict] = None,
                 llm: Callable = chat, fetch: Callable = fetch_page_text, read_pages: bool = True) -> Dict:
    """Головна функція: читає інші сайти, питає модель, повертає перевірений результат."""
    cfg = get_config()
    if llm is chat and not cfg["enabled"]:
        raise AIError(cfg["reason"])
    evidence = evidence or {}
    pages = read_other_sites(evidence, fetch) if read_pages else []
    messages = [{"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": build_prompt(title, text, url, evidence, pages)}]
    _last.model = None
    try:
        raw = llm(messages)
    except AITimeout:
        # Модель не встигла — пробуємо ще раз з коротким запитом: без текстів статей і з коротшим уривком новини
        print("FactGuard: ШІ не встиг відповісти, повторюємо з коротшим запитом…", flush=True)
        pages = []
        messages[-1]["content"] = build_prompt(title, (text or "")[:800], url, evidence, [])
        try:
            raw = llm(messages)
        except AITimeout as e:
            raise AIError(str(e) + " Спробуйте ще раз за хвилину. Якщо повторюється — у файлі server/.env "
                          "задайте швидшу модель (наприклад, AI_MODEL=gemini-3.5-flash-lite) або збільште AI_TIMEOUT=180, "
                          "потім перезапустіть сервер.") from e
    result = normalize(parse_json(raw))
    result["pages_read"] = [{"url": p["url"], "name": p["name"]} for p in pages]
    result["model"] = (getattr(_last, "model", None) or cfg.get("model")) if cfg.get("enabled") else None
    result["provider"] = cfg.get("name") if cfg.get("enabled") else None
    return result


if __name__ == "__main__":
    # Швидка перевірка підключення:  python ai.py
    load_env_file()
    cfg = get_config()
    if not cfg["enabled"]:
        print("✗", cfg["reason"])
        print("  Скопіюйте server/.env.example у server/.env і впишіть туди AI_PROVIDER та AI_API_KEY.")
        raise SystemExit(1)
    print(f"Перевіряємо {cfg['name']}, модель {cfg['model']} …")
    try:
        answer = chat([{"role": "user", "content": 'Відповідай JSON: {"ok": true, "message": "привітання українською"}'}], cfg)
        print("✓ ШІ працює. Відповідь:", answer.strip()[:200])
    except AIError as e:
        print("✗", e)
        raise SystemExit(1)
