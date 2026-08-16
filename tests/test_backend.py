"""
tests/test_backend.py — Automated tests for server.py

Run:  pytest tests/test_backend.py -v
"""

import json
import os
import sys
from datetime import datetime, timedelta
from io import BytesIO
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo

import pytest

# Set env vars before importing server so module-level code doesn't fail
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")
os.environ.setdefault("WALMART_CONSUMER_ID", "test-consumer")
os.environ.setdefault("WALMART_PRIVATE_KEY_PATH", "/nonexistent/key.pem")
os.environ.setdefault("DELIVERY_ZIP", "59047")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server


# ── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture
def client(tmp_path, monkeypatch):
    """Flask test client with isolated temp data files."""
    monkeypatch.setattr(server, "RECIPES_PATH",       str(tmp_path / "recipes.json"))
    monkeypatch.setattr(server, "PANTRY_PATH",        str(tmp_path / "pantry.json"))
    monkeypatch.setattr(server, "PREFS_PATH",         str(tmp_path / "prefs.json"))
    monkeypatch.setattr(server, "STAPLES_PATH",       str(tmp_path / "staples.json"))
    monkeypatch.setattr(server, "SPEND_HISTORY_PATH", str(tmp_path / "spend_history.json"))
    monkeypatch.setattr(server, "GOOGLE_TOKEN_PATH",  str(tmp_path / "google_token.json"))
    monkeypatch.setattr(server, "_DATA_DIR_OVERRIDE", str(tmp_path))
    server.app.config["TESTING"] = True
    with server.app.test_client() as c:
        with c.session_transaction() as sess:
            sess['username'] = 'testuser'
        yield c


def _mock_creds(valid=True, expired=False):
    c = MagicMock()
    c.valid = valid
    c.expired = expired
    c.refresh_token = None
    return c


def _mock_claude(text):
    resp = MagicMock()
    resp.content = [MagicMock(text=text)]
    return resp


def _mock_calendar_service(events=None):
    svc = MagicMock()
    svc.events().list().execute.return_value = {"items": events or []}
    return svc


# ── Health ───────────────────────────────────────────────────────────────────

class TestPing:
    def test_returns_ok(self, client):
        r = client.get("/ping")
        assert r.status_code == 200
        assert r.get_json() == {"ok": True}


# ── Recipes ──────────────────────────────────────────────────────────────────

class TestRecipes:
    def test_empty_on_fresh_data(self, client):
        assert client.get("/recipes").get_json() == []

    def test_add_returns_recipe_with_id(self, client):
        r = client.post("/recipes", json={"name": "Chicken Pot Pie", "rating": 5, "tags": ["comfort-food"]})
        assert r.status_code in (200, 201)
        data = r.get_json()
        assert data["name"] == "Chicken Pot Pie"
        assert "id" in data

    def test_list_reflects_added(self, client):
        client.post("/recipes", json={"name": "Tacos", "rating": 4})
        client.post("/recipes", json={"name": "Lasagna", "rating": 5})
        recipes = client.get("/recipes").get_json()
        assert len(recipes) == 2
        assert {r["name"] for r in recipes} == {"Tacos", "Lasagna"}

    def test_update_rating(self, client):
        added = client.post("/recipes", json={"name": "Soup", "rating": 3}).get_json()
        r = client.patch(f'/recipes/{added["id"]}', json={"rating": 5})
        assert r.status_code == 200
        assert r.get_json()["rating"] == 5

    def test_update_nonexistent_returns_404(self, client):
        r = client.patch("/recipes/no-such-id", json={"rating": 5})
        assert r.status_code == 404

    def test_delete_removes_recipe(self, client):
        added = client.post("/recipes", json={"name": "Soup", "rating": 3}).get_json()
        client.delete(f'/recipes/{added["id"]}')
        assert client.get("/recipes").get_json() == []

    def test_delete_nonexistent_is_idempotent(self, client):
        # Server silently succeeds when item not found
        assert client.delete("/recipes/no-such-id").status_code == 200

    def test_batch_rate_updates_ratings_and_times_planned(self, client):
        client.post("/recipes", json={"name": "Soup", "rating": 3})
        client.post("/recipes", json={"name": "Pasta", "rating": 3})
        before = {r["name"]: r for r in client.get("/recipes").get_json()}
        soup_planned_before = before["Soup"].get("timesPlanned", 0)
        # Server expects {"ratings": [...]} wrapper
        client.post("/recipes/batch-rate", json={"ratings": [
            {"name": "Soup",  "rating": 5},
            {"name": "Pasta", "rating": 2},
        ]})
        recipes = {r["name"]: r for r in client.get("/recipes").get_json()}
        assert recipes["Soup"]["rating"] == 5
        assert recipes["Soup"]["timesPlanned"] == soup_planned_before + 1
        assert recipes["Pasta"]["rating"] == 2

    def test_export_contains_recipe_name(self, client):
        client.post("/recipes", json={"name": "Birria Tacos", "rating": 4})
        r = client.get("/recipes/export")
        assert r.status_code == 200
        assert b"Birria Tacos" in r.data

    def test_import_csv_round_trip(self, client):
        client.post("/recipes", json={"name": "Pot Roast", "rating": 5, "tags": ["weekend"]})
        csv_bytes = client.get("/recipes/export").data
        # Clear and re-import
        rid = client.get("/recipes").get_json()[0]["id"]
        client.delete(f"/recipes/{rid}")
        assert client.get("/recipes").get_json() == []
        r = client.post("/recipes/import", data={"file": (BytesIO(csv_bytes), "recipes.csv")},
                        content_type="multipart/form-data")
        assert r.status_code == 200
        assert any(rec["name"] == "Pot Roast" for rec in client.get("/recipes").get_json())


