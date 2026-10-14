# -*- coding: utf-8 -*-
"""KMS 그래프 페이지 빌더.

사용 예:
  python build.py --csv-dir sample --out out --no-check-urls
  python build.py --config config.json --push
  python build.py --config config.json --notify C:/path/message.md
"""
import argparse
import csv
import json
import os
import re
import subprocess
import sys
import traceback
import urllib.parse
import shutil
from datetime import datetime

import requests
import knowledge

HERE = os.path.dirname(os.path.abspath(__file__))
TABS = {"sites": "사이트", "domains": "도메인", "data": "참조데이터"}
SITE_HEADERS = ["ID", "사이트명", "URL", "소개", "도메인", "참조데이터", "작성자", "도구", "프롬프트", "등록일", "승인", "비고"]
# 영문 탭·헤더·속성 이름도 받는다. 내부에서는 한국어 이름으로 통일한다.
EN_TABS = {"sites": "sites", "domains": "domains", "data": "data_sources"}
EN_HEADERS = {
    "sites": {"id": "ID", "name": "사이트명", "url": "URL", "description": "소개", "domain": "도메인", "data_sources": "참조데이터",
              "author": "작성자", "tool": "도구", "prompt": "프롬프트", "date": "등록일", "approved": "승인", "note": "비고"},
    "domains": {"name": "도메인명", "description": "설명", "color": "색상"},
    "data": {"id": "ID", "name": "데이터명", "kind": "종류", "team": "담당팀", "description": "설명"},
}
OPTIONAL_TABS = {"items": "자료", "relations": "관계", "shared_folders": "공용폴더",
                 "shared_projects": "공용프로젝트", "memberships": "공용소속"}
COMMON_HEADERS = {"id": "ID", "approved": "승인", "title": "제목", "description": "설명",
                  "source_id": "출처ID", "source_url": "출처URL", "source_updated_at": "원본수정일",
                  "collected_at": "수집일"}
EN_HEADERS.update({
    "items": dict(COMMON_HEADERS, kind="종류", subtype="세부종류", url="URL", body="본문", prompt="프롬프트",
                  owner="담당자", department="부서", domain="분야", tags="태그", version="버전"),
    "relations": dict(COMMON_HEADERS, source="시작ID", target="대상ID", type="관계유형",
                      label="관계설명", evidence="근거", evidence_url="근거URL"),
    "shared_folders": dict(COMMON_HEADERS), "shared_projects": dict(COMMON_HEADERS, folder_id="폴더ID"),
    "memberships": dict(COMMON_HEADERS, item_id="자료ID", folder_id="폴더ID", project_id="프로젝트ID"),
})
for _legacy_key in ("sites", "data"):
    EN_HEADERS[_legacy_key].update({key: value for key, value in COMMON_HEADERS.items()
                                     if key in {"source_id", "source_url", "source_updated_at", "collected_at"}})


def provenance(row):
    return {field: txt(row, column) for column, field in
            (("출처ID", "sourceId"), ("출처URL", "sourceUrl"), ("원본수정일", "sourceUpdatedAt"), ("수집일", "collectedAt"))
            if txt(row, column)}


def canon(key, header):
    h = str(header).strip()
    return EN_HEADERS[key].get(h.lower().replace(" ", "_"), h)


def canon_rows(key, rows):
    return [{canon(key, h): v for h, v in r.items()} for r in rows]
TRUE_VALUES = {"true", "예", "y", "yes", "o", "1", "✓", "v", "체크"}
PALETTE = ["#4F86C6", "#E2703A", "#5BA87A", "#B06AB3", "#D9A441", "#7A8B99", "#C25A7C"]
SPLIT_RE = re.compile(r"[,;\n]")
HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
NOTION_COLORS = {"blue": "#4F86C6", "green": "#4C9A6A", "red": "#C8553D", "orange": "#E08E45",
                 "yellow": "#D4B13F", "purple": "#7A5CA8", "pink": "#C86B98", "brown": "#8B6A4E",
                 "gray": "#7A8B99", "default": "#7A8B99"}


# ---------- 입력 ----------

def read_csv_dir(csv_dir):
    out = {}
    for key, tab in TABS.items():
        path = os.path.join(csv_dir, tab + ".csv")
        if not os.path.exists(path):
            path = os.path.join(csv_dir, EN_TABS[key] + ".csv")
        if not os.path.exists(path):
            raise SystemExit("CSV 파일이 없습니다: %s (또는 %s.csv)" % (path, tab))
        with open(path, encoding="utf-8-sig", newline="") as f:
            out[key] = canon_rows(key, [dict(r) for r in csv.DictReader(f)])
    for key, tab in OPTIONAL_TABS.items():
        path = os.path.join(csv_dir, tab + ".csv")
        if not os.path.exists(path):
            path = os.path.join(csv_dir, key + ".csv")
        if os.path.exists(path):
            with open(path, encoding="utf-8-sig", newline="") as f:
                out[key] = canon_rows(key, [dict(r) for r in csv.DictReader(f)])
    return out


