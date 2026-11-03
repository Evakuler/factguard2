"""
Тести логіки вердикту. Інтернет не потрібен: замість DuckDuckGo підставляємо «фальшивий» пошук.
Запуск:  python -m unittest test_main.py -v
"""
import json
import os
import unittest
from unittest import mock

from fastapi.testclient import TestClient

import ai
import main

TITLE = "Верховна Рада ухвалила державний бюджет на 2027 рік"


def fake_search(results_by_kind):
    """Повертає функцію пошуку, яка віддає заздалегідь задані результати."""
    def search(query, kind="text", max_results=20):
        if query.endswith(" фейк"):
            return results_by_kind.get("fake", [])
        return results_by_kind.get(kind, [])
    return search


def r(url, title, body=""):
    return {"url": url, "title": title, "body": body}


def no_api(query):
    return []


class KeywordTests(unittest.TestCase):
    def test_stopwords_removed(self):
        kws = main.extract_keywords("Вчора у Києві відбулася велика нарада щодо бюджету")
        self.assertNotIn("у", kws)
        self.assertIn("києві", kws)

    def test_similarity_handles_word_endings(self):
        kws = main.extract_keywords(TITLE)
        self.assertGreaterEqual(main.similarity(kws, "Рада ухвалила держбюджет: бюджету на 2027 рік надано голоси"), 0.5)
        self.assertLess(main.similarity(kws, "Погода в Карпатах на вихідні"), 0.2)

    def test_registrable_domain(self):
        self.assertEqual(main.registrable_domain("www.pravda.com.ua"), "pravda.com.ua")
        self.assertEqual(main.registrable_domain("news.bbc.co.uk"), "bbc.co.uk")
        self.assertEqual(main.registrable_domain("suspilne.media"), "suspilne.media")

    def test_classify(self):
        self.assertEqual(main.classify_domain("www.stopfake.org")["category"], "factchecker")
        self.assertEqual(main.classify_domain("suspilne.media")["category"], "imi")
        self.assertEqual(main.classify_domain("mof.gov.ua")["category"], "official")
        self.assertIsNone(main.classify_domain("random-news.site")["category"])