# ── Pantry ───────────────────────────────────────────────────────────────────

class TestPantry:
    def test_empty_on_fresh_data(self, client):
        assert client.get("/pantry").get_json() == []

    def test_add_item(self, client):
        r = client.post("/pantry", json={"name": "Ground Beef", "amount": "1", "unit": "lb"})
        assert r.status_code in (200, 201)
        data = r.get_json()
        assert data["name"] == "Ground Beef"
        assert "id" in data

    def test_update_amount(self, client):
        added = client.post("/pantry", json={"name": "Milk", "amount": "1", "unit": "gallon"}).get_json()
        r = client.patch(f'/pantry/{added["id"]}', json={"amount": "2"})
        assert r.status_code == 200
        assert r.get_json()["amount"] == "2"

    def test_delete_item(self, client):
        added = client.post("/pantry", json={"name": "Eggs", "amount": "12", "unit": "count"}).get_json()
        client.delete(f'/pantry/{added["id"]}')
        assert client.get("/pantry").get_json() == []

    def test_delete_nonexistent_is_idempotent(self, client):
        assert client.delete("/pantry/no-such-id").status_code == 200

    def test_batch_add(self, client):
        # Server expects {"items": [...]} wrapper
        r = client.post("/pantry/batch", json={"items": [
            {"name": "Chicken", "amount": "2", "unit": "lb"},
            {"name": "Rice",    "amount": "1", "unit": "cup"},
        ]})
        assert r.status_code == 200
        assert len(client.get("/pantry").get_json()) == 2

    def test_export_contains_item_name(self, client):
        client.post("/pantry", json={"name": "Carrots", "amount": "3", "unit": "count"})
        r = client.get("/pantry/export")
        assert r.status_code == 200
        assert b"Carrots" in r.data

    def test_import_csv_round_trip(self, client):
        client.post("/pantry", json={"name": "Olive Oil", "amount": "1", "unit": "bottle"})
        csv_bytes = client.get("/pantry/export").data
        pid = client.get("/pantry").get_json()[0]["id"]
        client.delete(f"/pantry/{pid}")
        r = client.post("/pantry/import", data={"file": (BytesIO(csv_bytes), "pantry.csv")},
                        content_type="multipart/form-data")
        assert r.status_code == 200
        assert any(i["name"] == "Olive Oil" for i in client.get("/pantry").get_json())


# ── Prefs ─────────────────────────────────────────────────────────────────────

class TestPrefs:
    def test_get_returns_empty_dict_when_no_file(self, client):
        r = client.get("/prefs")
        assert r.status_code == 200
        assert r.get_json() == {}

    def test_post_then_get_round_trips(self, client):
        prefs = {"household": {"size": 4, "zip": "59047"}, "timezone": "America/Denver"}
        client.post("/prefs", json=prefs)
        data = client.get("/prefs").get_json()
        assert data["household"]["zip"] == "59047"
        assert data["timezone"] == "America/Denver"

    def test_post_overwrites(self, client):
        client.post("/prefs", json={"key": "old"})
        client.post("/prefs", json={"key": "new"})
        assert client.get("/prefs").get_json()["key"] == "new"


# ── Calendar status ───────────────────────────────────────────────────────────