def read_sheets(cfg):
    from google.oauth2 import service_account
    from google.auth.transport.requests import AuthorizedSession

    key_path = cfg.get("service_account_json", "")
    sheet_id = cfg.get("sheet_id", "")
    if not key_path or not sheet_id:
        raise SystemExit("config.json 에 sheet_id / service_account_json 이 필요합니다.")
    creds = service_account.Credentials.from_service_account_file(
        key_path, scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
    sess = AuthorizedSession(creds)
    out = {}
    for key, tab in {**TABS, **OPTIONAL_TABS}.items():
        r = None
        for name in (tab, EN_TABS.get(key, key)):  # 한국어 탭이 없으면 영문 탭 이름으로
            url = "https://sheets.googleapis.com/v4/spreadsheets/%s/values/%s" % (
                urllib.parse.quote(sheet_id), urllib.parse.quote(name))
            r = sess.get(url, timeout=30)
            if r.status_code == 200:
                break
        if r.status_code != 200:
            if key in OPTIONAL_TABS and r.status_code == 400 and "Unable to parse range" in r.text:
                continue
            raise SystemExit("시트를 읽지 못했습니다 (%s 탭, HTTP %s): %s" % (tab, r.status_code, r.text[:300]))
        values = r.json().get("values", [])
        if not values:
            if key in OPTIONAL_TABS:
                out[key] = []
                continue
            raise SystemExit("시트 %s 탭이 비어 있습니다." % tab)
        header = [canon(key, h) for h in values[0]]
        rows = []
        for raw in values[1:]:
            raw = list(raw) + [""] * (len(header) - len(raw))
            rows.append({header[i]: str(raw[i]) for i in range(len(header))})
        out[key] = rows
    return out


def notion_call(token, method, path, body=None):
    r = requests.request(method, "https://api.notion.com/v1" + path, timeout=30, json=body,
                         headers={"Authorization": "Bearer " + token,
                                  "Notion-Version": "2022-06-28",
                                  "Content-Type": "application/json"})
    if r.status_code != 200:
        raise SystemExit("노션 API 실패 (%s %s, HTTP %s): %s" % (method, path, r.status_code, r.text[:300]))
    return r.json()


def notion_query(token, db_id):
    """데이터베이스 전체 페이지를 커서로 넘겨 가며 읽는다."""
    rows, cursor = [], None
    while True:
        body = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        j = notion_call(token, "POST", "/databases/%s/query" % urllib.parse.quote(db_id), body)
        rows.extend(j.get("results", []))
        if not j.get("has_more"):
            return rows
        cursor = j.get("next_cursor")


def notion_text(prop):
    """속성 하나를 문자열로. 없는 속성은 빈 문자열."""
    t = (prop or {}).get("type")
    if t in ("title", "rich_text"):
        return "".join(x.get("plain_text", "") for x in prop.get(t) or [])
    if t == "url":
        return prop.get("url") or ""
    if t == "select":
        return (prop.get("select") or {}).get("name") or ""
    if t == "multi_select":
        return ", ".join(x.get("name", "") for x in prop.get("multi_select") or [])
    if t == "date":
        return (prop.get("date") or {}).get("start") or ""
    if t == "checkbox":
        return "TRUE" if prop.get("checkbox") else "FALSE"
    return ""


def notion_options(prop):
    """select / multi_select 속성의 선택지 목록."""
    t = (prop or {}).get("type")
    if t not in ("select", "multi_select"):
        return []
    return (prop.get(t) or {}).get("options") or []


def read_notion(cfg):
    token = cfg.get("notion_token", "")
    db_sites = cfg.get("notion_db_sites", "")
    if not token or not db_sites:
        raise SystemExit("config.json 에 notion_token / notion_db_sites 가 필요합니다.")
    schema = notion_call(token, "GET", "/databases/%s" % urllib.parse.quote(db_sites)).get("properties", {})
    schema = {canon("sites", k): v for k, v in schema.items()}
    missing = [k for k in ("사이트명", "URL", "승인") if k not in schema]
    if missing:
        raise SystemExit("노션 사이트 DB 에 다음 속성이 없습니다: %s" % ", ".join(missing))

    sites = []
    for p in notion_query(token, db_sites):
        pr = {canon("sites", k): v for k, v in p.get("properties", {}).items()}
        row = {h: notion_text(pr.get(h)) for h in SITE_HEADERS}
        row.update({"출처ID": p.get("id", ""), "출처URL": p.get("url", ""),
                    "원본수정일": p.get("last_edited_time", "")})
        sites.append(row)
    domains = [{"도메인명": o.get("name", ""), "설명": "",
                "색상": NOTION_COLORS.get(o.get("color", "default"), NOTION_COLORS["default"])}
               for o in notion_options(schema.get("도메인"))]
    datas = [{"데이터명": o.get("name", ""), "종류": "", "담당팀": "", "설명": ""}
             for o in notion_options(schema.get("참조데이터"))]

    if cfg.get("notion_db_data"):
        detail = {}
        for p in notion_query(token, cfg["notion_db_data"]):
            pr = {canon("data", k): v for k, v in p.get("properties", {}).items()}
            nm = notion_text(pr.get("데이터명"))
            if nm:
                detail[nm] = {"데이터명": nm, "종류": notion_text(pr.get("종류")),
                              "담당팀": notion_text(pr.get("담당팀")), "설명": notion_text(pr.get("설명")),
                              "ID": notion_text(pr.get("ID")), "출처ID": p.get("id", ""),
                              "출처URL": p.get("url", ""), "원본수정일": p.get("last_edited_time", "")}
        seen = {d["데이터명"] for d in datas}
        for d in datas:
            d.update(detail.get(d["데이터명"], {}))
        datas += [v for k, v in detail.items() if k not in seen]
    out = {"sites": sites, "domains": domains, "data": datas}
    for key in OPTIONAL_TABS:
        db_id = cfg.get("notion_db_" + key)
        if not db_id:
            continue
        out[key] = []
        for page in notion_query(token, db_id):
            row = {canon(key, k): notion_text(v) for k, v in page.get("properties", {}).items()}
            row["출처ID"] = row.get("출처ID") or page.get("id", "")
            row["출처URL"] = row.get("출처URL") or page.get("url", "")
            row["원본수정일"] = row.get("원본수정일") or page.get("last_edited_time", "")
            out[key].append(row)
    return out


def read_source(args, cfg):
    if args.csv_dir:
        return read_csv_dir(args.csv_dir)
    src = getattr(args, "source", None) or cfg.get("source") or "sheets"
    if src == "notion":
        return read_notion(cfg)
    if src == "sheets":
        return read_sheets(cfg)
    raise SystemExit("source 는 sheets 또는 notion 이어야 합니다. 지금 값: %s" % src)


# ---------- 정리 / 검증 ----------

def txt(row, key):
    return str(row.get(key) or "").strip()


def split_names(cell):
    return list(dict.fromkeys(p.strip() for p in SPLIT_RE.split(cell or "") if p.strip()))


def is_approved(value):
    return str(value or "").strip().lower() in TRUE_VALUES


def build_domains(rows):
    out, seen = [], set()
    for i, r in enumerate(rows):
        name = txt(r, "도메인명")
        if not name or name in seen:
            continue
        seen.add(name)
        color = txt(r, "색상")
        if not HEX_RE.match(color):
            color = PALETTE[len(out) % len(PALETTE)]
        out.append({"name": name, "desc": txt(r, "설명"), "color": color})
    return out


def build_data(rows):
    out, seen = [], set()
    for r in rows:
        name = txt(r, "데이터명")
        if not name or name in seen:
            continue
        seen.add(name)
        out.append({"id": txt(r, "ID"), "name": name, "kind": txt(r, "종류"), "team": txt(r, "담당팀"),
                    "desc": txt(r, "설명"), **provenance(r)})
    return out


# ---------- 매핑 (mappings.json) ----------

def load_mappings(path):
    if not path or not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        m = json.load(f)
    if not isinstance(m, dict):
        raise SystemExit("mappings.json 최상위는 객체여야 합니다: %s" % path)
    return m


def apply_mappings(rows, domains, datas, mappings):
    """검증 전에 매핑을 적용한다. 값 치환 + new 마스터 추가 + 빈 도메인 채우기.
    실제로 쓰인 claude 분류 목록을 돌려준다."""
    used, seen_used = [], set()

    def note(kind, raw, target, m):
        if m.get("by") != "claude" or (kind, raw) in seen_used:
            return
        seen_used.add((kind, raw))
        used.append({"종류": kind, "원본": raw, "결과": target,
                     "why": m.get("why", ""), "date": m.get("date", "")})

    def prep(kind, master, name_key, make):
        """{원본값: (대상이름, 매핑)} 을 만들고 new 항목은 마스터에 붙인다."""
        table, names = {}, {d["name"] for d in master}
        for raw, m in (mappings.get(kind) or {}).items():
            if not isinstance(m, dict):
                continue
            target = txt(m, "to")
            if not target and isinstance(m.get("new"), dict):
                target = txt(m["new"], name_key)
                if target and target not in names:
                    names.add(target)
                    entry = make(m["new"])
                    entry["source"] = "claude" if m.get("by") == "claude" else "mapping"
                    master.append(entry)
            if target:
                table[raw] = (target, m)
        return table

    def new_domain(n):
        color = txt(n, "색상")
        return {"name": txt(n, "도메인명"), "desc": txt(n, "설명"),
                "color": color if HEX_RE.match(color) else PALETTE[len(domains) % len(PALETTE)]}

    dom_map = prep("도메인", domains, "도메인명", new_domain)
    data_map = prep("참조데이터", datas, "데이터명",
                    lambda n: {"name": txt(n, "데이터명"), "kind": txt(n, "종류"),
                               "team": txt(n, "담당팀"), "desc": txt(n, "설명")})
    site_dom = mappings.get("사이트도메인") or {}

    for r in rows:
        name = txt(r, "사이트명")
        dom = txt(r, "도메인")
        if not dom and isinstance(site_dom.get(name), dict):
            m = site_dom[name]
            target = txt(m, "to")
            if target:
                r["도메인"] = dom = target
                note("사이트도메인", name, target, m)
        if dom in dom_map:
            target, m = dom_map[dom]
            r["도메인"] = target
            note("도메인", dom, target, m)
        refs = split_names(txt(r, "참조데이터"))
        if any(x in data_map for x in refs):
            out = []
            for x in refs:
                if x in data_map:
                    target, m = data_map[x]
                    note("참조데이터", x, target, m)
                    out.append(target)
                else:
                    out.append(x)
            r["참조데이터"] = ", ".join(dict.fromkeys(out))
    return used


def build_unmatched(unclassified, domains, datas):
    """매핑이 아직 없는 값들을 Claude 가 읽을 형태로 모은다."""
    buckets = {"도메인": {}, "참조데이터": {}}
    blank_domain = []
    for u in unclassified:
        for it in u["items"]:
            if it["kind"] == "사이트도메인":
                blank_domain.append({"사이트명": u["사이트명"], "소개": u["소개"]})
                continue
            b = buckets[it["kind"]].setdefault(
                it["value"], {"value": it["value"], "sites": [], "desc_samples": []})
            if u["사이트명"] not in b["sites"]:
                b["sites"].append(u["사이트명"])
            if u["소개"] and len(b["desc_samples"]) < 3:
                b["desc_samples"].append(u["소개"])
    key = lambda x: x["value"]  # noqa: E731
    return {
        "도메인": sorted(buckets["도메인"].values(), key=key),
        "참조데이터": sorted(buckets["참조데이터"].values(), key=key),
        "사이트도메인": blank_domain,
        "masters": {
            "도메인": [{"도메인명": d["name"], "설명": d["desc"]} for d in domains],
            "참조데이터": [{"데이터명": d["name"], "종류": d["kind"],
                       "담당팀": d["team"], "설명": d["desc"]} for d in datas],
        },
    }


def has_unmatched(u):
    return bool(u["도메인"] or u["참조데이터"] or u["사이트도메인"])


def build_sites(rows, domains, datas):
    """승인·검증 통과 사이트, 승인 대기, 오류, 분류 대기 목록을 돌려준다."""
    dom_names = {d["name"] for d in domains}
    data_names = {d["name"] for d in datas}
    sites, pending, errors, unclassified = [], [], [], []
    seen_name, seen_url = {}, {}
    for idx, r in enumerate(rows):
        rownum = idx + 2  # 1행은 헤더
        name = txt(r, "사이트명")
        if not name and not txt(r, "URL"):
            continue  # 빈 줄
        if not is_approved(r.get("승인")):
            pending.append({"row": rownum, "사이트명": name or "(이름 없음)", "작성자": txt(r, "작성자")})
            continue
        url = txt(r, "URL")
        domain = txt(r, "도메인")
        refs = split_names(txt(r, "참조데이터"))
        reasons = []
        if not name:
            reasons.append("사이트명이 비어 있음")
        if not url:
            reasons.append("URL이 비어 있음")
        elif not (url.startswith("http://") or url.startswith("https://")):
            reasons.append("URL이 http:// 또는 https:// 로 시작하지 않음")
        if name and name in seen_name:
            reasons.append("사이트명 중복 (%d행과 같음)" % seen_name[name])
        if url and url in seen_url:
            reasons.append("URL 중복 (%d행과 같음)" % seen_url[url])
        if reasons:
            errors.append({"row": rownum, "사이트명": name or "(이름 없음)", "reason": " / ".join(reasons)})
            continue

        # 마스터에 없는 값은 오류가 아니라 분류 대기 — mappings.json 이 채워지면 통과한다.
        waits = []
        if not domain:
            waits.append({"kind": "사이트도메인", "value": name})
        elif domain not in dom_names:
            waits.append({"kind": "도메인", "value": domain})
        for ref in refs:
            if ref not in data_names:
                waits.append({"kind": "참조데이터", "value": ref})
        if waits:
            unclassified.append({"row": rownum, "사이트명": name, "소개": txt(r, "소개"),
                                 "items": waits,
                                 "reason": "분류 대기: " + ", ".join(w["value"] for w in waits)})
            continue

        seen_name[name] = rownum
        seen_url[url] = rownum
        sites.append({
            "row": rownum, "id": txt(r, "ID"), "name": name, "url": url, "desc": txt(r, "소개"),
            "domain": domain, "data": refs, "author": txt(r, "작성자"),
            "tool": txt(r, "도구"), "prompt": txt(r, "프롬프트"),
            "date": txt(r, "등록일"), "note": txt(r, "비고"), "status": "skipped",
            **provenance(r),
        })
    return sites, pending, errors, unclassified


# ---------- 접속 확인 ----------

def check_urls(sites):
    for s in sites:
        try:
            r = requests.get(s["url"], timeout=5, allow_redirects=True)
            s["status"] = "ok" if r.status_code < 400 else "error:%d" % r.status_code
        except Exception as e:
            s["status"] = "error:%s" % type(e).__name__


# ---------- 스냅샷 비교 ----------

COMPARE = ["id", "url", "desc", "domain", "author", "tool", "date"]


def snap_of(sites):
    out = {}
    for s in sites:
        d = {k: s[k] for k in COMPARE}
        d["data"] = sorted(s["data"])
        out[s["name"]] = d
    return out


def diff(new, old):
    added = sorted(set(new) - set(old))
    removed = sorted(set(old) - set(new))
    changed = []
    for name in sorted(set(new) & set(old)):
        fields = [k for k in list(COMPARE) + ["data"] if new[name].get(k) != old[name].get(k)]
        if fields:
            changed.append({"사이트명": name, "fields": fields})
    return added, changed, removed


# ---------- v2 변환 / 출력 ----------

def legacy_payload(sites, datas, cfg, generated_at):
    """Approved legacy sites become tools; only their referenced master data becomes documents."""
    items, relations, data_by_name = [], [], {d["name"]: d for d in datas}
    used_data = {name for s in sites for name in s["data"]}
    for d in datas:
        if d["name"] not in used_data:
            continue
        item_id = d.get("id") or knowledge.stable_id("document", d["name"])
        data_by_name[d["name"]]["_item_id"] = item_id
        items.append({"id": item_id, "title": d["name"], "kind": "document", "subtype": d["kind"],
                      "description": d["desc"], "owner": d["team"], "department": d["team"],
                      "domain": "", "tags": [], **{key: d[key] for key in
                      ("sourceId", "sourceUrl", "sourceUpdatedAt", "collectedAt") if key in d}})
    for site in sites:
        # URL-derived legacy identity is stable until an explicit ID is supplied; renaming is a migration boundary.
        item_id = site.get("id") or knowledge.stable_id("tool", knowledge.normalized_url(site["url"]))
        items.append({"id": item_id, "title": site["name"], "kind": "tool", "subtype": site["tool"],
                      "description": site["desc"], "owner": site["author"], "department": "",
                      "domain": site["domain"], "tags": [], "url": site["url"], "updatedAt": site["date"],
                      "status": "published", "health": "ok" if site.get("status") == "ok" else
                      ("auth_required" if site.get("status") in {"error:401", "error:403"} else
                       "unreachable" if site.get("status", "").startswith("error:") else "unchecked"),
                      **{key: site[key] for key in ("sourceId", "sourceUrl", "sourceUpdatedAt", "collectedAt") if key in site}})
        for data_name in site["data"]:
            target = data_by_name[data_name]["_item_id"]
            relations.append({"id": knowledge.stable_id("relation", item_id + "|" + target + "|references"),
                              "source": item_id, "target": target, "type": "references", "label": "참조"})
    return knowledge.validate_payload({"schemaVersion": 2, "title": cfg.get("site_title", "KMS"),
                                       "generatedAt": generated_at, "items": items, "relations": relations})


def imported_payload(base, raw, collected_at):
    """Explicit inputs are fail-closed and may reference only already published IDs."""
    payload = dict(base)
    payload["items"] = [dict(item) for item in base["items"]]
    payload["relations"] = list(base["relations"])
    kinds = {"문서": "document", "도구": "tool", "AI자산": "ai_asset"}
    for row in raw.get("items", []):
        if not is_approved(row.get("승인")):
            continue
        source_id = txt(row, "출처ID")
        item_id = txt(row, "ID") or (knowledge.stable_id("source", source_id) if source_id else "")
        if not item_id:
            raise ValueError("승인 자료에는 ID 또는 출처ID가 필요합니다")
        kind = kinds.get(txt(row, "종류"), txt(row, "종류"))
        if kind not in knowledge.KINDS:
            raise ValueError("명시 입력 종류는 document/tool/ai_asset이어야 합니다")
        item = {"id": item_id, "title": txt(row, "제목"), "kind": kind,
                "subtype": txt(row, "세부종류"), "description": txt(row, "설명"),
                "owner": txt(row, "담당자"), "department": txt(row, "부서"),
                "domain": txt(row, "분야"), "tags": split_names(txt(row, "태그")),
                "status": "published", "health": "unchecked", "collectedAt": txt(row, "수집일") or collected_at}
        for column, field in (("URL", "url"), ("본문", "body"), ("버전", "version"), ("프롬프트", "prompt"),
                              ("출처ID", "sourceId"), ("출처URL", "sourceUrl"), ("원본수정일", "sourceUpdatedAt")):
            if txt(row, column):
                item[field] = txt(row, column)
        payload["items"].append(item)
    for row in raw.get("relations", []):
        if not is_approved(row.get("승인")):
            continue
        relation = {field: txt(row, column) for column, field in
                    (("ID", "id"), ("시작ID", "source"), ("대상ID", "target"), ("관계유형", "type"),
                     ("관계설명", "label"), ("근거", "evidence"), ("근거URL", "evidenceUrl"))}
        if not relation["id"]:
            raise ValueError("승인 관계에는 ID가 필요합니다")
        payload["relations"].append(relation)
    for tab, key in (("shared_folders", "sharedFolders"), ("shared_projects", "sharedProjects")):
        groups = []
        for row in raw.get(tab, []):
            if not is_approved(row.get("승인")):
                continue
            group = {"id": txt(row, "ID"), "title": txt(row, "제목"), "description": txt(row, "설명")}
            if tab == "shared_projects" and txt(row, "폴더ID"):
                group["folderId"] = txt(row, "폴더ID")
            groups.append(group)
        if groups:
            payload[key] = list(payload.get(key, [])) + groups
    by_id = {item["id"]: item for item in payload["items"]}
    for row in raw.get("memberships", []):
        if not is_approved(row.get("승인")):
            continue
        item_id = txt(row, "자료ID")
        if item_id not in by_id:
            raise ValueError("공용 소속의 자료ID가 게시 자료에 없습니다: " + item_id)
        values = [("폴더ID", "folderIds"), ("프로젝트ID", "projectIds")]
        if not any(txt(row, column) for column, _ in values):
            raise ValueError("공용 소속에는 폴더ID 또는 프로젝트ID가 필요합니다")
        for column, field in values:
            if txt(row, column):
                by_id[item_id].setdefault(field, []).append(txt(row, column))
    return knowledge.validate_payload(payload)


def review_candidates(payload, previous):
    """Only explicit dependency edges propagate changes from a reliable prior snapshot."""
    if not previous:
        return []
    old = {item["id"]: item for item in previous.get("items", [])}
    def comparable(item):
        return {key: value for key, value in item.items() if key not in {"collectedAt", "health"}}
    changed = {item["id"] for item in payload["items"] if item["id"] in old
               and comparable(item) != comparable(old[item["id"]])}
    changed |= set(old) - {item["id"] for item in payload["items"]}
    dependencies = {}
    published_ids = {item["id"] for item in payload["items"]}
    for relation in payload["relations"] + previous.get("relations", []):
        if relation["type"] in {"references", "based_on"}:
            if relation["source"] in published_ids:
                dependencies.setdefault(relation["target"], set()).add(relation["source"])
    candidates = {}
    for origin in sorted(changed):
        seen, queue = {origin}, [origin]
        while queue:
            for dependent in sorted(dependencies.get(queue.pop(0), [])):
                if dependent in seen:
                    continue
                seen.add(dependent); queue.append(dependent)
                candidates.setdefault(dependent, set()).add(origin)
    result = []
    for item_id, origins in sorted(candidates.items()):
        candidate = {"itemId": item_id, "changedSourceIds": sorted(origins & published_ids),
                     "reason": "지난 게시 대비 의존 자료 변경으로 재검토 필요"}
        removed_count = len(origins - published_ids)
        if removed_count:
            candidate["removedSourceCount"] = removed_count
        result.append(candidate)
    return result


def state_directory(out_dir, cfg):
    configured = cfg.get("state_dir")
    if configured:
        return os.path.abspath(configured)
    parent, name = os.path.dirname(out_dir), os.path.basename(out_dir.rstrip(os.sep))
    return os.path.join(parent, ".%s-state" % name)


def _real(path):
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def _inside(parent, child):
    try:
        return os.path.commonpath([_real(parent), _real(child)]) == _real(parent)
    except ValueError:
        return False


def validate_publish_paths(out_dir, cfg, repo_dir=None):
    """Reject public-root output and any state directory in public output before reads/writes."""
    out_dir = _real(out_dir)
    if repo_dir:
        repo_dir = _real(repo_dir)
        if out_dir == repo_dir or not _inside(repo_dir, out_dir):
            raise SystemExit("게시 출력은 repo_dir 아래의 별도 하위 디렉터리여야 합니다.")
    state_dir = _real(state_directory(out_dir, cfg))
    if _inside(out_dir, state_dir):
        raise SystemExit("state_dir 는 게시 출력 폴더 또는 그 하위에 둘 수 없습니다.")
    return out_dir, state_dir


def atomic_json(path, value):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def validate_public_contents(out_dir):
    """Fail closed before input/network work; never remove a file we do not own."""
    is_link = lambda path: os.path.islink(path) or getattr(os.path, "isjunction", lambda _p: False)(path)
    if not os.path.isdir(out_dir):
        return
    unknown = [name for name in os.listdir(out_dir) if name not in {"index.html", "assets", ".nojekyll"}]
    if unknown:
        raise SystemExit("게시 폴더에 허용되지 않은 파일이 있습니다 (%s). 새 빈 출력 경로를 사용하거나 먼저 안전하게 이동하세요."
                         % ", ".join(sorted(unknown)))
    for name in ("index.html", ".nojekyll"):
        path = os.path.join(out_dir, name)
        if os.path.lexists(path) and (is_link(path) or os.path.isdir(path)):
            raise SystemExit("게시 파일은 링크 또는 디렉터리일 수 없습니다: %s" % name)
    assets = os.path.join(out_dir, "assets")
    if os.path.lexists(assets) and is_link(assets):
        raise SystemExit("assets는 링크일 수 없습니다.")
    if os.path.lexists(assets) and not os.path.isdir(assets):
        raise SystemExit("assets는 디렉터리여야 합니다.")
    if os.path.isdir(assets):
        for root, dirs, files in os.walk(assets):
            for name in dirs:
                if is_link(os.path.join(root, name)):
                    raise SystemExit("assets에 링크가 허용되지 않습니다: %s" % os.path.relpath(os.path.join(root, name), out_dir))
            for name in files:
                path = os.path.join(root, name)
                if is_link(path):
                    raise SystemExit("assets에 링크가 허용되지 않습니다: %s" % os.path.relpath(path, out_dir))
                if not name.lower().endswith((".js", ".mjs", ".css", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".woff", ".woff2", ".ttf", ".otf", ".ico")):
                    raise SystemExit("assets에 허용되지 않은 파일이 있습니다: %s" % os.path.relpath(path, out_dir))


def public_template():
    dist = os.path.join(HERE, "frontend", "dist", "index.html")
    return dist if os.path.exists(dist) else os.path.join(HERE, "template.html")


def copy_assets(template_path, out_dir):
    source = os.path.join(os.path.dirname(template_path), "assets")
    if os.path.isdir(source):
        shutil.copytree(source, os.path.join(out_dir, "assets"), dirs_exist_ok=True)


def render(out_dir, payload):
    template_path = public_template()
    with open(template_path, encoding="utf-8") as f:
        html = f.read()
    blob = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    if "/*__KMS_DATA__*/" not in html:
        raise SystemExit("template.html 에 /*__KMS_DATA__*/ 자리표시자가 없습니다.")
    html = html.replace("/*__KMS_DATA__*/", blob)
    path = os.path.join(out_dir, "index.html")
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        f.write(html)
    os.replace(path + ".tmp", path)
    copy_assets(template_path, out_dir)
    return path


def git_push(repo_dir, out_dir):
    def run(*args):
        return subprocess.run(args, cwd=repo_dir, capture_output=True, text=True, encoding="utf-8", errors="replace")

    rel = os.path.relpath(out_dir, repo_dir)
    allowed = [os.path.join(rel, name) for name in ("index.html", "assets", ".nojekyll")
               if os.path.exists(os.path.join(out_dir, name))]
    if not allowed:
        print("게시 산출물이 없습니다: %s" % out_dir)
        return False
    r = run("git", "add", "--", *allowed)
    if r.returncode != 0:
        print("git add 실패: %s" % r.stderr.strip())
        return False
    msg = "kms: %s" % datetime.now().strftime("%Y-%m-%d")
    r = run("git", "commit", "--only", "-m", msg, "--", *allowed)
    if r.returncode != 0:
        combined = (r.stdout + r.stderr).lower()
        if "nothing to commit" in combined or "no changes" in combined:
            print("게시 산출물에 커밋할 변경이 없습니다.")
            return True
        print("git commit 실패: %s" % r.stderr.strip())
        return False
    r = run("git", "push")
    if r.returncode != 0:
        print("git push 실패: %s" % r.stderr.strip())
        return False
    print("푸시 완료: %s" % msg)
    return True


def notify(cfg, md_path):
    hook = cfg.get("teams_webhook", "")
    if not hook:
        raise SystemExit("config.json 에 teams_webhook 이 없습니다.")
    with open(md_path, encoding="utf-8") as f:
        text = f.read()
    payload = {"type": "message", "attachments": [{
        "contentType": "application/vnd.microsoft.card.adaptive",
        "content": {"type": "AdaptiveCard", "version": "1.4",
                    "body": [{"type": "TextBlock", "text": text, "wrap": True}]}}]}
    r = requests.post(hook, json=payload, timeout=15)
    print("Teams 전송 HTTP %s %s" % (r.status_code, r.text[:200]))
    if r.status_code >= 400:
        raise SystemExit("Teams 전송 실패")


# ---------- 메인 ----------

def mappings_path(cfg):
    p = cfg.get("mappings_file") or "mappings.json"
    return p if os.path.isabs(p) else os.path.join(HERE, p)


def build(args, cfg, out_dir):
    # Validate before source reading or URL checks: no unsafe path gets a side effect.
    out_dir, state_dir = validate_publish_paths(out_dir, cfg)
    validate_public_contents(out_dir)
    raw = read_source(args, cfg)
    domains = build_domains(raw["domains"])
    datas = build_data(raw["data"])
    claude_classified = apply_mappings(raw["sites"], domains, datas, load_mappings(mappings_path(cfg)))
    sites, pending, errors, unclassified = build_sites(raw["sites"], domains, datas)

    do_check = cfg.get("check_urls", True) if args.check_urls is None else args.check_urls
    if do_check:
        check_urls(sites)

    os.makedirs(out_dir, exist_ok=True)
    snap_path = os.path.join(state_dir, "snapshot.json")
    old = {}
    if os.path.exists(snap_path):
        try:
            with open(snap_path, encoding="utf-8") as f:
                old = json.load(f)
        except Exception as e:
            print("이전 스냅샷을 읽지 못해 전체를 신규로 처리합니다: %s" % e)
    new = snap_of(sites)
    added, changed, removed = diff(new, old)

    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M")
    payload = legacy_payload(sites, datas, cfg, generated_at)
    knowledge_file = getattr(args, "knowledge", None) or cfg.get("knowledge_file")
    if knowledge_file:
        payload = knowledge.merge_payloads(payload, knowledge.load_knowledge(knowledge_file))
    payload = imported_payload(payload, raw, generated_at)
    for item in payload["items"]:
        item.setdefault("collectedAt", generated_at)
    if do_check:
        for item in payload["items"]:
            if item.get("url") and item.get("health", "unchecked") == "unchecked":
                probe = {"url": item["url"]}
                check_urls([probe])
                item["health"] = ("ok" if probe["status"] == "ok" else "auth_required"
                                  if probe["status"] in {"error:401", "error:403"} else "unreachable")
    payload_snapshot = os.path.join(state_dir, "knowledge-snapshot.json")
    previous_payload = None
    if os.path.exists(payload_snapshot):
        try:
            previous_payload = knowledge.load_knowledge(payload_snapshot)
        except (ValueError, OSError, json.JSONDecodeError):
            print("이전 지식 스냅샷을 검증하지 못해 재검토 후보 계산을 생략합니다.")
    candidates = review_candidates(payload, previous_payload)
    if candidates:
        payload["reviewCandidates"] = candidates
    page = render(out_dir, payload)
    atomic_json(snap_path, new)
    atomic_json(payload_snapshot, payload)

    unmatched = build_unmatched(unclassified, domains, datas)
    atomic_json(os.path.join(state_dir, "unmatched.json"), unmatched)

    report = {
        "generated_at": generated_at,
        "counts": {"sites": len(sites), "data": len(datas), "domains": len(domains)},
        "counts_scope": "source master counts; public payload only includes referenced approved documents",
        "public_counts": {"items": len(payload["items"]), "relations": len(payload["relations"])},
        "added": added, "changed": changed, "removed": removed,
        "pending_approval": pending, "errors": errors,
        "pending_mapping": {"count": len(unclassified), "items": unclassified},
        "claude_classified": claude_classified,
        "unreachable": [{"사이트명": s["name"], "url": s["url"], "status": s["status"]}
                        for s in sites if s["status"].startswith("error")],
        "page_url": cfg.get("page_url", ""),
    }
    atomic_json(os.path.join(state_dir, "report.json"), report)

    print("생성: %s" % page)
    print("사이트 %d개 / 참조데이터 %d개 / 도메인 %d개" % (len(sites), len(datas), len(domains)))
    print("신규 %d, 변경 %d, 삭제 %d, 승인대기 %d, 오류 %d, 분류대기 %d, 접속불가 %d"
          % (len(added), len(changed), len(removed), len(pending), len(errors),
             len(unclassified), len(report["unreachable"])))
    for e in errors:
        print("  [오류] %s행 %s: %s" % (e["row"], e["사이트명"], e["reason"]))
    for u in unclassified:
        print("  [분류대기] %s행 %s: %s" % (u["row"], u["사이트명"], u["reason"]))
    for c in claude_classified:
        print("  [Claude 분류] %s '%s' -> '%s' (%s)" % (c["종류"], c["원본"], c["결과"], c["why"]))
    if has_unmatched(unmatched):
        print("분류 대기 값이 있습니다. %s 를 읽고 %s 에 매핑을 추가한 뒤 다시 빌드하세요."
              % (os.path.join(state_dir, "unmatched.json"), mappings_path(cfg)))
    return report


def main():
    p = argparse.ArgumentParser(description="KMS 그래프 페이지 빌더")
    p.add_argument("--config", help="config.json 경로")
    p.add_argument("--source", choices=["sheets", "notion"], help="config.json 의 source 를 덮어쓴다")
    p.add_argument("--csv-dir", help="CSV 폴더에서 읽기 (사이트.csv / 도메인.csv / 참조데이터.csv)")
    p.add_argument("--out", default="out", help="--csv-dir 일 때 출력 폴더 (기본 out)")
    p.add_argument("--knowledge", help="schemaVersion 2 지식 JSON을 병합한다")
    p.add_argument("--push", action="store_true", help="빌드 후 git commit/push")
    p.add_argument("--no-push", action="store_true", help="푸시하지 않음 (기본값)")
    p.add_argument("--check-urls", dest="check_urls", action="store_true", default=None)
    p.add_argument("--no-check-urls", dest="check_urls", action="store_false")
    p.add_argument("--notify", metavar="PATH", help="마크다운 파일을 Teams 로 전송하고 종료")
    args = p.parse_args()

    cfg = {}
    if args.config:
        with open(args.config, encoding="utf-8") as f:
            cfg = json.load(f)

    if args.notify:
        notify(cfg, args.notify)
        return 0

    if not args.config and not args.csv_dir:
        p.error("--config 또는 --csv-dir 중 하나가 필요합니다.")

    repo = cfg.get("repo_dir", "")
    if args.csv_dir:
        out_dir = os.path.abspath(args.out)
    else:
        if not repo:
            raise SystemExit("config.json 에 repo_dir 이 필요합니다.")
        subdir = cfg.get("out_subdir", "docs")
        if os.path.isabs(subdir):
            raise SystemExit("out_subdir 는 repo_dir 아래 상대 경로여야 합니다.")
        out_dir = os.path.abspath(os.path.join(repo, subdir))
    # Config output and --csv-dir --push both must be a child of the publish repo.
    if not args.csv_dir or (args.push and not args.no_push):
        if not repo:
            raise SystemExit("--push 에는 config.json 의 repo_dir 이 필요합니다.")
        validate_publish_paths(out_dir, cfg, repo)
    else:
        validate_publish_paths(out_dir, cfg)

    build(args, cfg, out_dir)

    if args.push and not args.no_push:
        if not git_push(repo, out_dir):
            return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        print("\n빌드 실패: 위 오류를 확인하세요.", file=sys.stderr)
        sys.exit(1)
