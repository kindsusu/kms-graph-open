"""Read the approved Notion source databases and render a complete KMS snapshot."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import build  # noqa: E402
import knowledge  # noqa: E402

VERSION = "2026-03-11"
UUID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$", re.I)
NOTION_ID = re.compile(r"([0-9a-f]{32})(?![0-9a-f])", re.I)
URL = re.compile(r"https?://[^\s<>\[\]\"')]+", re.I)
CREDENTIAL = re.compile(r"(?:비밀번호|비번|패스워드|password|passwd|secret|api[_ -]?key|access[_ -]?token|로그인\s*(?:정보|계정)|아이디\s*[:：]|\b(?:pwd|pw|id)\s*[:=])", re.I)
SECRET_VALUE = re.compile(r"(?:비밀번호|비번|패스워드|password|passwd|secret|api[_ -]?key|access[_ -]?token|\b(?:pwd|pw))\s*[:=：]\s*[`\"']?([^\s`\"'<>]+)", re.I)
SIGNED_KEYS = {"x-amz-signature", "x-amz-credential", "x-amz-security-token", "x-amz-expires", "signature", "token", "access_token", "auth", "key-pair-id", "policy", "sig", "x-goog-signature", "x-goog-credential", "api_key", "apikey", "password", "passwd", "secret", "client_secret", "authorization"}
NOTION_HOSTS = {"notion.so", "www.notion.so", "app.notion.com", "notion.com", "www.notion.com", "notion.site", "www.notion.site"}


def compact_id(value):
    if not isinstance(value, str):
        raise ValueError("Notion ID is missing")
    candidate = value.replace("-", "").lower()
    if not re.fullmatch(r"[0-9a-f]{32}", candidate):
        raise ValueError("Notion ID is invalid")
    return candidate


def safe_link(value):
    if not knowledge.safe_http_url(value):
        return None
    parsed = urlsplit(value)
    if {key.lower() for key in parse_qs(parsed.query)} & SIGNED_KEYS:
        return None
    return value


class Sanitizer:
    def __init__(self, raw_text):
        self.secrets = {m.group(1).rstrip(",;)") for m in SECRET_VALUE.finditer(raw_text)}
        self.secrets = {s for s in self.secrets if len(s) >= 4 and s.lower() not in {"none", "null", "false", "true"}}
        self.removed = Counter()

    def text(self, value):
        lines = []
        for line in str(value or "").splitlines():
            if CREDENTIAL.search(line):
                self.removed["credentialLines"] += 1
                lines.append("[접속 정보는 원본 Notion 페이지에서 확인]")
                continue
            for secret in self.secrets:
                if secret in line:
                    self.removed["credentialValues"] += 1
                    line = line.replace(secret, "[접속 정보 삭제]")
            def strip_signed(match):
                target = match.group(0).rstrip(".,;")
                if not safe_link(target):
                    self.removed["signedLinks"] += 1
                    return "[파일·접속 링크는 원본 Notion에서 확인]"
                return match.group(0)
            lines.append(URL.sub(strip_signed, line))
        return "\n".join(lines)


class NotionClient:
    def __init__(self, token, *, opener=urlopen, sleeper=time.sleep):
        if not token:
            raise ValueError("NOTION_TOKEN is required")
        self.token, self.opener, self.sleeper = token, opener, sleeper

    def request(self, method, path, body=None):
        if not re.fullmatch(r"/[a-zA-Z0-9_/?=&%-]+", path):
            raise ValueError("Invalid Notion API path")
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = Request("https://api.notion.com/v1" + path, data=data, method=method,
                          headers={"Authorization": "Bearer " + self.token, "Notion-Version": VERSION,
                                   "Content-Type": "application/json"})
        for attempt in range(4):
            try:
                with self.opener(request, timeout=30) as response:
                    result = json.load(response)
                if not isinstance(result, dict):
                    raise ValueError("Notion API returned invalid JSON object")
                return result
            except HTTPError as error:
                if error.code in {429, 500, 502, 503, 504, 529} and attempt < 3:
                    retry = error.headers.get("Retry-After", "")
                    delay = min(float(retry), 30) if re.fullmatch(r"\d+(?:\.\d+)?", retry) else 2 ** attempt
                    self.sleeper(delay)
                    continue
                raise RuntimeError(f"Notion API request failed: HTTP {error.code} at {method} {path.split('?')[0]}") from None
            except (URLError, TimeoutError):
                if attempt < 3:
                    self.sleeper(2 ** attempt)
                    continue
                raise RuntimeError(f"Notion API connection failed at {method} {path.split('?')[0]}") from None
        raise AssertionError("unreachable")

    def pages(self, method, path, body=None):
        cursor, cursors = None, set()
        while True:
            if method == "POST":
                request_body = {**(body or {}), "page_size": 100}
                if cursor:
                    request_body["start_cursor"] = cursor
                response = self.request(method, path, request_body)
            else:
                query = {"page_size": 100}
                if cursor:
                    query["start_cursor"] = cursor
                response = self.request(method, path + "?" + urlencode(query))
            if response.get("object") != "list" or not isinstance(response.get("results"), list):
                raise ValueError("Notion list response is incomplete")
            status = response.get("request_status")
            if status and status.get("type") != "complete":
                raise ValueError("Notion source query was truncated")
            yield from response["results"]
            if not response.get("has_more"):
                return
            cursor = response.get("next_cursor")
            if not isinstance(cursor, str) or not cursor or cursor in cursors:
                raise ValueError("Notion source pagination is incomplete")
            cursors.add(cursor)


def rich_text(value):
    if not isinstance(value, list):
        return ""
    return "".join(str(part.get("plain_text") or part.get("text", {}).get("content") or "") for part in value if isinstance(part, dict))


def property_value(prop):
    if not isinstance(prop, dict):
        return ""
    kind = prop.get("type")
    if kind in {"title", "rich_text"}:
        return rich_text(prop.get(kind))
    if kind in {"select", "status"}:
        return (prop.get(kind) or {}).get("name") or ""
    if kind in {"multi_select", "people"}:
        return ", ".join(str(v.get("name", "")) for v in prop.get(kind, []) if isinstance(v, dict))
    if kind == "date":
        return (prop.get("date") or {}).get("start") or ""
    if kind == "url":
        return prop.get("url") or ""
    if kind == "files":
        return ", ".join(str(v.get("name", "")) for v in prop.get("files", []) if isinstance(v, dict))
    if kind in {"created_time", "last_edited_time", "email", "phone_number", "number"}:
        return str(prop.get(kind) or "")
    return ""


def prop(row, name):
    return property_value(row.get("properties", {}).get(name))


def property_links(row, name):
    property_obj = row.get("properties", {}).get(name, {})
    candidates = URL.findall(property_value(property_obj))
    if isinstance(property_obj, dict):
        rich_parts = property_obj.get(property_obj.get("type"), [])
        if isinstance(rich_parts, list):
            for part in rich_parts:
                if not isinstance(part, dict):
                    continue
                text_part = part.get("text")
                link = text_part.get("link") if isinstance(text_part, dict) else None
                href = part.get("href") or (link.get("url") if isinstance(link, dict) else None)
                if href:
                    candidates.append(href)
    return list(dict.fromkeys(link for raw in candidates if (link := safe_link(raw.rstrip(".,;")))))


def walk_blocks(client, page_id, *, depth=0, seen=None):
    if depth > 20:
        raise ValueError("Notion page nested blocks exceed safe depth")
    seen = seen if seen is not None else set()
    lines, links = [], []
    for block in client.pages("GET", "/blocks/" + page_id + "/children"):
        if not isinstance(block, dict) or not block.get("id"):
            raise ValueError("Notion block is invalid")
        block_id = compact_id(block["id"])
        if block_id in seen:
            raise ValueError("Notion nested blocks contain a cycle")
        seen.add(block_id)
        kind = block.get("type")
        value = block.get(kind, {}) if isinstance(kind, str) else {}
        if not isinstance(value, dict):
            value = {}
        text = rich_text(value.get("rich_text", []))
        if kind == "child_page":
            text = str(value.get("title") or "")
            links.append("https://www.notion.so/" + block_id)
        elif kind in {"file", "image", "video", "pdf", "audio"}:
            text = str(value.get("caption") and rich_text(value["caption"]) or value.get("name") or kind)
        elif kind == "bookmark":
            text = str(value.get("url") or "")
        elif kind == "table_row":
            text = " | ".join(rich_text(cell) for cell in value.get("cells", []))
        elif kind == "equation":
            text = str(value.get("expression") or "")
        if kind in {"heading_1", "heading_2", "heading_3"}:
            text = "#" * int(kind[-1]) + " " + text
        if kind in {"bulleted_list_item", "numbered_list_item", "to_do"}:
            text = "- " + text
        if text:
            lines.append("  " * depth + text)
        for part in value.get("rich_text", []):
            if isinstance(part, dict):
                text_part = part.get("text")
                link = text_part.get("link") if isinstance(text_part, dict) else None
                href = part.get("href") or (link.get("url") if isinstance(link, dict) else None)
                if href:
                    links.append(href)
        if block.get("has_children") and kind != "child_page":
            child_lines, child_links = walk_blocks(client, block_id, depth=depth + 1, seen=seen)
            lines.extend(child_lines)
            links.extend(child_links)
    return lines, links


def flatten_texts(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return "\n".join(flatten_texts(v) for v in value.values())
    if isinstance(value, (list, tuple)):
        return "\n".join(flatten_texts(v) for v in value)
    return ""


def source_data_source(client, source):
    if "data_source_id" in source:
        return compact_id(source["data_source_id"])
    database_id = compact_id(source["database_id"])
    db = client.request("GET", "/databases/" + database_id)
    ids = [x.get("id") for x in db.get("data_sources", []) if isinstance(x, dict)]
    if len(ids) != 1:
        raise ValueError("Database must have exactly one data source or configure data_source_id")
    return compact_id(ids[0])


def parse_sources(path):
    config = json.loads(Path(path).read_text(encoding="utf-8"))
    sources = config.get("sources")
    if not isinstance(sources, list) or not sources:
        raise ValueError("At least one Notion source is required")
    names, ids = set(), set()
    for source in sources:
        if not isinstance(source, dict) or not isinstance(source.get("name"), str) or not source["name"].strip():
            raise ValueError("Source name is required")
        if ("database_id" in source) == ("data_source_id" in source):
            raise ValueError("Each source needs exactly one database_id or data_source_id")
        identifier = compact_id(source.get("database_id", source.get("data_source_id")))
        if source["name"] in names or identifier in ids:
            raise ValueError("Duplicate Notion source")
        names.add(source["name"]); ids.add(identifier)
    return config


def collect(client, config):
    sources = config["sources"]
    raw = []
    all_ids = set()
    for source in sources:
        data_source_id = source_data_source(client, source)
        rows = list(client.pages("POST", "/data_sources/" + data_source_id + "/query"))
        for row in rows:
            if not isinstance(row, dict) or row.get("object") != "page" or row.get("in_trash") or row.get("archived"):
                raise ValueError("Notion source returned an invalid or archived page")
            pid = compact_id(row.get("id"))
            if pid in all_ids:
                raise ValueError("Duplicate Notion page across department sources")
            all_ids.add(pid)
            lines, links = walk_blocks(client, pid)
            raw.append((source, row, lines, links))
    if not raw:
        raise ValueError("All Notion sources are empty; refusing to publish")
    sanitizer = Sanitizer(flatten_texts(raw))
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    folders, items, refs = {}, [], []
    for source in sources:
        department = source["name"].split(" AI ")[0]
        folder_id = knowledge.stable_id("folder", "notion-department:" + department)
        folders[folder_id] = {"id": folder_id, "title": department, "description": "Notion AI KMS 부서별 자산"}
    for source, row, lines, block_links in raw:
        pid = compact_id(row["id"])
        department = source["name"].split(" AI ")[0]
        folder_id = knowledge.stable_id("folder", "notion-department:" + department)
        categories = [part.strip() for part in prop(row, "자산 유형").split(",") if part.strip()]
        artifact_links = property_links(row, "결과물 링크(선택)")
        artifact_url = artifact_links[0] if artifact_links else None
        body = "\n".join(lines)
        extras = []
        for label in ("자산 유형", "사용 AI", "활용 월", "활용일", "제작자", "AX 검토 담당자", "파일(선택)"):
            val = prop(row, label)
            if val:
                extras.append("- " + label + ": " + sanitizer.text(val))
        if extras:
            body += "\n\n## 원본 자산 속성\n" + "\n".join(extras)
        if len(artifact_links) > 1:
            body += "\n\n## 결과물 링크\n" + "\n".join("- " + link for link in artifact_links)
        item = {"id": "notion-" + pid, "sourceId": pid, "sourceUrl": "https://www.notion.so/" + pid,
                "kind": "tool" if "도구·시스템 제작" in categories and artifact_url else "ai_asset",
                "title": sanitizer.text(prop(row, "자산명") or prop(row, "Name") or "제목 없음"),
                "subtype": sanitizer.text(", ".join(categories)), "description": sanitizer.text(prop(row, "자산 한 줄 설명")),
                "owner": sanitizer.text(prop(row, "등록자")), "department": sanitizer.text(department), "domain": "",
                "tags": [sanitizer.text(v) for v in categories + [prop(row, "사용 AI"), prop(row, "활용 월")] if v],
                "body": sanitizer.text(body), "updatedAt": row.get("last_edited_time") or "",
                "sourceUpdatedAt": row.get("last_edited_time") or "", "collectedAt": generated_at,
                "folderIds": [folder_id], "health": "unchecked"}
        if artifact_url:
            item["url"] = artifact_url
        items.append(item)
        for link in block_links + URL.findall(body) + artifact_links:
            if not safe_link(link):
                continue
            parsed = urlsplit(link)
            if parsed.hostname in NOTION_HOSTS or (parsed.hostname or "").endswith(".notion.site"):
                match = NOTION_ID.search(parsed.path.replace("-", ""))
                if match and match.group(1).lower() != pid:
                    refs.append((pid, match.group(1).lower()))
    relations, pairs = [], set()
    for source_id, target_id in refs:
        if target_id not in all_ids or (source_id, target_id) in pairs:
            continue
        pairs.add((source_id, target_id))
        relations.append({"id": knowledge.stable_id("relation", source_id + "|" + target_id),
                          "source": "notion-" + source_id, "target": "notion-" + target_id,
                          "type": "references", "label": "원본 참조",
                          "evidence": "원본 Notion 본문 또는 결과물 링크의 페이지 참조",
                          "evidenceUrl": "https://www.notion.so/" + source_id})
    payload = knowledge.validate_payload({"schemaVersion": 2, "title": config.get("title", "Knowledge Base"),
                                          "generatedAt": generated_at, "items": items,
                                          "relations": relations, "sharedFolders": list(folders.values()), "isDemo": False})
    if len(items) != len(all_ids) or len(folders) != len(sources):
        raise ValueError("Notion source completeness check failed")
    return payload, {"sources": len(sources), "items": len(items), "relations": len(relations),
                     "departments": dict(Counter(i["department"] for i in items)),
                     "redactions": dict(sanitizer.removed)}


def main():
    parser = argparse.ArgumentParser(description="Sync configured Notion sources into a read-only KMS site")
    parser.add_argument("--sources", default=str(ROOT / "config/notion-sources.example.json"))
    parser.add_argument("--out", default=str(ROOT / "out"))
    args = parser.parse_args()
    config = parse_sources(args.sources)
    client = NotionClient(os.environ.get("NOTION_TOKEN"))
    payload, report = collect(client, config)
    output = Path(args.out).resolve()
    if output != ROOT / "out":
        raise ValueError("Publishing output must be the repository out directory")
    build.validate_public_contents(str(output))
    output.mkdir(parents=True, exist_ok=True)
    build.render(str(output), payload)
    build.validate_public_contents(str(output))
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        print("Notion sync failed: " + str(error), file=sys.stderr)
        sys.exit(1)