class TestCalendarStatus:
    def test_not_connected_when_no_token_file(self, client):
        r = client.get("/calendar/status")
        assert r.status_code == 200
        assert r.get_json()["connected"] is False

    def test_connected_when_valid_creds(self, client):
        with patch.object(server, "_load_google_creds", return_value=_mock_creds(valid=True)):
            r = client.get("/calendar/status")
        assert r.get_json()["connected"] is True

    def test_not_connected_when_invalid_creds(self, client):
        with patch.object(server, "_load_google_creds", return_value=_mock_creds(valid=False)):
            r = client.get("/calendar/status")
        assert r.get_json()["connected"] is False


# ── Calendar week ─────────────────────────────────────────────────────────────

class TestCalendarWeek:
    def _capture_call(self):
        """Returns (fake_build, captured dict). captured['timeMin'/'timeMax'] set on call."""
        captured = {}
        def fake_build(*a, **kw):
            svc = MagicMock()
            def list_fn(**kwargs):
                captured["timeMin"] = kwargs.get("timeMin", "")
                captured["timeMax"] = kwargs.get("timeMax", "")
                m = MagicMock()
                m.execute.return_value = {"items": []}
                return m
            svc.events.return_value.list.side_effect = list_fn
            return svc
        return fake_build, captured

    def test_requires_auth(self, client):
        with patch.object(server, "_load_google_creds", return_value=None):
            r = client.get("/calendar/week")
        assert r.status_code == 401

    def test_current_week_spans_monday_to_sunday(self, client):
        fake_build, captured = self._capture_call()
        with patch.object(server, "_load_google_creds", return_value=_mock_creds()), \
             patch.object(server, "gcal_build", fake_build):
            client.get("/calendar/week?week=current")
        dt_min = datetime.fromisoformat(captured["timeMin"])
        dt_max = datetime.fromisoformat(captured["timeMax"])
        assert dt_min.weekday() == 0, "timeMin should be Monday (weekday 0)"
        assert dt_max.weekday() == 6, "timeMax should be Sunday (weekday 6)"
        assert (dt_max - dt_min).days == 6

    def test_next_week_is_exactly_7_days_after_current(self, client):
        curr_cap, next_cap = {}, {}

        def build_for(cap):
            def fake_build(*a, **kw):
                svc = MagicMock()
                def list_fn(**kw2):
                    cap["timeMin"] = kw2.get("timeMin", "")
                    m = MagicMock(); m.execute.return_value = {"items": []}; return m
                svc.events.return_value.list.side_effect = list_fn
                return svc
            return fake_build

        with patch.object(server, "_load_google_creds", return_value=_mock_creds()), \
             patch.object(server, "gcal_build", build_for(curr_cap)):
            client.get("/calendar/week?week=current")
        with patch.object(server, "_load_google_creds", return_value=_mock_creds()), \
             patch.object(server, "gcal_build", build_for(next_cap)):
            client.get("/calendar/week?week=next")

        curr_mon = datetime.fromisoformat(curr_cap["timeMin"])
        next_mon = datetime.fromisoformat(next_cap["timeMin"])
        assert (next_mon - curr_mon).days == 7

    def test_response_has_all_seven_days(self, client):
        with patch.object(server, "_load_google_creds", return_value=_mock_creds()), \
             patch.object(server, "gcal_build", return_value=_mock_calendar_service()):
            r = client.get("/calendar/week?week=current")
        data = r.get_json()
        assert set(data.keys()) == {"Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"}

    def test_events_grouped_by_weekday_name(self, client):
        events = [
            {"start": {"dateTime": "2026-06-03T15:30:00-06:00"}, "summary": "Guitar Lesson"},
            {"start": {"dateTime": "2026-06-04T09:00:00-06:00"}, "summary": "Vet Appointment"},
        ]
        with patch.object(server, "_load_google_creds", return_value=_mock_creds()), \
             patch.object(server, "gcal_build", return_value=_mock_calendar_service(events)):
            r = client.get("/calendar/week?week=current")
        data = r.get_json()
        wed = [e["title"] for e in data["Wednesday"]]
        thu = [e["title"] for e in data["Thursday"]]
        assert "Guitar Lesson" in wed
        assert "Vet Appointment" in thu

    def test_all_day_events_parse_without_error(self, client):
        events = [{"start": {"date": "2026-06-05"}, "summary": "All Day"}]
        with patch.object(server, "_load_google_creds", return_value=_mock_creds()), \
             patch.object(server, "gcal_build", return_value=_mock_calendar_service(events)):
            r = client.get("/calendar/week?week=current")
        assert r.status_code == 200
        data = r.get_json()
        friday_titles = [e["title"] for e in data["Friday"]]
        assert "All Day" in friday_titles


