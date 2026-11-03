"""Collect real supermarket prices from Israel's price-transparency files.

Runs on GitHub Actions (see .github/workflows/update.yml). For every chain
in config.json it:
  1. downloads the chain's official Stores file,
  2. geocodes branches (OpenStreetMap Nominatim, cached in cache/geocache.json),
  3. keeps branches within `radius_km` of the configured area center,
  4. downloads each kept branch's latest PriceFull + PromoFull files,
  5. writes compact JSON into _site/data/ for the web app.

Nothing is invented: every price row comes from a chain's published file and
keeps that file's name and timestamps. Chains/branches that fail are reported
in data/index.json (status + error) instead of being silently dropped. If a
branch fails in this run but succeeded before, the previous file is reused and
marked with its original (older) timestamps.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import httpx
import israeli_prices as ilp
from israeli_prices import FileType
from israeli_prices.chains import get_adapter
from israeli_prices.core.http import HttpClient

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
SITE = ROOT / "_site"
DATA = SITE / "data"
CACHE_FILE = ROOT / "cache" / "geocache.json"
IL_TZ = timezone(timedelta(hours=2))  # display only; source times are naive Israel time

REPO = os.environ.get("GITHUB_REPOSITORY", "local/sal-kniyot")
UA = f"sal-kniyot-price-collector/1.0 (+https://github.com/{REPO})"
PREV_BASE = os.environ.get("PREV_BASE", "").rstrip("/")
ISRAEL_PROXY = os.environ.get("ISRAEL_PROXY") or None

http = httpx.Client(timeout=30, headers={"User-Agent": UA}, follow_redirects=True)
LOG: list[str] = []


def log(msg: str) -> None:
    print(msg, flush=True)
    LOG.append(msg)


# ---------------------------------------------------------------- geo utils
def haversine(lat1, lon1, lat2, lon2) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


class Geocoder:
    """Nominatim with a persistent cache and the 1 request/second policy."""

    def __init__(self, path: Path, budget: int):
        self.path = path
        self.cache = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        self.budget = budget  # max live requests per run (keeps runs short)
        self.calls = 0
        self._last = 0.0
        self.dirty = False

    def lookup(self, query: str):
        key = query.strip()
        if not key:
            return None
        hit = self.cache.get(key)
        if hit is not None:
            if hit.get("lat") is not None:
                return hit
            # cached miss: retry after 21 days
            if time.time() - hit.get("ts", 0) < 21 * 86400:
                return None
        if self.calls >= self.budget:
            return None
        wait = 1.1 - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.time()
        self.calls += 1
        try:
            r = http.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": key, "format": "jsonv2", "limit": 1,
                        "countrycodes": "il", "accept-language": "he"},
            )
            r.raise_for_status()
            res = r.json()
        except Exception as exc:  # network hiccup: don't cache
            log(f"  geocode error for {key!r}: {exc}")
            return None
        if res:
            hit = {"lat": float(res[0]["lat"]), "lon": float(res[0]["lon"]),
                   "type": res[0].get("addresstype") or res[0].get("type"),
                   "ts": int(time.time())}
        else:
            hit = {"lat": None, "ts": int(time.time())}
        self.cache[key] = hit
        self.dirty = True
        return hit if hit.get("lat") is not None else None

    def save(self):
        if self.dirty:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.cache, ensure_ascii=False, indent=0), encoding="utf-8")


def load_city_codes() -> dict[str, str]:
    """CBS settlement code -> Hebrew name (some chains publish codes, not names)."""
    try:
        r = http.get(
            "https://data.gov.il/api/3/action/datastore_search",
            params={"resource_id": "5c78e9fa-c2e2-4771-93ff-7f400a12f7ba", "limit": 5000},
        )
        r.raise_for_status()
        recs = r.json()["result"]["records"]
        out = {}
        for rec in recs:
            code = str(rec.get("סמל_ישוב") or rec.get("סמל ישוב") or "").strip()
            name = str(rec.get("שם_ישוב") or rec.get("שם ישוב") or "").strip()
            if code and name:
                out[code.lstrip("0") or "0"] = name
        log(f"city codes loaded: {len(out)}")
        return out
    except Exception as exc:
        log(f"city codes unavailable: {exc}")
        return {}


def clean(s) -> str:
    s = "" if s is None else str(s)
    s = s.replace("‏", "").replace("‎", "")
    return re.sub(r"\s+", " ", s).strip()


# ----------------------------------------------------------- price helpers
def num(x):
    if x is None:
        return None
    if isinstance(x, Decimal):
        x = float(x)
    try:
        return round(float(x), 3)
    except Exception:
        return None


def fmt_time(t):
    if not t:
        return None
    if isinstance(t, datetime):
        return t.strftime("%Y-%m-%d %H:%M")
    return str(t)


def simple_promos(promo_file) -> dict[str, list]:
    """item_code -> [promo_price, description, end, min_qty, kind].

    kind "unit": single-unit price for all customers (safe to use in totals).
    kind "info": multi-buy / club / other — shown as text only, never summed.
    """
    out: dict[str, list] = {}
    if promo_file is None:
        return out
    now = datetime.now(IL_TZ).replace(tzinfo=None)
    for p in promo_file.promotions:
        try:
            if p.end_time and p.end_time < now:
                continue
            if p.start_time and p.start_time > now + timedelta(hours=1):
                continue
            club = (p.club_id or "0").strip()
            general = club.startswith("0") or club == ""
            desc = clean(p.description)[:60]
            end = fmt_time(p.end_time)
            for it in p.items:
                if it.is_gift_item:
                    continue
                min_qty = num(it.min_qty if it.min_qty is not None else p.min_qty)
                dprice = num(it.discounted_price if it.discounted_price is not None else p.discounted_price)
                kind = "info"
                if general and not p.is_coupon and dprice and dprice > 0 and (min_qty is None or min_qty <= 1):
                    kind = "unit"
                cur = out.get(it.item_code)
                row = [dprice if kind == "unit" else None, desc, end, min_qty, kind]
                # keep the best single-unit promo; otherwise first info promo
                if cur is None or (kind == "unit" and (cur[4] != "unit" or (dprice or 9e9) < (cur[0] or 9e9))):
                    out[it.item_code] = row
        except Exception:
            continue
    return out


def compact_items(price_file, promos) -> list[list]:
    rows = []
    for it in price_file.items:
        price = num(it.price)
        if price is None or price <= 0:
            continue
        pr = promos.get(it.item_code)
        if pr and pr[4] == "unit" and pr[0] is not None and not (0.3 * price <= pr[0] < price):
            pr = [None, pr[1], pr[2], pr[3], "info"]  # implausible -> info only
        rows.append([
            it.item_code,
            clean(it.name),
            clean(it.manufacturer),
            num(it.quantity),
            clean(it.unit_qty),
            clean(it.unit_of_measure),
            1 if it.is_weighted else 0,
            price,
            num(it.unit_price),
            fmt_time(it.price_update_time),
            1 if it.is_barcoded else 0,
            pr,
        ])
    return rows


# ------------------------------------------------------------------- main
def fetch_prev(path: str):
    if not PREV_BASE:
        return None
    try:
        r = http.get(f"{PREV_BASE}/data/{path}")
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return None


def main() -> int:
    center = CFG["center"]
    radius = float(CFG.get("radius_km", 7))
    chains = CFG["chains"]
    started = datetime.now(IL_TZ)

    if SITE.exists():
        shutil.rmtree(SITE)
    shutil.copytree(ROOT / "site", SITE)
    (DATA / "stores").mkdir(parents=True, exist_ok=True)

    geo = Geocoder(CACHE_FILE, budget=int(CFG.get("geocode_budget", 900)))
    city_codes = load_city_codes()
    prev_index = fetch_prev("index.json") or {}
    prev_stores = {s["id"]: s for s in prev_index.get("stores", [])}

    info = {c.slug: c for c in ilp.list_chains()}
    t0 = time.time()
    budget_s = float(CFG.get("time_budget_min", 75)) * 60
    proxy_client = HttpClient(proxy=ISRAEL_PROXY) if ISRAEL_PROXY else None

    chain_report, stores_out = [], []
    for slug in chains:
        ci = info.get(slug)
        name_he = (ci.name_he if ci and ci.name_he else slug)
        rep = {"slug": slug, "name": name_he, "status": "ok", "detail": "",
               "stores_total": 0, "stores_in_area": 0, "stores_with_prices": 0}
        chain_report.append(rep)
        log(f"== {slug} ({name_he})  t={int(time.time()-t0)}s")
        if time.time() - t0 > budget_s:
            rep["status"] = "error"
            rep["detail"] = "דילוג: נגמר זמן הריצה, ייאסף בריצה הבאה"
            for sid, s in prev_stores.items():
                if s["chain"] == slug and reuse_prev(s, stores_out):
                    rep["stores_in_area"] += 1
                    rep["stores_with_prices"] += 1
            continue
        try:
            adapter = get_adapter(slug, client=proxy_client) if proxy_client else get_adapter(slug)
            sref = adapter.latest(FileType.STORES)
            stores = ilp.parse(adapter.download(sref)).stores
        except Exception as exc:
            rep["status"] = "error"
            rep["detail"] = f"{type(exc).__name__}: {str(exc)[:200]}"
            log(f"  stores failed: {rep['detail']}")
            # reuse previous data for this chain, if any
            for sid, s in prev_stores.items():
                if s["chain"] == slug and reuse_prev(s, stores_out):
                    rep["stores_in_area"] += 1
                    rep["stores_with_prices"] += 1
            continue

        rep["stores_total"] = len(stores)
        log(f"  stores file: {len(stores)} branches")
        kept = []
        for st in stores:
            city = clean(st.city)
            if city.isdigit():
                city = city_codes.get(city.lstrip("0") or "0", "")
            addr = clean(st.address)
            sname = clean(st.name)
            # 1) coarse filter by city centroid (cheap; few unique cities)
            if city:
                cg = geo.lookup(f"{city}, ישראל")
                if cg and haversine(center["lat"], center["lon"], cg["lat"], cg["lon"]) > radius + 15:
                    continue
            elif not addr:
                continue
            # 2) precise branch location
            loc, quality = None, None
            if addr and city:
                loc = geo.lookup(f"{addr}, {city}")
                quality = "address"
            if loc is None and addr and not city:
                loc = geo.lookup(f"{addr}, ישראל")
                quality = "address"
            if loc is None and city:
                loc = geo.lookup(f"{city}, ישראל")
                quality = "city"
            if loc is None:
                continue
            dist = haversine(center["lat"], center["lon"], loc["lat"], loc["lon"])
            if dist > radius:
                continue
            rep["stores_in_area"] += 1
            kept.append((st, city, addr, sname, loc, quality, dist))
        geo.save()
        price_refs = promo_refs = {}
        if kept:
            try:
                price_refs = latest_by_store(adapter, FileType.PRICE_FULL)
                promo_refs = latest_by_store(adapter, FileType.PROMO_FULL)
            except Exception as exc:
                log(f"  listing failed: {type(exc).__name__}: {str(exc)[:150]}")
            log(f"  {len(kept)} branches in area; listed {len(price_refs)} price files t={int(time.time()-t0)}s")
        for st, city, addr, sname, loc, quality, dist in kept:
            sid = f"{slug}-{st.store_id}"
            meta = {
                "id": sid, "chain": slug, "chain_he": name_he, "store_id": st.store_id,
                "name": sname, "address": addr, "city": city,
                "lat": round(loc["lat"], 6), "lon": round(loc["lon"], 6),
                "loc_quality": quality, "sub_chain": clean(st.sub_chain_name),
            }
            try:
                key = (st.store_id or "").lstrip("0")
                pref = price_refs.get(key) or adapter.latest(FileType.PRICE_FULL, store_id=st.store_id)
                pfile = ilp.parse(adapter.download(pref))
                promos, promo_ref = {}, None
                try:
                    promo_ref = promo_refs.get(key) or adapter.latest(FileType.PROMO_FULL, store_id=st.store_id)
                    promos = simple_promos(ilp.parse(adapter.download(promo_ref)))
                except Exception as exc:
                    log(f"  promos {sid}: {type(exc).__name__}")
                items = compact_items(pfile, promos)
                if not items:
                    raise RuntimeError("price file empty")
                meta.update({
                    "items_count": len(items),
                    "price_file": pref.name,
                    "price_file_time": fmt_time(pref.published_at),
                    "promo_file": promo_ref.name if promo_ref else None,
                    "promo_file_time": fmt_time(promo_ref.published_at) if promo_ref else None,
                    "fetched_at": datetime.now(IL_TZ).strftime("%Y-%m-%d %H:%M"),
                    "stale": False,
                    "file": f"stores/{sid}.json",
                })
                (DATA / "stores" / f"{sid}.json").write_text(
                    json.dumps({"meta": meta, "items": items}, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")
                stores_out.append(meta)
                rep["stores_with_prices"] += 1
                log(f"  ✓ {sid} {sname} {dist:.1f}km items={len(items)}")
            except Exception as exc:
                log(f"  ✗ {sid} {sname}: {type(exc).__name__}: {str(exc)[:150]}")
                if sid in prev_stores and reuse_prev(prev_stores[sid], stores_out):
                    rep["stores_with_prices"] += 1
                else:
                    meta.update({"items_count": 0, "file": None, "error": f"{type(exc).__name__}"})
                    stores_out.append(meta)
        if rep["stores_in_area"] and not rep["stores_with_prices"]:
            rep["status"] = "partial"
            rep["detail"] = "נמצאו סניפים באזור אך קובצי המחירים לא נטענו"
        geo.save()

    geo.save()
    index = {
        "generated_at": datetime.now(IL_TZ).strftime("%Y-%m-%d %H:%M"),
        "run_started": started.strftime("%Y-%m-%d %H:%M"),
        "area": {"label": center.get("label", ""), "lat": center["lat"], "lon": center["lon"], "radius_km": radius},
        "source": "קובצי שקיפות מחירים רשמיים (חוק קידום התחרות בענף המזון), דרך הספרייה הפתוחה israeli-prices",
        "chains": chain_report,
        "stores": stores_out,
        "geocode_calls": geo.calls,
    }
    (DATA / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    (DATA / "run_log.txt").write_text("\n".join(LOG), encoding="utf-8")
    ok = sum(1 for s in stores_out if s.get("file"))
    log(f"done: {ok} branches with prices, geocode calls {geo.calls}")
    return 0


def latest_by_store(adapter, ftype) -> dict:
    """One pass over a chain's listing: newest file per store id."""
    out = {}
    for ref in adapter.iter_files(file_type=ftype):
        k = (ref.store_id or "").lstrip("0")
        if k and k not in out:
            out[k] = ref
    return out


def reuse_prev(meta: dict, stores_out: list) -> bool:
    """Copy a branch file from the previous deployment, keeping its real timestamps."""
    if not meta.get("file"):
        return False
    data = fetch_prev(meta["file"])
    if not data:
        return False
    m = dict(data["meta"])
    m["stale"] = True
    data["meta"] = m
    (DATA / meta["file"]).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    stores_out.append(m)
    log(f"  ↺ reused previous data for {m['id']} (prices from {m.get('price_file_time')})")
    return True


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(1)