class VerdictTests(unittest.TestCase):
    def run_verify(self, results, title=TITLE, url="https://example-news.com/a"):
        return main.verify(title, "", url, search=fake_search(results), factcheck_api=no_api)

    def test_confirmed_by_trusted_media(self):
        out = self.run_verify({
            "news": [r("https://suspilne.media/1", "Верховна Рада ухвалила держбюджет на 2027 рік")],
            "text": [r("https://www.pravda.com.ua/news/2", "Рада ухвалила державний бюджет-2027"),
                     r("https://some-blog.com/x", "Ухвалила Рада бюджет на 2027 рік")],
        })
        self.assertEqual(out["status"], "confirmed")
        self.assertEqual(out["counts"]["trusted"], 2)
        self.assertTrue(out["sources"][0]["trusted"])  # перевірені джерела — першими

    def test_refuted_by_factchecker(self):
        out = self.run_verify({
            "fake": [r("https://www.stopfake.org/uk/fejk", "Фейк: Верховна Рада ухвалила державний бюджет на 2027 рік без видатків на армію")],
        })
        self.assertEqual(out["status"], "refuted")
        self.assertEqual(out["factchecks"][0]["publisher"], "StopFake")

    def test_trusted_media_debunk_counts_as_refutation(self):
        out = self.run_verify({
            "fake": [r("https://suspilne.media/5", "ЦПД: «Рада ухвалила державний бюджет на 2027 рік без пенсій» — це фейк")],
        })
        self.assertEqual(out["status"], "refuted")

    def test_factchecker_without_fake_marker_is_not_refutation(self):
        out = self.run_verify({
            "text": [r("https://voxukraine.org/a", "Чи справді Верховна Рада ухвалила державний бюджет на 2027 рік? Так, це правда")],
        })
        self.assertNotEqual(out["status"], "refuted")
        self.assertEqual(len(out["factchecks"]), 1)

    def test_related_debunk_is_disputed_not_refuted(self):
        # Спростування на ту саму тему, але іншого твердження (збіг 3 з 6 ключових слів)
        out = self.run_verify({
            "fake": [r("https://www.stopfake.org/uk/x", "Фейк: Верховна Рада скасувала пенсії через бюджет")],
        })
        self.assertEqual(out["status"], "disputed")
        self.assertFalse(out["factchecks"][0]["refutes"])

    def test_confirmed_wins_over_related_debunk(self):
        out = self.run_verify({
            "news": [r("https://suspilne.media/1", "Верховна Рада ухвалила держбюджет на 2027 рік"),
                     r("https://www.pravda.com.ua/2", "Рада ухвалила державний бюджет-2027")],
            "fake": [r("https://www.stopfake.org/uk/x", "Фейк: Верховна Рада скасувала пенсії через бюджет")],
        })
        self.assertEqual(out["status"], "confirmed")
        self.assertIn("схожі твердження", out["summary"])

    def test_nothing_found(self):
        out = self.run_verify({"news": [r("https://weather.ua/1", "Погода на вихідні")]})
        self.assertEqual(out["status"], "insufficient")
        self.assertEqual(out["label"], "Інші ЗМІ не пишуть")

    def test_only_unknown_sites(self):
        out = self.run_verify({"text": [
            r("https://site1.xyz/a", "Верховна Рада ухвалила державний бюджет на 2027 рік"),
            r("https://site2.top/b", "Верховна Рада ухвалила державний бюджет 2027"),
            r("https://site3.club/c", "Рада ухвалила державний бюджет на 2027 рік"),
        ]})
        self.assertEqual(out["status"], "insufficient")
        self.assertEqual(out["label"], "Лише неперевірені сайти")
        self.assertEqual(out["counts"]["independent"], 3)

    def test_own_site_is_not_independent(self):
        out = self.run_verify({"news": [
            r("https://suspilne.media/1", "Верховна Рада ухвалила державний бюджет на 2027 рік"),
            r("https://suspilne.media/2", "Верховна Рада ухвалила державний бюджет на 2027 рік — деталі"),
        ]}, url="https://suspilne.media/original")
        self.assertEqual(out["counts"]["independent"], 0)

    def test_same_domain_counted_once(self):
        out = self.run_verify({"news": [
            r("https://site1.xyz/a", "Верховна Рада ухвалила державний бюджет на 2027 рік"),
            r("https://news.site1.xyz/b", "Верховна Рада ухвалила державний бюджет на 2027 рік"),
        ]})
        self.assertEqual(out["counts"]["independent"], 1)

    def test_social_networks_are_not_sources(self):
        out = self.run_verify({"text": [
            r("https://www.youtube.com/watch?v=1", "Верховна Рада ухвалила державний бюджет на 2027 рік"),
            r("https://www.facebook.com/p/1", "Верховна Рада ухвалила державний бюджет на 2027 рік"),
        ]})
        self.assertEqual(out["counts"]["independent"], 0)

    def test_search_down_raises(self):
        def broken(query, kind="text", max_results=20):
            raise main.SearchError("rate limit")
        with self.assertRaises(main.SearchError):
            main.verify(TITLE, search=broken, factcheck_api=no_api)

    def test_too_short_claim(self):
        with self.assertRaises(ValueError):
            main.verify("Шок!", search=fake_search({}), factcheck_api=no_api)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        main._cache.clear()
        self._orig = main.verify

    def tearDown(self):
        main.verify = self._orig

    def test_health(self):
        self.assertEqual(self.client.get("/api/health").json()["status"], "ok")

    def test_empty_request(self):
        self.assertEqual(self.client.post("/api/verify-news", json={}).status_code, 400)

    def test_search_unavailable_is_503(self):
        def broken(*a, **k):
            raise main.SearchError("rate limit")
        main.verify = broken
        resp = self.client.post("/api/verify-news", json={"title": TITLE})
        self.assertEqual(resp.status_code, 503)
        self.assertIn("DuckDuckGo", resp.json()["detail"])

    def test_style_note_not_cached(self):
        main.verify = lambda *a, **k: {"status": "insufficient", "label": "x", "summary": "Base.", "partial_search": False}
        first = self.client.post("/api/verify-news", json={"title": TITLE, "style_score": 80}).json()
        second = self.client.post("/api/verify-news", json={"title": TITLE, "style_score": 0}).json()
        self.assertIn("маніпуляції", first["summary"])
        self.assertEqual(second["summary"], "Base.")