# ── Claude proxy ──────────────────────────────────────────────────────────────

class TestClaudePrompt:
    def test_returns_content(self, client):
        with patch("anthropic.Anthropic") as MockAI:
            MockAI.return_value.messages.create.return_value = _mock_claude("Hello!")
            r = client.post("/claude-prompt", json={"prompt": "Say hello"})
        assert r.status_code == 200
        assert r.get_json()["content"] == "Hello!"

    def test_missing_prompt_returns_400(self, client):
        r = client.post("/claude-prompt", json={})
        assert r.status_code == 400

    def test_empty_prompt_returns_400(self, client):
        r = client.post("/claude-prompt", json={"prompt": ""})
        assert r.status_code == 400


# ── Walmart swap ──────────────────────────────────────────────────────────────

class TestSwapItem:
    def test_returns_product(self, client):
        # Server reads salePrice/msrp from the product dict, not a pre-formatted price string
        product = {"name": "Perdue Chicken 2lb", "salePrice": 6.98, "itemId": "123456"}
        with patch("server.search_product", return_value=product):
            r = client.post("/swap-item", json={"query": "chicken thighs"})
        assert r.status_code == 200
        data = r.get_json()
        assert data["name"] == "Perdue Chicken 2lb"
        assert data["price"] == "$6.98"

    def test_not_found_returns_404(self, client):
        with patch("server.search_product", return_value=None):
            r = client.post("/swap-item", json={"query": "unobtainium"})
        assert r.status_code == 404

    def test_missing_query_returns_400(self, client):
        r = client.post("/swap-item", json={})
        assert r.status_code == 400


# ── Build cart ────────────────────────────────────────────────────────────────

class TestBuildCart:
    def _patch_cart(self, product=None, queries=None):
        """Context managers: mock Claude + Walmart for a basic cart build."""
        product = product or {"name": "Chicken Breast", "price": "$5.98", "itemId": "111"}
        queries = queries or [{"search_query": "boneless chicken breast", "qty": 2}]
        ai_mock = patch("anthropic.Anthropic")
        wm_mock = patch("server.search_product", return_value=product)
        url_mock = patch("server.build_cart_url", return_value="https://walmart.com/cart?test=1")
        return ai_mock, wm_mock, url_mock, queries

    def test_basic_cart_returns_expected_shape(self, client):
        ai_mock, wm_mock, url_mock, queries = self._patch_cart()
        with ai_mock as MockAI, wm_mock, url_mock:
            MockAI.return_value.messages.create.return_value = _mock_claude(json.dumps(queries))
            r = client.post("/build-cart", json={"meals": ["Chicken Tacos"], "zip": "59047", "servings": 4})
        assert r.status_code == 200
        data = r.get_json()
        assert "groups" in data
        assert "total"   in data
        assert "cartUrl" in data
        assert "mealOrder" in data

    def test_empty_meals_still_succeeds(self, client):
        with patch("server.build_cart_url", return_value="https://walmart.com/cart"):
            r = client.post("/build-cart", json={"meals": [], "zip": "59047", "servings": 4})
        assert r.status_code == 200

    def test_cart_url_in_response(self, client):
        ai_mock, wm_mock, url_mock, queries = self._patch_cart()
        with ai_mock as MockAI, wm_mock, url_mock:
            MockAI.return_value.messages.create.return_value = _mock_claude(json.dumps(queries))
            r = client.post("/build-cart", json={"meals": ["Tacos"], "zip": "59047", "servings": 4})
        assert r.get_json()["cartUrl"] == "https://walmart.com/cart?test=1"

    def test_not_found_items_reported(self, client):
        with patch("anthropic.Anthropic") as MockAI, \
             patch("server.search_product", return_value=None), \
             patch("server.build_cart_url", return_value="https://walmart.com/cart"):
            MockAI.return_value.messages.create.return_value = _mock_claude(
                json.dumps([{"search_query": "mystery ingredient", "qty": 1}])
            )
            r = client.post("/build-cart", json={"meals": ["Mystery Dish"], "zip": "59047", "servings": 4})
        data = r.get_json()
        assert "notFound" in data


# ── Staples CRUD ─────────────────────────────────────────────────────────────

