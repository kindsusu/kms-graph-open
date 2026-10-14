# -*- coding: utf-8 -*-
"""Schema v2 knowledge payload validation and deterministic identifiers."""
import hashlib
import json
import urllib.parse

KINDS = {"document", "tool", "ai_asset"}
RELATION_TYPES = {"references", "based_on", "explains", "uses_with", "related"}
SYMMETRIC_RELATION_TYPES = {"uses_with", "related"}
HEALTH_VALUES = {"ok", "unchecked", "unreachable", "auth_required"}


def stable_id(prefix, value):
    """A non-secret stable identifier. Explicit source IDs always take precedence."""
    digest = hashlib.sha256(value.strip().encode("utf-8")).hexdigest()[:16]
    return "%s-%s" % (prefix, digest)


def safe_http_url(value):
    if not isinstance(value, str) or not value or any(c.isspace() or ord(c) < 32 for c in value):
        return None
    try:
        parsed = urllib.parse.urlsplit(value)
    except (TypeError, ValueError):
        return None
    try:
        hostname, port = parsed.hostname, parsed.port
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or not hostname or parsed.username or parsed.password:
        return None
    return value


def normalized_url(value):
    """Canonical enough for legacy identity; URL spelling changes do not rename a tool."""
    checked = safe_http_url(value)
    if not checked:
        raise ValueError("invalid http(s) URL")
    p = urllib.parse.urlsplit(checked)
    host = p.hostname.lower()
    netloc = host if p.port is None else "%s:%s" % (host, p.port)
    if (p.scheme == "https" and p.port == 443) or (p.scheme == "http" and p.port == 80):
        netloc = host
    path = p.path or "/"
    return urllib.parse.urlunsplit((p.scheme.lower(), netloc, path, p.query, ""))


def _text(value, field, required=False):
    if not isinstance(value, str):
        if required:
            raise ValueError("%s must be a non-empty string" % field)
        return ""
    value = value.strip()
    if required and not value:
        raise ValueError("%s must be a non-empty string" % field)
    return value


