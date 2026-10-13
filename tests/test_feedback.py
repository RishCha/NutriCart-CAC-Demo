"""Feedback endpoint and Resend transport contracts; no provider request is real."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import MagicMock, patch

import requests

import app
import feedback_delivery

ROOT = Path(__file__).resolve().parents[1]


class FeedbackEnvironmentFlagTests(unittest.TestCase):
    def probe(self, flag=None, **changes):
        env = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP") if key in os.environ}
        env.update({
            "PYTHON_DOTENV_DISABLED": "1", "FLASK_SKIP_DOTENV": "1", "NUTRICART_CATALOG_MODE": "demo",
            "RESEND_API_KEY": "re_test_fixture", "NUTRICART_FEEDBACK_FROM": "NutriCart <sender@example.test>",
            "NUTRICART_FEEDBACK_TO": "review@example.test",
        })
        if flag is not None:
            env["NUTRICART_FEEDBACK_ENABLED"] = flag
        env.update(changes)
        code = """
import json
import app
response = app.app.test_client().get('/api/feedback')
print(json.dumps({'flag': app.app.config['FEEDBACK_ENABLED'], 'enabled': response.json['enabled'],
                  'keys': sorted(response.json), 'cache': response.headers.get('Cache-Control')}))
"""
        result = subprocess.run([sys.executable, "-B", "-c", code], cwd=ROOT, env=env,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout.strip())

    def test_missing_and_false_flags_default_to_disabled(self):
        for flag in (None, "", "false", "0", "no", "unexpected"):
            with self.subTest(flag=flag):
                state = self.probe(flag)
                self.assertFalse(state["flag"])
                self.assertFalse(state["enabled"])
                self.assertEqual(state["keys"], ["csrf_token", "enabled"])
                self.assertEqual(state["cache"], "no-store")

    def test_accepted_flags_enable_only_with_valid_resend_configuration(self):
        for flag in ("1", "true", "TRUE", "yes", "YeS"):
            with self.subTest(flag=flag):
                state = self.probe(flag)
                self.assertTrue(state["flag"])
                self.assertTrue(state["enabled"])

    def test_enabled_flag_fails_closed_for_incomplete_resend_configuration(self):
        for changes in (
            {"RESEND_API_KEY": ""}, {"NUTRICART_FEEDBACK_FROM": ""},
            {"NUTRICART_FEEDBACK_TO": ""}, {"NUTRICART_FEEDBACK_FROM": "invalid"},
            {"NUTRICART_FEEDBACK_TO": "invalid"},
        ):
            with self.subTest(changes=changes):
                state = self.probe("true", **changes)
                self.assertTrue(state["flag"])
                self.assertFalse(state["enabled"])

    def test_smtp_configuration_does_not_enable_feedback(self):
        state = self.probe(
            "true", RESEND_API_KEY="", NUTRICART_FEEDBACK_FROM="",
            NUTRICART_SMTP_HOST="smtp.example.test", NUTRICART_SMTP_PORT="587",
            NUTRICART_SMTP_FROM="sender@example.test", NUTRICART_SMTP_USERNAME="fixture",
            NUTRICART_SMTP_PASSWORD="fixture",
        )
        self.assertFalse(state["enabled"])


class FeedbackEndpointTests(unittest.TestCase):
    def setUp(self):
        self.config = patch.dict(
            app.app.config,
            TESTING=True,
            FEEDBACK_ENABLED=True,
            SECRET_KEY="feedback-test-only",
            FEEDBACK_TO="review@example.test",
            FEEDBACK_FROM="NutriCart <sender@example.test>",
            RESEND_API_KEY="re_test_fixture",
        )
        self.config.start()
        self.addCleanup(self.config.stop)
        self.client = app.app.test_client()
        self.token = self.client.get("/api/feedback").json["csrf_token"]
        self.headers = {"X-CSRF-Token": self.token, "Origin": "http://localhost"}
        self.sender = patch.object(app, "send_feedback")
        self.send = self.sender.start()
        self.addCleanup(self.sender.stop)

    def post(self, payload=None, **kwargs):
        return self.client.post(
            "/api/feedback",
            json=payload if payload is not None else {"rating": "positive", "comment": "Useful"},
            headers=kwargs.pop("headers", self.headers),
            **kwargs,
        )

    def test_release_disabled_even_with_valid_resend_configuration(self):
        with patch.dict(app.app.config, FEEDBACK_ENABLED=False):
            self.assertFalse(self.client.get("/api/feedback").json["enabled"])
            self.assertEqual(self.post().status_code, 503)
            self.send.assert_not_called()

    def test_missing_required_resend_setting_disables_configuration_and_post(self):
        for key in ("RESEND_API_KEY", "FEEDBACK_FROM", "FEEDBACK_TO"):
            with self.subTest(key=key), patch.dict(app.app.config, {key: ""}):
                response = self.client.get("/api/feedback")
                self.assertFalse(response.json["enabled"])
                self.assertEqual(set(response.json), {"enabled", "csrf_token"})
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                self.assertEqual(self.post().status_code, 503)
        self.send.assert_not_called()

    def test_success_only_after_transport_returns(self):
        self.send.return_value = "provider-message-id"
        response = self.post({"rating": "negative", "comment": " Less scrolling "})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json["delivered"])
        self.assertEqual(self.send.call_args.args[:2], ("negative", "Less scrolling"))
        with self.client.session_transaction() as session:
            self.assertNotIn("comment", session)
            self.assertNotIn("rating", session)

    def test_skip_and_written_comment_payloads_remain_supported(self):
        self.assertEqual(self.post({"rating": "positive"}).status_code, 200)
        self.assertEqual(self.send.call_args.args[:2], ("positive", ""))
        with self.client.session_transaction() as session:
            session.pop("feedback_sent_at", None)
        self.assertEqual(self.post({"rating": "negative", "comment": "Clear labels"}).status_code, 200)
        self.assertEqual(self.send.call_args.args[:2], ("negative", "Clear labels"))

    def test_transport_exception_logs_only_safe_resend_class_and_stage(self):
        self.send.side_effect = feedback_delivery.FeedbackDeliveryError(
            "send", error=requests.Timeout("private provider detail")
        )
        with patch.object(app.app.logger, "warning") as warning:
            result = self.post({"rating": "negative", "comment": "private feedback text"})
        self.assertEqual(result.status_code, 502)
        self.assertNotIn("delivered", result.json)
        self.assertEqual(result.json["error"], "We could not confirm delivery. Please try again later.")
        warning.assert_called_once_with(
            "feedback_delivery_failed provider=resend stage=%s exception=%s", "send", "Timeout"
        )
        logged = repr(warning.call_args)
        for value in (
            "private provider detail", "private feedback text", "re_test_fixture",
            "sender@example.test", "review@example.test", "Authorization", self.token,
        ):
            self.assertNotIn(value, result.text)
            self.assertNotIn(value, logged)

    def test_provider_rejection_logs_only_status(self):
        self.send.side_effect = feedback_delivery.FeedbackDeliveryError("send", status=422)
        with patch.object(app.app.logger, "warning") as warning:
            result = self.post()
        self.assertEqual(result.status_code, 502)
        warning.assert_called_once_with(
            "feedback_delivery_failed provider=resend stage=%s status=%s", "send", 422
        )

    def test_unexpected_transport_failure_logs_only_safe_class_and_stage(self):
        self.send.side_effect = RuntimeError("provider response with private data")
        with patch.object(app.app.logger, "warning") as warning:
            result = self.post({"rating": "positive", "comment": "do not log this"})
        self.assertEqual(result.status_code, 502)
        warning.assert_called_once_with(
            "feedback_delivery_failed provider=resend stage=send exception=%s", "RuntimeError"
        )
        logged = repr(warning.call_args)
        self.assertNotIn("provider response with private data", logged)
        self.assertNotIn("do not log this", logged)

    def test_csrf_and_origin_required(self):
        for headers in (
            {},
            {"X-CSRF-Token": self.token, "Origin": "https://other.example"},
            {"Origin": "http://localhost", "X-CSRF-Token": "wrong"},
        ):
            self.assertEqual(self.post(headers=headers).status_code, 403)
        self.send.assert_not_called()

    def test_rejects_metadata_invalid_rating_and_oversized_comment(self):
        for payload in (
            {"rating": "positive", "shoppingItems": []}, {"rating": []}, {"rating": "maybe"},
            {"rating": "negative", "comment": "x" * 1001}, {"rating": "positive", "comment": {}}, [],
        ):
            self.assertEqual(self.post(payload).status_code, 400)
        self.send.assert_not_called()

    def test_large_request_and_content_type_rejected(self):
        result = self.client.post(
            "/api/feedback", data='{"comment":"' + "x" * 5000 + '"}',
            content_type="application/json", headers=self.headers,
        )
        self.assertEqual(result.status_code, 413)
        self.assertEqual(
            self.client.post("/api/feedback", data="rating=positive", headers=self.headers).status_code, 415
        )
        self.send.assert_not_called()

    def test_session_cooldown(self):
        self.assertEqual(self.post().status_code, 200)
        cooldown = self.post()
        self.assertEqual(cooldown.status_code, 429)
        self.assertEqual(
            cooldown.json["error"],
            "Please wait a minute before sending another feedback response.",
        )
        self.assertEqual(self.send.call_count, 1)


class FeedbackResendFailureLoggingTests(unittest.TestCase):
    def test_provider_body_credentials_and_feedback_never_reach_logs(self):
        config = patch.dict(
            app.app.config,
            TESTING=True,
            FEEDBACK_ENABLED=True,
            SECRET_KEY="feedback-test-only",
            FEEDBACK_TO="recipient-private@example.test",
            FEEDBACK_FROM="NutriCart <sender-private@example.test>",
            RESEND_API_KEY="re_private_key",
        )
        with config:
            client = app.app.test_client()
            token = client.get("/api/feedback").json["csrf_token"]
            provider_response = MagicMock(status_code=422, text="private provider response body")
            with patch.object(feedback_delivery.requests, "post", return_value=provider_response), patch.object(
                app.app.logger, "warning"
            ) as warning:
                result = client.post(
                    "/api/feedback",
                    json={"rating": "negative", "comment": "private feedback text"},
                    headers={"X-CSRF-Token": token, "Origin": "http://localhost"},
                )
        self.assertEqual(result.status_code, 502)
        warning.assert_called_once_with(
            "feedback_delivery_failed provider=resend stage=%s status=%s", "send", 422
        )
        provider_response.json.assert_not_called()
        logged = repr(warning.call_args)
        for value in (
            "private provider response body", "re_private_key", "sender-private@example.test",
            "recipient-private@example.test", "Authorization", "private feedback text", token,
        ):
            self.assertNotIn(value, logged)
            self.assertNotIn(value, result.text)

class ResendTransportTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "FEEDBACK_ENABLED": True,
            "RESEND_API_KEY": "re_private_key",
            "FEEDBACK_FROM": "NutriCart <sender-private@example.test>",
            "FEEDBACK_TO": "recipient-private@example.test",
        }

    @staticmethod
    def accepted(identifier="resend-message-id"):
        response = MagicMock(status_code=200)
        response.json.return_value = {"id": identifier}
        return response

    def test_resend_request_contains_only_explicit_feedback(self):
        with patch.object(feedback_delivery.requests, "post", return_value=self.accepted()) as post:
            result = feedback_delivery.send_feedback("positive", "Example", self.config)
        self.assertEqual(result, "resend-message-id")
        post.assert_called_once()
        args, kwargs = post.call_args
        self.assertEqual(args, (feedback_delivery.RESEND_EMAILS_URL,))
        self.assertEqual(kwargs["timeout"], 5)
        self.assertEqual(kwargs["headers"], {
            "Authorization": "Bearer re_private_key", "Content-Type": "application/json"
        })
        self.assertEqual(kwargs["json"], {
            "from": "NutriCart <sender-private@example.test>",
            "to": ["recipient-private@example.test"],
            "subject": "NutriCart Feedback — Positive",
            "text": "Rating: Positive\n\nComment:\nExample",
        })
        self.assertEqual(set(kwargs["json"]), {"from", "to", "subject", "text"})

    def test_blank_comment_is_sent_without_added_metadata(self):
        with patch.object(feedback_delivery.requests, "post", return_value=self.accepted()) as post:
            feedback_delivery.send_feedback("negative", "", self.config)
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["subject"], "NutriCart Feedback — Negative")
        self.assertEqual(payload["text"], "Rating: Negative\n\nComment:\n(No comment)")

    def test_http_provider_rejection_fails_with_status_only(self):
        response = MagicMock(status_code=429, text="private provider response")
        with patch.object(feedback_delivery.requests, "post", return_value=response):
            with self.assertRaises(feedback_delivery.FeedbackDeliveryError) as raised:
                feedback_delivery.send_feedback("positive", "private feedback", self.config)
        self.assertEqual(raised.exception.stage, "send")
        self.assertEqual(raised.exception.status, 429)
        self.assertIsNone(raised.exception.exception_class)
        self.assertEqual(str(raised.exception), "")
        response.json.assert_not_called()

    def test_timeout_and_network_failures_are_safely_classified(self):
        for error in (requests.Timeout("secret"), requests.ConnectionError("secret")):
            with self.subTest(error=type(error).__name__), patch.object(
                feedback_delivery.requests, "post", side_effect=error
            ):
                with self.assertRaises(feedback_delivery.FeedbackDeliveryError) as raised:
                    feedback_delivery.send_feedback("positive", "private feedback", self.config)
                self.assertEqual(raised.exception.stage, "send")
                self.assertEqual(raised.exception.exception_class, type(error).__name__)
                self.assertIsNone(raised.exception.status)
                self.assertEqual(str(raised.exception), "")

    def test_malformed_provider_response_fails_closed(self):
        cases = (
            MagicMock(status_code=200, json=MagicMock(return_value={})),
            MagicMock(status_code=200, json=MagicMock(return_value={"id": ""})),
            MagicMock(status_code=200, json=MagicMock(return_value=[])),
            MagicMock(status_code=200, json=MagicMock(side_effect=ValueError("private body"))),
        )
        for response in cases:
            with self.subTest(response=response.json.side_effect or response.json.return_value), patch.object(
                feedback_delivery.requests, "post", return_value=response
            ):
                with self.assertRaises(feedback_delivery.FeedbackDeliveryError) as raised:
                    feedback_delivery.send_feedback("positive", "private feedback", self.config)
                self.assertEqual(raised.exception.stage, "response")
                self.assertEqual(str(raised.exception), "")

    def test_delivery_available_requires_resend_only(self):
        self.assertTrue(feedback_delivery.delivery_available(self.config))
        for changes in (
            {"FEEDBACK_ENABLED": False}, {"RESEND_API_KEY": ""}, {"FEEDBACK_FROM": ""},
            {"FEEDBACK_TO": ""}, {"FEEDBACK_FROM": "invalid"},
            {"FEEDBACK_TO": "a@example.test\nBcc:other@example.test"},
        ):
            with self.subTest(changes=changes):
                config = {**self.config, **changes}
                self.assertFalse(feedback_delivery.delivery_available(config))
        smtp_only = {
            "FEEDBACK_ENABLED": True, "SMTP_HOST": "smtp.example.test", "SMTP_PORT": "587",
            "SMTP_FROM": "sender@example.test", "SMTP_USERNAME": "user", "SMTP_PASSWORD": "password",
            "FEEDBACK_TO": "recipient-private@example.test",
        }
        self.assertFalse(feedback_delivery.delivery_available(smtp_only))


if __name__ == "__main__":
    unittest.main()