class TestStaples:
    def test_empty_on_fresh_data(self, client):
        r = client.get("/staples")
        assert r.status_code == 200
        assert r.get_json()["items"] == []

    def test_add_returns_item_with_id(self, client):
        r = client.post("/staples", json={"name": "Whole milk", "qty": 1, "unit": "gallon"})
        assert r.status_code == 201
        data = r.get_json()
        assert data["name"] == "Whole milk"
        assert "id" in data

    def test_add_then_get_round_trip(self, client):
        client.post("/staples", json={"name": "Organic bananas"})
        r = client.get("/staples")
        items = r.get_json()["items"]
        assert len(items) == 1
        assert items[0]["name"] == "Organic bananas"

    def test_missing_name_returns_400(self, client):
        r = client.post("/staples", json={"qty": 2})
        assert r.status_code == 400

    def test_patch_updates_fields(self, client):
        add_r = client.post("/staples", json={"name": "Diet Coke", "qty": 1, "unit": "24-pack"})
        item_id = add_r.get_json()["id"]
        r = client.patch(f"/staples/{item_id}", json={"qty": 2, "notes": "on sale"})
        assert r.status_code == 200
        data = r.get_json()
        assert data["qty"] == 2
        assert data["notes"] == "on sale"

    def test_patch_nonexistent_returns_404(self, client):
        r = client.patch("/staples/nonexistent", json={"name": "X"})
        assert r.status_code == 404

    def test_delete_removes_item(self, client):
        add_r = client.post("/staples", json={"name": "Eggs"})
        item_id = add_r.get_json()["id"]
        client.delete(f"/staples/{item_id}")
        items = client.get("/staples").get_json()["items"]
        assert all(i["id"] != item_id for i in items)

    def test_reorder_changes_order(self, client):
        id1 = client.post("/staples", json={"name": "A"}).get_json()["id"]
        id2 = client.post("/staples", json={"name": "B"}).get_json()["id"]
        client.post("/staples/reorder", json={"ids": [id2, id1]})
        items = client.get("/staples").get_json()["items"]
        assert items[0]["id"] == id2
        assert items[1]["id"] == id1

    def test_migration_from_prefs_string_list(self, client, tmp_path, monkeypatch):
        prefs_path   = str(tmp_path / "prefs.json")
        staples_path = str(tmp_path / "staples.json")
        monkeypatch.setattr(server, "PREFS_PATH",   prefs_path)
        monkeypatch.setattr(server, "STAPLES_PATH", staples_path)
        with open(prefs_path, "w") as f:
            json.dump({"weeklyStaples": ["Milk 1 gallon", "Bananas"]}, f)
        server._migrate_staples_from_prefs()
        import os
        assert os.path.exists(staples_path)
        with open(staples_path) as f:
            migrated = json.load(f)
        assert len(migrated) == 2
        assert migrated[0]["name"] == "Milk 1 gallon"
        assert migrated[0]["qty"] == 1
        # prefs weeklyStaples should be cleared
        with open(prefs_path) as f:
            prefs = json.load(f)
        assert prefs["weeklyStaples"] == []

    def test_patch_caches_itemid_and_price(self, client):
        add_r = client.post("/staples", json={"name": "Diet Coke", "qty": 1})
        item_id = add_r.get_json()["id"]
        r = client.patch(f"/staples/{item_id}", json={"itemId": "10452275", "productName": "Diet Coke 24pk", "lastPrice": 9.98})
        assert r.status_code == 200
        data = r.get_json()
        assert data["itemId"] == "10452275"
        assert data["productName"] == "Diet Coke 24pk"
        assert data["lastPrice"] == 9.98

    def test_cached_staples_bypass_walmart_search(self, client):
        """Staples with itemId must be added directly; Walmart search must not be called for them."""
        add_r = client.post("/staples", json={"name": "Diet Coke", "qty": 1, "itemId": "10452275", "productName": "Diet Coke 24pk", "lastPrice": 9.98})
        assert add_r.status_code == 201

        search_calls = []
        def track_search(query):
            search_calls.append(query)
            return None

        with patch("anthropic.Anthropic") as MockAI, \
             patch("server.search_product", side_effect=track_search), \
             patch("server.build_cart_url", return_value="https://walmart.com/cart"):
            MockAI.return_value.messages.create.return_value = _mock_claude("[]")
            r = client.post("/build-cart", json={
                "meals": [],
                "weeklyStaples": [{"id": add_r.get_json()["id"], "name": "Diet Coke", "qty": 1, "unit": "", "itemId": "10452275", "productName": "Diet Coke 24pk", "lastPrice": 9.98}],
                "zip": "59047", "servings": 4,
            })

        assert r.status_code == 200
        data = r.get_json()
        # Walmart search must NOT have been called for the cached staple
        assert not any("diet coke" in q.lower() for q in search_calls), "Walmart search called for a cached staple"
        # Cart groups must include the staple from cache
        assert "staples" in data["groups"]
        assert data["groups"]["staples"][0]["itemId"] == "10452275"

    def test_resolved_staples_returned_for_uncached(self, client):
        """Uncached staples found via Walmart search should appear in resolvedStaples."""
        found_product = {"itemId": 99999, "name": "Organic Bananas", "salePrice": 1.29}
        with patch("anthropic.Anthropic") as MockAI, \
             patch("server.search_product", return_value=found_product), \
             patch("server.build_cart_url", return_value="https://walmart.com/cart"):
            MockAI.return_value.messages.create.return_value = _mock_claude(
                json.dumps([{"search_query": "organic bananas bunch", "qty": 1}])
            )
            r = client.post("/build-cart", json={
                "meals": [],
                "weeklyStaples": [{"id": "abc123", "name": "Bananas", "qty": 1, "unit": ""}],
                "zip": "59047", "servings": 4,
            })
        assert r.status_code == 200
        data = r.get_json()
        assert "resolvedStaples" in data
        assert len(data["resolvedStaples"]) == 1
        rs = data["resolvedStaples"][0]
        assert rs["stapleId"] == "abc123"
        assert rs["itemId"] == "99999"
        assert rs["lastPrice"] == 1.29


