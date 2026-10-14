# -*- coding: utf-8 -*-
import argparse
import json
import os
import shutil
import tempfile

import build
import knowledge

HERE = os.path.dirname(os.path.abspath(__file__))
sample = knowledge.load_knowledge(os.path.join(HERE, "sample", "knowledge.json"))
assert len(sample["items"]) == 4 and sample["items"][2]["subtype"] == "프롬프트"
assert "prompt" not in sample["items"][0]

def invalid(change):
    p = json.loads(json.dumps(sample)); change(p)
    try:
        knowledge.validate_payload(p)
    except ValueError:
        return
    raise AssertionError("invalid payload accepted")

invalid(lambda p: p["items"].append(dict(p["items"][0])))
invalid(lambda p: p["relations"].append({"id":"x", "source":"missing", "target":"doc-manual", "type":"references", "label":""}))
invalid(lambda p: p["relations"].append({"id":"x", "source":"doc-manual", "target":"doc-manual", "type":"references", "label":""}))
invalid(lambda p: p["relations"].extend([
    {"id":"symmetric-1", "source":"doc-manual", "target":"doc-annual-policy", "type":"related", "label":""},
    {"id":"symmetric-2", "source":"doc-annual-policy", "target":"doc-manual", "type":"related", "label":""},
]))
invalid(lambda p: p["items"][0].update(prompt="leak"))
invalid(lambda p: p["items"][3].update(url="https://u:p@example.com"))
invalid(lambda p: p["items"][3].update(health="maybe"))
assert knowledge.stable_id("tool", "https://x") == knowledge.stable_id("tool", "https://x")

# Directed relations retain both directions because each direction has a different meaning.
directed = json.loads(json.dumps(sample))
directed["relations"].append({"id":"directed-reverse", "source":"doc-annual-policy", "target":"doc-manual", "type":"references", "label":"참조"})
assert len(knowledge.validate_payload(directed)["relations"]) == 4

# Canonical whitespace IDs still connect, and non-contract values never reach output.
trimmed = json.loads(json.dumps(sample))
trimmed["items"][0]["id"] = "  doc-annual-policy  "
trimmed["items"][0]["internal_secret"] = "do not publish"
trimmed["relations"][0]["target"] = " doc-annual-policy "
trimmed = knowledge.validate_payload(trimmed)
assert trimmed["items"][0]["id"] == "doc-annual-policy"
assert trimmed["relations"][0]["target"] == "doc-annual-policy"
assert "internal_secret" not in trimmed["items"][0]

tmp = tempfile.mkdtemp(prefix="kms-v2-")
try:
    args = argparse.Namespace(csv_dir=os.path.join(HERE, "sample"), check_urls=False,
                              knowledge=os.path.join(HERE, "sample", "knowledge.json"))
    out = os.path.join(tmp, "public")
    report = build.build(args, {"site_title":"T", "mappings_file":os.path.join(tmp, "missing")}, out)
    html = open(os.path.join(out, "index.html"), encoding="utf-8").read()
    assert 'schemaVersion' in html and '회계연도 기준이 아니라' not in html, "legacy prompt leaked"
    assert not os.path.exists(os.path.join(out, "report.json"))
    assert os.path.exists(os.path.join(build.state_directory(out, {}), "report.json"))
    assert report["counts"] == {"sites": 7, "data": 9, "domains": 5}
    # Published legacy data contains only references from approved tools, never all masters.
    assert 'ERP 매출 엑셀 export' not in html  # its site is pending approval
    sites = [{"id": "", "name": "old" , "url": "HTTPS://Apps.Example.com:443/a#old", "desc": "",
              "domain": "", "data": [], "author": "", "tool": "", "date": "", "status": "skipped"}]
    renamed = [dict(sites[0], name="new")]
    assert build.legacy_payload(sites, [], {}, "")["items"][0]["id"] == build.legacy_payload(renamed, [], {}, "")["items"][0]["id"]
    # State paths within the public output are rejected before source reading or writes.
    for unsafe in (out, os.path.join(out, "private")):
        try:
            build.validate_publish_paths(out, {"state_dir": unsafe})
        except SystemExit:
            pass
        else:
            raise AssertionError("unsafe state path accepted")
    repo = os.path.join(tmp, "repo"); os.makedirs(repo)
    for unsafe_out in (repo, os.path.join(repo, "..", "escape")):
        try:
            build.validate_publish_paths(unsafe_out, {}, repo)
        except SystemExit:
            pass
        else:
            raise AssertionError("unsafe publish path accepted")
    os.makedirs(os.path.join(tmp, "old")); open(os.path.join(tmp, "old", "report.json"), "w").close()
    try:
        build.build(args, {}, os.path.join(tmp, "old"))
    except SystemExit:
        pass
    else:
        raise AssertionError("legacy public report was accepted")
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print("knowledge tests passed")

