import io
import json
import unittest

from scripts import check_access_app


APP_UUID = "00000000-0000-4000-8000-000000000001"
ACCOUNT_ID = "00000000000000000000000000000001"


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def config():
    return {"CF_ACCOUNT_ID": ACCOUNT_ID, "CF_API_TOKEN": "test-token", "ACCESS_APP_ID": APP_UUID,
            "ACCESS_AUD": "test-audience", "ACCESS_TEAM_DOMAIN": "https://example-team.cloudflareaccess.com",
            "KMS_HOSTNAME": "kms.example.com"}


def opener(request, timeout):
    assert request.full_url.endswith("/accounts/" + ACCOUNT_ID + "/access/apps/" + APP_UUID)
    assert timeout == 20
    app = {"success": True, "result": {"type": "self_hosted", "aud": "test-audience",
                                       "domain": "kms.example.com"}}
    return Response(json.dumps(app).encode())


class AccessAppTests(unittest.TestCase):
    def test_hyphenated_uuid_is_accepted(self):
        self.assertEqual(check_access_app.check_access_app(config(), opener), "kms.example.com")

    def test_invalid_app_id_and_wrong_host_fail_before_publish(self):
        values = config()
        values["ACCESS_APP_ID"] = "../other"
        with self.assertRaisesRegex(ValueError, "UUID"):
            check_access_app.check_access_app(values, opener)
        values = config()
        values["KMS_HOSTNAME"] = "other.example.com"
        with self.assertRaisesRegex(ValueError, "hostname or audience"):
            check_access_app.check_access_app(values, opener)


if __name__ == "__main__":
    unittest.main()