class GoogleNewsTests(unittest.TestCase):
    def test_google_news_source_domain_is_used(self):
        """Посилання Google Новин веде на news.google.com, але рахуватися має справжній сайт видання."""
        out = main.verify(TITLE, "", "https://example-news.com/a", factcheck_api=no_api, search=fake_search({
            "gnews": [
                {"url": "https://news.google.com/rss/articles/abc", "source_url": "https://suspilne.media",
                 "title": "Верховна Рада ухвалила держбюджет на 2027 рік", "body": ""},
                {"url": "https://news.google.com/rss/articles/def", "source_url": "https://www.pravda.com.ua",
                 "title": "Рада ухвалила державний бюджет-2027", "body": ""},
            ]}))
        self.assertEqual(out["status"], "confirmed")
        self.assertEqual({s["domain"] for s in out["sources"]}, {"suspilne.media", "pravda.com.ua"})

    def test_one_search_engine_down_is_not_fatal(self):
        def partly_broken(query, kind="text", max_results=20):
            if kind == "gnews":
                raise main.SearchError("offline")
            return fake_search({"news": [r("https://suspilne.media/1", "Верховна Рада ухвалила держбюджет на 2027 рік")]})(query, kind)
        out = main.verify(TITLE, "", "", search=partly_broken, factcheck_api=no_api)
        self.assertTrue(out["partial_search"])
        self.assertEqual(out["counts"]["trusted"], 1)


def fake_llm(answer):
    def llm(messages):
        fake_llm.last_prompt = messages[-1]["content"]
        return answer if isinstance(answer, str) else json.dumps(answer, ensure_ascii=False)
    return llm