# Explicit independent data keeps identity across title changes, filters approval, and
# never promotes an unpublished endpoint through a relation or shared membership.
base = {"schemaVersion": 2, "title": "테스트", "generatedAt": "", "items": [], "relations": []}
rows = {
    "items": [{"ID": "policy", "제목": "규정", "종류": "문서", "승인": "TRUE", "출처ID": "page-1",
               "출처URL": "https://example.com/source", "원본수정일": "2026-10-01"},
              {"출처ID": "page-2", "제목": "매뉴얼", "종류": "document", "승인": "TRUE"},
              {"ID": "private", "제목": "미승인", "종류": "document", "승인": "FALSE"}],
    "shared_folders": [{"ID": "team", "제목": "팀 자료", "승인": "TRUE"}],
    "shared_projects": [{"ID": "renewal", "제목": "개정", "폴더ID": "team", "승인": "TRUE"}],
    "memberships": [{"자료ID": "policy", "폴더ID": "team", "프로젝트ID": "renewal", "승인": "TRUE"}],
    "relations": [{"ID": "dep", "시작ID": knowledge.stable_id("source", "page-2"), "대상ID": "policy",
                   "관계유형": "based_on", "근거": "규정 2조에 따른 절차", "근거URL": "https://example.com/rule", "승인": "TRUE"},
                  {"ID": "private-dep", "시작ID": "private", "대상ID": "policy", "관계유형": "references", "승인": "FALSE"}],
}
explicit = build.imported_payload(base, rows, "2026-10-14")
assert len(explicit["items"]) == 2 and len(explicit["relations"]) == 1
assert explicit["items"][0]["folderIds"] == ["team"] and explicit["items"][0]["projectIds"] == ["renewal"]
assert explicit["sharedProjects"][0]["folderId"] == "team"
assert explicit["relations"][0]["evidence"] == "규정 2조에 따른 절차"
assert explicit["items"][0]["sourceUpdatedAt"] != explicit["items"][0]["collectedAt"]
assert build.review_candidates(explicit, None) == []
same_content = build.imported_payload(base, rows, "2026-10-15")
assert build.review_candidates(same_content, explicit) == [], "collection time caused false review candidates"
renamed_rows = json.loads(json.dumps(rows))
renamed_rows["items"][0]["제목"] = "개정 규정"
renamed_rows["items"][1]["제목"] = "개정 매뉴얼"
renamed = build.imported_payload(base, renamed_rows, "2026-10-16")
assert [i["id"] for i in renamed["items"]] == [i["id"] for i in explicit["items"]]
assert build.review_candidates(renamed, explicit)[0]["itemId"] == knowledge.stable_id("source", "page-2")
assert build.review_candidates(renamed, explicit)[0]["changedSourceIds"] == ["policy"]

def bad_import(change):
    bad = json.loads(json.dumps(rows)); change(bad)
    try:
        build.imported_payload(base, bad, "2026-10-14")
    except ValueError:
        return
    raise AssertionError("malformed or unpublished import accepted")

bad_import(lambda p: p["relations"][0].update(대상ID="private"))
bad_import(lambda p: p["relations"][0].update(관계유형="automatic"))
bad_import(lambda p: p["items"][0].update(ID="", 출처ID=""))
bad_import(lambda p: p["items"][0].update(출처URL="https://user:pass@example.com"))
bad_import(lambda p: p["items"][1].update(ID="policy"))
bad_import(lambda p: p["memberships"][0].update(자료ID="private"))
bad_import(lambda p: p["memberships"][0].update(폴더ID="missing"))
bad_import(lambda p: p["shared_projects"][0].update(승인="FALSE"))
bad_import(lambda p: p["shared_projects"][0].update(폴더ID="missing"))
bad_import(lambda p: p["shared_folders"][0].update(승인="FALSE"))

# Cycles are bounded; contextual and explanatory edges do not invent dependencies.
cycle = json.loads(json.dumps(explicit))
cycle["relations"].append({"id": "cycle", "source": "policy", "target": knowledge.stable_id("source", "page-2"), "type": "references"})
cycle = knowledge.validate_payload(cycle)
cycle_changed = json.loads(json.dumps(cycle)); cycle_changed["items"][0]["description"] = "변경"
assert len(build.review_candidates(cycle_changed, cycle)) == 1
context = json.loads(json.dumps(explicit)); context["relations"][0]["type"] = "explains"
context_changed = json.loads(json.dumps(context)); context_changed["items"][0]["description"] = "변경"
assert build.review_candidates(context_changed, context) == []
# Deletion impact exposes only a count, never the unpublished source ID.
deleted = json.loads(json.dumps(explicit))
deleted["items"] = deleted["items"][1:]; deleted["relations"] = []
deletion = build.review_candidates(deleted, explicit)
assert deletion[0]["changedSourceIds"] == [] and deletion[0]["removedSourceCount"] == 1
assert 'policy' not in json.dumps(deletion)
# Explicit registered AI assets remain data; no generation or execution is introduced.
asset_rows = {"items": [{"ID": "registered-prompt", "제목": "기존 프롬프트", "종류": "ai_asset",
                         "세부종류": "프롬프트", "프롬프트": "등록된 문자열", "승인": "TRUE"}]}
assert build.imported_payload(base, asset_rows, "today")["items"][0]["prompt"] == "등록된 문자열"
asset_rows["items"][0]["종류"] = "document"
try:
    build.imported_payload(base, asset_rows, "today")
except ValueError:
    pass
else:
    raise AssertionError("document prompt was accepted")
print("명시 자료·관계·공용 소속·변경 영향 테스트 통과")

# Legacy URL health uses the same authorization distinction as explicit inputs.
legacy_site = {"id": "health-tool", "name": "인증 도구", "url": "https://example.com/auth", "desc": "",
               "domain": "", "data": [], "author": "", "tool": "", "date": ""}
for status, expected in (("error:401", "auth_required"), ("error:403", "auth_required"),
                         ("error:404", "unreachable"), ("skipped", "unchecked"), ("ok", "ok")):
    site = dict(legacy_site, status=status)
    assert build.legacy_payload([site], [], {}, "")["items"][0]["health"] == expected