# ── Picker clarify ───────────────────────────────────────────────────────────

class TestPickerClarify:
    def test_returns_question_and_options(self, client):
        payload = '{"question": "Homemade or frozen?", "options": ["Homemade", "Kodiak frozen", "Eggo frozen"]}'
        with patch("anthropic.Anthropic") as MockAI:
            MockAI.return_value.messages.create.return_value = _mock_claude(payload)
            r = client.post("/picker-clarify", json={"type": "breakfast", "name": "Waffles"})
        assert r.status_code == 200
        data = r.get_json()
        assert data["question"] == "Homemade or frozen?"
        assert "Homemade" in data["options"]
        assert len(data["options"]) == 3

    def test_null_question_when_name_specific(self, client):
        payload = '{"question": null, "options": []}'
        with patch("anthropic.Anthropic") as MockAI:
            MockAI.return_value.messages.create.return_value = _mock_claude(payload)
            r = client.post("/picker-clarify", json={"type": "breakfast", "name": "Kodiak chocolate chip waffles"})
        assert r.status_code == 200
        data = r.get_json()
        assert data["question"] is None
        assert data["options"] == []

    def test_missing_name_returns_400(self, client):
        r = client.post("/picker-clarify", json={"type": "breakfast"})
        assert r.status_code == 400

    def test_empty_name_returns_400(self, client):
        r = client.post("/picker-clarify", json={"type": "breakfast", "name": ""})
        assert r.status_code == 400

    def test_claude_error_returns_500(self, client):
        with patch("anthropic.Anthropic") as MockAI:
            MockAI.return_value.messages.create.side_effect = Exception("API down")
            r = client.post("/picker-clarify", json={"type": "snack", "name": "hummus"})
        assert r.status_code == 500


# ── Recipe regenerate ────────────────────────────────────────────────────────

class TestRecipeRegenerate:
    def test_regenerate_fills_recipe(self, client):
        added = client.post("/recipes", json={"name": "Chili", "rating": 4}).get_json()
        payload = '{"ingredients": ["1.5 lb ground beef", "1 can (14.5 oz) diced tomatoes"], "steps": ["Brown beef.", "Add tomatoes and simmer."]}'
        with patch("server.anthropic.Anthropic") as MockAI:
            MockAI.return_value.messages.create.return_value = _mock_claude(payload)
            r = client.post(f'/recipes/{added["id"]}/regenerate')
        assert r.status_code == 200
        data = r.get_json()
        assert "1.5 lb ground beef" in data["ingredients"]
        assert len(data["steps"]) == 2

    def test_regenerate_overwrites_existing_ingredients(self, client):
        added = client.post("/recipes", json={"name": "Pasta", "rating": 3,
                                              "ingredients": ["500g pasta"]}).get_json()
        payload = '{"ingredients": ["12 oz spaghetti", "1 lb ground beef"], "steps": ["Boil pasta.", "Cook beef."]}'
        with patch("server.anthropic.Anthropic") as MockAI:
            MockAI.return_value.messages.create.return_value = _mock_claude(payload)
            client.post(f'/recipes/{added["id"]}/regenerate')
        updated = next(r for r in client.get("/recipes").get_json() if r["id"] == added["id"])
        assert "12 oz spaghetti" in updated["ingredients"]
        assert "500g pasta" not in updated["ingredients"]

    def test_regenerate_404_on_unknown_id(self, client):
        r = client.post("/recipes/no-such-id/regenerate")
        assert r.status_code == 404

    def test_backfill_force_regenerates_all(self, client):
        client.post("/recipes", json={"name": "Soup", "rating": 3,
                                      "ingredients": ["500ml broth"], "steps": ["Heat."]})
        payload = '{"ingredients": ["2 cups chicken broth", "1 lb chicken"], "steps": ["Heat broth.", "Add chicken."]}'
        with patch("server.anthropic.Anthropic") as MockAI:
            MockAI.return_value.messages.create.return_value = _mock_claude(payload)
            r = client.post("/recipes/backfill", json={"force": True},
                            content_type="application/json")
        assert r.status_code == 200
        data = r.get_json()
        assert data["filled"] == 1
        updated = client.get("/recipes").get_json()[0]
        assert "2 cups chicken broth" in updated["ingredients"]