class AiTests(unittest.TestCase):
    EVIDENCE = {
        "label": "Підтверджують незалежні ЗМІ", "summary": "…",
        "sources": [{"url": "https://suspilne.media/1", "name": "Суспільне", "domain": "suspilne.media", "trusted": True,
                     "title": "Рада ухвалила бюджет", "snippet": "239 голосів"},
                    {"url": "https://news.google.com/rss/articles/x", "name": "NV", "domain": "nv.ua", "trusted": True,
                     "title": "Бюджет ухвалено"}],
        "factchecks": [],
    }

    def test_parse_json_with_code_fence(self):
        self.assertEqual(ai.parse_json('```json\n{"verdict": "true"}\n```')["verdict"], "true")
        self.assertEqual(ai.parse_json('Ось відповідь: {"verdict": "false"} — готово')["verdict"], "false")
        with self.assertRaises(ai.AIError):
            ai.parse_json("взагалі не json")

    def test_normalize_fixes_bad_values(self):
        out = ai.normalize({"verdict": "Щось дивне", "confidence": "150", "claims": [{"claim": "X", "assessment": "???"}, "сміття"]})
        self.assertEqual(out["verdict"], "unverified")
        self.assertEqual(out["confidence"], 100)
        self.assertEqual(out["claims"][0]["assessment"], "no_data")
        self.assertEqual(len(out["claims"]), 1)

    def test_analyze_reads_other_sites_and_builds_prompt(self):
        fetched = []
        def fake_fetch(url):
            fetched.append(url)
            return "Верховна Рада ухвалила державний бюджет на 2027 рік, за проголосували 239 депутатів. " * 3
        llm = fake_llm({"verdict": "true", "confidence": 90, "summary": "Підтверджено.",
                        "claims": [{"claim": "Бюджет ухвалено", "assessment": "confirmed", "evidence": "Суспільне"}],
                        "manipulation": [], "advice": "Перевірте сайт Ради."})
        out = ai.analyze_news(TITLE, "", "", self.EVIDENCE, llm=llm, fetch=fake_fetch)
        self.assertEqual(fetched, ["https://suspilne.media/1"])  # посилання Google Новин не читаємо
        self.assertEqual(out["verdict_label"], "Правда")
        self.assertEqual(out["pages_read"][0]["url"], "https://suspilne.media/1")
        self.assertIn("ТЕКСТИ СТАТЕЙ З ІНШИХ САЙТІВ", fake_llm.last_prompt)
        self.assertIn("[перевірене ЗМІ] Суспільне", fake_llm.last_prompt)

    def test_timeout_retries_with_short_prompt(self):
        calls = []
        def slow_then_ok(messages):
            calls.append(messages[-1]["content"])
            if len(calls) == 1:
                raise ai.AITimeout("Сервіс ШІ не відповів за 90 с.")
            return json.dumps({"verdict": "true", "confidence": 70, "summary": "ок"})
        out = ai.analyze_news(TITLE, "текст " * 500, "", self.EVIDENCE, llm=slow_then_ok,
                              fetch=lambda u: "Верховна Рада ухвалила державний бюджет. " * 10)
        self.assertEqual(len(calls), 2)
        self.assertIn("ТЕКСТИ СТАТЕЙ", calls[0])
        self.assertNotIn("ТЕКСТИ СТАТЕЙ", calls[1])  # повтор — без текстів статей, коротший
        self.assertEqual(out["pages_read"], [])

    def test_double_timeout_gives_helpful_error(self):
        def always_slow(messages):
            raise ai.AITimeout("Сервіс ШІ не відповів за 90 с.")
        with self.assertRaises(ai.AIError) as ctx:
            ai.analyze_news(TITLE, "", "", {}, llm=always_slow, read_pages=False)
        self.assertIn("gemini-3.5-flash-lite", str(ctx.exception))

    def test_gemini_thinking_disabled(self):
        sent = {}
        def fake_post(url, body, key, timeout):
            sent.update(body)
            return {"choices": [{"message": {"content": "{}"}}]}
        cfg = {"enabled": True, "provider": "gemini", "model": "gemini-2.5-flash", "base_url": "x", "key": "k", "timeout": 90}
        with mock.patch.object(ai, "_post_json", fake_post):
            ai.chat([{"role": "user", "content": "hi"}], cfg)
        self.assertEqual(sent["reasoning_effort"], "none")

    def _cfg(self, **extra):
        cfg = {"enabled": True, "provider": "gemini", "model": "gemini-3.8-flash", "base_url": "x", "key": "k",
               "timeout": 90, "fallback_models": ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"], "retries": 3}
        cfg.update(extra)
        return cfg

    def test_503_retried_then_ok(self):
        calls, pauses = [], []
        def fake_post(url, body, key, timeout):
            calls.append(body["model"])
            if len(calls) < 3:
                raise ai.AIUnavailable("перевантажено", 503)
            return {"choices": [{"message": {"content": "{}"}}]}
        with mock.patch.object(ai, "_post_json", fake_post):
            self.assertEqual(ai.chat([{"role": "user", "content": "hi"}], self._cfg(), sleep=pauses.append), "{}")
        self.assertEqual(calls, ["gemini-3.8-flash"] * 3)
        self.assertEqual(pauses, [2, 4])  # пауза подвоюється

    def test_503_switches_to_fallback_model(self):
        calls = []
        def fake_post(url, body, key, timeout):
            calls.append(body["model"])
            if body["model"] == "gemini-3.8-flash":
                raise ai.AIUnavailable("перевантажено", 503)
            return {"choices": [{"message": {"content": "{}"}}]}
        with mock.patch.object(ai, "_post_json", fake_post):
            ai.chat([{"role": "user", "content": "hi"}], self._cfg(), sleep=lambda s: None)
        self.assertEqual(calls, ["gemini-3.8-flash"] * 3 + ["gemini-3.6-flash"])
        self.assertEqual(ai._last.model, "gemini-3.6-flash")

    def test_503_everywhere_gives_friendly_error(self):
        def fake_post(url, body, key, timeout):
            raise ai.AIUnavailable("перевантажено", 503)
        with mock.patch.object(ai, "_post_json", fake_post), self.assertRaises(ai.AIUnavailable) as ctx:
            ai.chat([{"role": "user", "content": "hi"}], self._cfg(), sleep=lambda s: None)
        self.assertIn("перевантажений", str(ctx.exception))
        self.assertIn("gemini-3.1-flash-lite", str(ctx.exception))

    def test_unavailable_fallback_is_skipped(self):
        calls = []
        def fake_post(url, body, key, timeout):
            calls.append(body["model"])
            if body["model"] == "gemini-3.8-flash":
                raise ai.AIUnavailable("перевантажено", 503)
            if body["model"] == "gemini-3.6-flash":
                raise ai.AIError("Модель або адресу не знайдено (404).")
            return {"choices": [{"message": {"content": "{}"}}]}
        with mock.patch.object(ai, "_post_json", fake_post):
            ai.chat([{"role": "user", "content": "hi"}], self._cfg(), sleep=lambda s: None)
        self.assertEqual(calls, ["gemini-3.8-flash"] * 3 + ["gemini-3.6-flash", "gemini-3.5-flash-lite"])

    def test_gemini3_low_thinking(self):
        sent = {}
        def fake_post(url, body, key, timeout):
            sent.update(body)
            return {"choices": [{"message": {"content": "{}"}}]}
        with mock.patch.object(ai, "_post_json", fake_post):
            ai.chat([{"role": "user", "content": "hi"}], self._cfg())
        self.assertEqual(sent["reasoning_effort"], "low")

    def test_bad_key_is_not_retried(self):
        calls = []
        def fake_post(url, body, key, timeout):
            calls.append(1)
            raise ai.AIError("Ключ ШІ не підходить (помилка 401).")
        with mock.patch.object(ai, "_post_json", fake_post), self.assertRaises(ai.AIError):
            ai.chat([{"role": "user", "content": "hi"}], self._cfg(), sleep=lambda s: None)
        self.assertEqual(len(calls), 1)

    def test_api_ai_overloaded_is_503(self):
        client = TestClient(main.app)
        main._ai_cache.clear()
        with mock.patch.dict(os.environ, {"AI_PROVIDER": "gemini", "AI_API_KEY": "k"}, clear=False), \
                mock.patch.object(ai, "analyze_news", side_effect=ai.AIUnavailable("Сервіс ШІ зараз перевантажений")):
            resp = client.post("/api/ai-check", json={"title": TITLE, "evidence": self.EVIDENCE})
            self.assertEqual(resp.status_code, 503)
            self.assertIn("перевантажений", resp.json()["detail"])

    def test_config_from_env(self):
        with mock.patch.dict(os.environ, {"AI_PROVIDER": "gemini", "AI_API_KEY": ""}, clear=False):
            self.assertFalse(ai.get_config()["enabled"])
        with mock.patch.dict(os.environ, {"AI_PROVIDER": "gemini", "AI_API_KEY": "k", "AI_MODEL": ""}, clear=False):
            cfg = ai.get_config()
            self.assertTrue(cfg["enabled"])
            self.assertEqual(cfg["model"], "gemini-3.8-flash")
            self.assertIn("gemini-3.5-flash-lite", cfg["fallback_models"])
        with mock.patch.dict(os.environ, {"AI_PROVIDER": "ollama", "AI_API_KEY": ""}, clear=False):
            self.assertTrue(ai.get_config()["enabled"])  # локальній моделі ключ не потрібен

    def test_api_reports_disabled_ai(self):
        client = TestClient(main.app)
        with mock.patch.dict(os.environ, {"AI_PROVIDER": ""}, clear=False):
            body = client.post("/api/ai-check", json={"title": TITLE}).json()
            self.assertFalse(body["enabled"])
            self.assertIn(".env", body["reason"])
            self.assertFalse(client.get("/api/health").json()["ai"]["enabled"])

    def test_api_ai_error_is_502(self):
        client = TestClient(main.app)
        main._ai_cache.clear()
        with mock.patch.dict(os.environ, {"AI_PROVIDER": "gemini", "AI_API_KEY": "k"}, clear=False), \
                mock.patch.object(ai, "analyze_news", side_effect=ai.AIError("Ключ ШІ не підходить")):
            resp = client.post("/api/ai-check", json={"title": TITLE, "evidence": self.EVIDENCE})
            self.assertEqual(resp.status_code, 502)
            self.assertIn("Ключ", resp.json()["detail"])


if __name__ == "__main__":
    unittest.main()
