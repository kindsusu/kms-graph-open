import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("sync_notion", Path(__file__).with_name("sync_notion.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


def fixture_config():
    return {"title": "Test KMS", "sources": [
        {"name": f"부서{i} AI 자산", "data_source_id": f"{i:08x}-0000-0000-0000-000000000000"}
        for i in range(11)
    ]}


def page(number, description=""):
    uid = f"{number:08x}-0000-0000-0000-000000000000"
    def field(kind, value):
        if kind in {"title", "rich_text"}:
            return {"type": kind, kind: [{"plain_text": value}]}
        return {"type": kind, kind: value}
    return {"object": "page", "id": uid, "last_edited_time": "2026-10-14T00:00:00Z", "properties": {
        "자산명": field("title", f"자산 {number}"), "자산 한 줄 설명": field("rich_text", description),
        "자산 유형": field("multi_select", [{"name": "문서"}]),
        "결과물 링크(선택)": field("rich_text", "대시보드 https://example.com/app") if number == 100 else field("rich_text", "")}}


class FakeClient:
    def __init__(self, fail_body=False):
        self.fail_body = fail_body
        self.pages_seen = []

    def pages(self, method, path, body=None):
        self.pages_seen.append(path)
        if path.startswith("/data_sources/"):
            if path.endswith("000000000000/query") and path.startswith("/data_sources/00000000000000000000000000000000"):
                yield page(100, "비밀번호: verysecretvalue")
                yield page(101, "A second page")
            return
        if self.fail_body and path.startswith("/blocks/00000065"):
            raise RuntimeError("Notion API request failed")
        if path.startswith("/blocks/00000064"):
            yield {"id": "000000c8-0000-0000-0000-000000000000", "type": "paragraph", "paragraph": {
                "rich_text": [{"plain_text": "안내 https://www.notion.so/00000065000000000000000000000000",
                               "text": {"content": "안내", "link": None}}]}, "has_children": True}
        elif path.startswith("/blocks/000000c8"):
            yield {"id": "000000c9-0000-0000-0000-000000000000", "type": "paragraph", "paragraph": {
                "rich_text": [{"plain_text": "다운로드 https://x.example/f?X-Amz-Signature=secret"}]}, "has_children": False}


class SyncNotionTests(unittest.TestCase):
    def test_complete_collection_and_actual_link_only(self):
        client = FakeClient()
        payload, summary = sync.collect(client, fixture_config())
        self.assertEqual(summary["sources"], 11)
        self.assertEqual(summary["items"], 2)
        self.assertEqual(len(payload["sharedFolders"]), 11)
        self.assertEqual(payload["items"][0]["id"], "notion-00000064000000000000000000000000")
        self.assertEqual(len(payload["relations"]), 1)
        self.assertEqual(payload["relations"][0]["target"], payload["items"][1]["id"])
        self.assertEqual(payload["items"][0]["url"], "https://example.com/app")
        self.assertNotIn("verysecretvalue", str(payload))
        self.assertNotIn("X-Amz-Signature", str(payload))
        self.assertIn("[접속 정보는 원본 Notion 페이지에서 확인]", payload["items"][0]["description"])
        self.assertTrue(any("/blocks/000000c8000000000000000000000000/children" in path for path in client.pages_seen))

    def test_failure_in_one_page_aborts_all_data(self):
        with self.assertRaisesRegex(RuntimeError, "Notion API request failed"):
            sync.collect(FakeClient(fail_body=True), fixture_config())

    def test_cursor_pagination_and_missing_cursor(self):
        client = object.__new__(sync.NotionClient)
        calls = []
        def request(method, path, body):
            calls.append(body)
            if len(calls) == 1:
                return {"object": "list", "results": [1], "has_more": True, "next_cursor": "next"}
            return {"object": "list", "results": [2], "has_more": False, "next_cursor": None}
        client.request = request
        self.assertEqual(list(client.pages("POST", "/data_sources/id/query")), [1, 2])
        self.assertEqual(calls[1]["start_cursor"], "next")
        client.request = lambda *_: {"object": "list", "results": [], "has_more": True, "next_cursor": None}
        with self.assertRaisesRegex(ValueError, "pagination"):
            list(client.pages("POST", "/data_sources/id/query"))

    def test_empty_sources_fail(self):
        config = fixture_config()
        config["sources"].clear()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "sources.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "At least one"):
                sync.parse_sources(path)
        self.assertFalse(sync.safe_link("https://example.com/file?token=secret"))

    def test_example_collection_id_queries_data_source_directly(self):
        shipped = sync.parse_sources(sync.ROOT / "config/notion-sources.example.json")
        self.assertEqual(len(shipped["sources"]), 1)
        source = shipped["sources"][0]
        self.assertIn("data_source_id", source)
        self.assertNotIn("database_id", source)
        class NoDatabaseLookups:
            def request(self, *_):
                raise AssertionError("Database lookup should not be needed")
        self.assertEqual(sync.source_data_source(NoDatabaseLookups(), source),
                         source["data_source_id"].replace("-", ""))

    def test_clean_checkout_creates_out_after_successful_collection(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            out = root / "out"
            def render(target, payload):
                self.assertEqual(Path(target), out)
                self.assertTrue(out.is_dir())
                (out / "index.html").write_text("ready", encoding="utf-8")
            with patch.object(sync, "ROOT", root), patch.object(sync, "parse_sources", return_value=fixture_config()), \
                 patch.object(sync, "NotionClient", return_value=FakeClient()), \
                 patch.object(sync, "collect", return_value=({"items": []}, {"items": 0})), \
                 patch.object(sync.build, "render", side_effect=render), \
                 patch.object(sync.build, "validate_public_contents"), \
                 patch("sys.argv", ["sync_notion.py", "--out", str(out)]), \
                 patch.dict("os.environ", {"NOTION_TOKEN": "test"}):
                sync.main()
            self.assertTrue((out / "index.html").exists())


if __name__ == "__main__":
    unittest.main()