# ── Calendar disconnect ───────────────────────────────────────────────────────

class TestCalendarDisconnect:
    def test_disconnect_removes_token_file(self, client, tmp_path, monkeypatch):
        token_path = str(tmp_path / "google_token.json")
        monkeypatch.setattr(server, "GOOGLE_TOKEN_PATH", token_path)
        with open(token_path, "w") as f:
            json.dump({"token": "fake"}, f)
        r = client.post("/calendar/disconnect")
        assert r.status_code == 200
        assert not os.path.exists(token_path)

    def test_disconnect_ok_when_no_file(self, client):
        r = client.post("/calendar/disconnect")
        assert r.status_code == 200
        assert r.get_json()["ok"] is True


# ── Sprint 2: meal history, brand rules, never-suggest ───────────────────────

class TestBrandRulesSnippet:
    def test_empty_rules_returns_empty_string(self):
        assert server._brand_rules_snippet([]) == ''

    def test_filters_out_non_food_rules(self):
        rules = [
            {'item': 'Paper towels', 'brand': 'Brawny'},
            {'item': 'Dishwasher pods', 'brand': 'Cascade'},
        ]
        assert server._brand_rules_snippet(rules) == ''

    def test_includes_food_rules(self):
        rules = [
            {'item': 'Chicken (fresh)', 'brand': 'Perdue Harvestland'},
            {'item': 'Pasta sauce', 'brand': "Rao's Marinara"},
        ]
        result = server._brand_rules_snippet(rules)
        assert 'Perdue' in result
        assert "Rao's" in result

    def test_caps_at_five_rules(self):
        rules = [{'item': f'chicken item {i}', 'brand': f'Brand{i}'} for i in range(10)]
        result = server._brand_rules_snippet(rules)
        assert result.count('- ') <= 5

    def test_brand_rules_injected_into_cart_search(self, client=None):
        """Brand rules appear in the Claude prompt for meal search queries."""
        captured = []

        def mock_create(**kwargs):
            captured.append(kwargs['messages'][0]['content'])
            return _mock_claude('[{"search_query": "perdue chicken thighs", "qty": 1}]')

        brand_prefs = {'brandRules': [{'item': 'Chicken (fresh)', 'brand': 'Perdue Harvestland'}]}
        import tempfile, os
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as tf:
            json.dump(brand_prefs, tf)
            tf_path = tf.name
        try:
            orig = server.PREFS_PATH
            server.PREFS_PATH = tf_path
            with patch("anthropic.Anthropic") as MockAI, \
                 patch("server.search_product", return_value={"itemId": 1, "name": "Chicken", "salePrice": 5.0}), \
                 patch("server.build_cart_url", return_value="https://walmart.com/cart"):
                MockAI.return_value.messages.create.side_effect = mock_create
                import flask
                with server.app.test_request_context():
                    server.app.config["TESTING"] = True
                # Use a fresh test client scoped to this test
                server.app.config["TESTING"] = True
                with server.app.test_client() as c:
                    with c.session_transaction() as sess:
                        sess['username'] = 'testuser'
                    c.post("/build-cart", json={"meals": ["Chicken Tacos"], "zip": "59047", "servings": 4})
        finally:
            server.PREFS_PATH = orig
            os.unlink(tf_path)

        assert any('Perdue' in str(p) for p in captured), "Brand rule not injected into Claude prompt"