def validate_payload(payload):
    if not isinstance(payload, dict) or payload.get("schemaVersion") != 2:
        raise ValueError("knowledge payload schemaVersion must be 2")
    raw_items = payload.get("items")
    raw_relations = payload.get("relations", [])
    if not isinstance(raw_items, list) or not isinstance(raw_relations, list):
        raise ValueError("items and relations must be arrays")
    items, ids = [], set()
    for raw in raw_items:
        if not isinstance(raw, dict):
            raise ValueError("each item must be an object")
        item_id = _text(raw.get("id"), "item.id", True)
        if item_id in ids:
            raise ValueError("duplicate item id: %s" % item_id)
        ids.add(item_id)
        kind = raw.get("kind")
        if kind not in KINDS:
            raise ValueError("unknown item kind: %r" % kind)
        item = {"id": item_id, "kind": kind,
                "title": _text(raw.get("title"), "item.title", True),
                "subtype": _text(raw.get("subtype"), "item.subtype"),
                "description": _text(raw.get("description"), "item.description"),
                "owner": _text(raw.get("owner"), "item.owner"),
                "department": _text(raw.get("department"), "item.department"),
                "domain": _text(raw.get("domain"), "item.domain")}
        tags = raw.get("tags", [])
        if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
            raise ValueError("item.tags must be an array of strings")
        item["tags"] = list(dict.fromkeys(t.strip() for t in tags if t.strip()))
        if raw.get("url"):
            item["url"] = safe_http_url(raw["url"])
            if not item["url"]:
                raise ValueError("item.url must be http(s) without userinfo")
        # A prompt is allowed only for an explicitly registered prompt AI asset.
        if "prompt" in raw and not (kind == "ai_asset" and item["subtype"] == "프롬프트"):
            raise ValueError("prompt is only allowed on ai_asset subtype prompt")
        for key in ("body", "version", "updatedAt", "status", "health", "sourceId", "sourceUpdatedAt", "collectedAt"):
            if key in raw:
                item[key] = _text(raw[key], "item." + key)
        if "health" in item and item["health"] not in HEALTH_VALUES:
            raise ValueError("unknown item.health: %r" % item["health"])
        if "prompt" in raw:
            item["prompt"] = _text(raw["prompt"], "item.prompt", True)
        if raw.get("sourceUrl"):
            item["sourceUrl"] = safe_http_url(raw["sourceUrl"])
            if not item["sourceUrl"]:
                raise ValueError("invalid item.sourceUrl")
        for key in ("folderIds", "projectIds"):
            if key in raw:
                values = raw[key]
                if not isinstance(values, list) or not all(isinstance(v, str) and v.strip() for v in values):
                    raise ValueError("item.%s must be an array of IDs" % key)
                item[key] = list(dict.fromkeys(v.strip() for v in values))
        items.append(item)
    relations, relation_ids, pairs = [], set(), set()
    for raw in raw_relations:
        if not isinstance(raw, dict):
            raise ValueError("each relation must be an object")
        rel_id = _text(raw.get("id"), "relation.id", True)
        source, target = _text(raw.get("source"), "relation.source", True), _text(raw.get("target"), "relation.target", True)
        if rel_id in relation_ids:
            raise ValueError("duplicate relation id: %s" % rel_id)
        if source not in ids or target not in ids:
            raise ValueError("relation endpoint does not exist: %s" % rel_id)
        if source == target:
            raise ValueError("self-loop relation: %s" % rel_id)
        if raw.get("type") not in RELATION_TYPES:
            raise ValueError("unknown relation type: %r" % raw.get("type"))
        # Context relationships have no direction. Store one canonical endpoint pair so
        # A -> B and B -> A cannot make the same relationship appear twice.
        endpoints = tuple(sorted((source, target))) if raw["type"] in SYMMETRIC_RELATION_TYPES else (source, target)
        pair = (*endpoints, raw["type"])
        if pair in pairs:
            raise ValueError("duplicate relation: %s" % (pair,))
        relation_ids.add(rel_id); pairs.add(pair)
        rel = {"id": rel_id, "source": source, "target": target,
               "type": raw["type"], "label": _text(raw.get("label"), "relation.label")}
        if "evidence" in raw:
            rel["evidence"] = _text(raw["evidence"], "relation.evidence")
        if raw.get("evidenceUrl"):
            rel["evidenceUrl"] = safe_http_url(raw["evidenceUrl"])
            if not rel["evidenceUrl"]:
                raise ValueError("invalid relation.evidenceUrl")
        relations.append(rel)
    result = {"schemaVersion": 2, "title": _text(payload.get("title"), "title") or "KMS",
              "generatedAt": _text(payload.get("generatedAt"), "generatedAt"),
              "items": items, "relations": relations}
    if isinstance(payload.get("isDemo"), bool):
        result["isDemo"] = payload["isDemo"]
    for key, membership in (("sharedFolders", "folderIds"), ("sharedProjects", "projectIds")):
        records = payload.get(key, [])
        if not isinstance(records, list):
            raise ValueError("%s must be an array" % key)
        groups, group_ids = [], set()
        for record in records:
            if not isinstance(record, dict):
                raise ValueError("invalid shared group")
            group_id = _text(record.get("id"), key + ".id", True)
            if group_id in group_ids:
                raise ValueError("duplicate shared group id: " + group_id)
            group_ids.add(group_id)
            group = {"id": group_id, "title": _text(record.get("title"), key + ".title", True),
                     "description": _text(record.get("description"), key + ".description")}
            if key == "sharedProjects" and "folderId" in record:
                folder_id = _text(record["folderId"], "sharedProjects.folderId", True)
                if folder_id not in {folder["id"] for folder in result.get("sharedFolders", [])}:
                    raise ValueError("unknown shared project folder: " + folder_id)
                group["folderId"] = folder_id
            groups.append(group)
        for item in items:
            if any(v not in group_ids for v in item.get(membership, [])):
                raise ValueError("unknown shared membership for " + item["id"])
        if groups:
            result[key] = groups
    return result


def load_knowledge(path):
    with open(path, encoding="utf-8") as f:
        return validate_payload(json.load(f))


def merge_payloads(base, extra):
    """Merge separately validated payloads, rejecting IDs or relation duplicates."""
    merged = dict(base)
    merged["items"] = list(base["items"]) + list(extra["items"])
    merged["relations"] = list(base["relations"]) + list(extra["relations"])
    for key in ("sharedFolders", "sharedProjects"):
        if key in base or key in extra:
            merged[key] = list(base.get(key, [])) + list(extra.get(key, []))
    return validate_payload(merged)