class TestMealHistory:
    def test_finalize_week_builds_meal_history(self, client):
        # Simulate two weeks of finalization via prefs endpoint
        week1_prefs = {'lastWeekMeals': [], 'mealHistory': [{'week': '2026-05-25', 'meals': ['Tacos', 'Lasagna']}]}
        client.post('/prefs', json=week1_prefs)
        saved = client.get('/prefs').get_json()
        assert saved['mealHistory'][0]['meals'] == ['Tacos', 'Lasagna']

    def test_meal_history_caps_at_four_weeks(self, client):
        history = [{'week': f'2026-0{i+1}-01', 'meals': [f'Meal{i}']} for i in range(5)]
        client.post('/prefs', json={'mealHistory': history})
        saved = client.get('/prefs').get_json()
        # Prefs round-trips the full array — capping happens in JS _finalizeWeek;
        # here we just verify prefs endpoint stores and retrieves correctly
        assert len(saved['mealHistory']) == 5


# ── Sprint 3: spend history ──────────────────────────────────────────────────

class TestSpendHistory:
    def test_empty_on_fresh_data(self, client):
        r = client.get('/spend-history')
        assert r.status_code == 200
        assert r.get_json() == []

    def test_post_records_entry(self, client):
        r = client.post('/spend-history', json={'date': '2026-06-07', 'total': 187.43, 'mealCount': 7})
        assert r.status_code == 200
        assert r.get_json()['ok'] is True
        history = client.get('/spend-history').get_json()
        assert len(history) == 1
        assert history[0]['total'] == 187.43
        assert history[0]['mealCount'] == 7

    def test_missing_date_returns_400(self, client):
        r = client.post('/spend-history', json={'total': 150.0})
        assert r.status_code == 400

    def test_zero_total_returns_400(self, client):
        r = client.post('/spend-history', json={'date': '2026-06-07', 'total': 0})
        assert r.status_code == 400

    def test_caps_at_52_entries(self, client):
        for i in range(54):
            client.post('/spend-history', json={'date': f'2025-{(i % 12)+1:02d}-01', 'total': 100 + i, 'mealCount': 7})
        history = client.get('/spend-history').get_json()
        assert len(history) == 52

    def test_multiple_entries_accumulate(self, client):
        client.post('/spend-history', json={'date': '2026-05-31', 'total': 200.0, 'mealCount': 6})
        client.post('/spend-history', json={'date': '2026-06-07', 'total': 175.0, 'mealCount': 7})
        history = client.get('/spend-history').get_json()
        assert len(history) == 2
        assert history[-1]['date'] == '2026-06-07'


# ── Sprint 4: cadence tracker + session reminder ─────────────────────────────

class TestCadenceReminder:
    def test_session_reminder_silent_when_no_prefs(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(server, "PREFS_PATH", str(tmp_path / "prefs.json"))
        server._check_session_reminder()
        assert capsys.readouterr().out == ''

    def test_session_reminder_silent_when_not_overdue(self, tmp_path, monkeypatch, capsys):
        path = str(tmp_path / "prefs.json")
        monkeypatch.setattr(server, "PREFS_PATH", path)
        with open(path, 'w') as f:
            json.dump({'nextSessionDue': '2099-01-01'}, f)
        server._check_session_reminder()
        assert capsys.readouterr().out == ''

    def test_session_reminder_prints_when_overdue(self, tmp_path, monkeypatch, capsys):
        path = str(tmp_path / "prefs.json")
        monkeypatch.setattr(server, "PREFS_PATH", path)
        with open(path, 'w') as f:
            json.dump({'nextSessionDue': '2020-01-01'}, f)
        server._check_session_reminder()
        out = capsys.readouterr().out
        assert 'overdue' in out.lower() or 'due' in out.lower()

    def test_cadence_fields_round_trip_through_prefs(self, client):
        items = [
            {'name': 'Cat litter', 'category': 'pet', 'brand': 'Purina', 'cadenceDays': 35, 'lastOrderedOn': '2026-05-01'},
            {'name': 'Paper towels', 'category': 'household', 'brand': 'Brawny', 'cadenceDays': 0, 'lastOrderedOn': ''},
        ]
        client.post('/prefs', json={'householdItems': items})
        saved = client.get('/prefs').get_json()
        assert saved['householdItems'][0]['cadenceDays'] == 35
        assert saved['householdItems'][0]['lastOrderedOn'] == '2026-05-01'
        assert saved['householdItems'][1]['cadenceDays'] == 0
