"""Feedback delivery contracts; all mail transport is mocked."""
import unittest
from unittest.mock import patch, MagicMock
import app
import feedback_delivery

class FeedbackTests(unittest.TestCase):
    def setUp(self):
        self.config = patch.dict(app.app.config, TESTING=True, FEEDBACK_ENABLED=True, SECRET_KEY="feedback-test-only",
            FEEDBACK_TO="review@example.test", SMTP_HOST="smtp.example.test", SMTP_PORT="587",
            SMTP_FROM="demo@example.test", SMTP_USERNAME="fixture", SMTP_PASSWORD="fixture")
        self.config.start(); self.addCleanup(self.config.stop)
        self.client = app.app.test_client()
        self.token = self.client.get("/api/feedback").json["csrf_token"]
        self.headers = {"X-CSRF-Token":self.token,"Origin":"http://localhost"}
        self.sender = patch.object(app,"send_feedback")
        self.send = self.sender.start(); self.addCleanup(self.sender.stop)

    def post(self, payload=None, **kwargs):
        return self.client.post("/api/feedback",json=payload if payload is not None else {"rating":"positive","comment":"Useful"},headers=kwargs.pop("headers",self.headers),**kwargs)

    def test_release_disabled_even_with_valid_smtp_configuration(self):
        with patch.dict(app.app.config, FEEDBACK_ENABLED=False):
            self.assertFalse(self.client.get("/api/feedback").json["enabled"])
            self.assertEqual(self.post().status_code, 503)
            self.send.assert_not_called()

    def test_missing_destination_disables_configuration_and_post(self):
        with patch.dict(app.app.config, FEEDBACK_TO=""):
            response=self.client.get("/api/feedback")
            self.assertFalse(response.json["enabled"])
            self.assertEqual(set(response.json),{"enabled","csrf_token"})
            self.assertEqual(response.headers["Cache-Control"],"no-store")
            self.assertEqual(self.post().status_code,503)
            self.send.assert_not_called()

    def test_success_only_after_transport_returns(self):
        response=self.post({"rating":"negative","comment":" Less scrolling "})
        self.assertEqual(response.status_code,200)
        self.assertTrue(response.json["delivered"])
        self.assertEqual(self.send.call_args.args[:2],("negative","Less scrolling"))
        with self.client.session_transaction() as session:
            self.assertNotIn("comment",session)
            self.assertNotIn("rating",session)

    def test_comment_optional(self):
        self.assertEqual(self.post({"rating":"positive"}).status_code,200)
        self.assertEqual(self.send.call_args.args[1],"")

    def test_transport_failure_never_claims_success_or_leaks_error(self):
        self.send.side_effect=RuntimeError("sensitive-provider-error")
        result=self.post()
        self.assertEqual(result.status_code,502)
        self.assertNotIn("delivered",result.json)
        self.assertNotIn("sensitive-provider-error",result.text)

    def test_csrf_and_origin_required(self):
        for headers in ({},{"X-CSRF-Token":self.token,"Origin":"https://other.example"},{"Origin":"http://localhost","X-CSRF-Token":"wrong"}):
            self.assertEqual(self.post(headers=headers).status_code,403)
        self.send.assert_not_called()

    def test_rejects_metadata_invalid_rating_and_oversized_comment(self):
        for payload in ({"rating":"positive","shoppingItems":[]},{"rating":[]},{"rating":"maybe"},{"rating":"negative","comment":"x"*1001},{"rating":"positive","comment":{}},[]):
            self.assertEqual(self.post(payload).status_code,400)
        self.send.assert_not_called()

    def test_large_request_and_content_type_rejected(self):
        result=self.client.post("/api/feedback",data='{"comment":"'+'x'*5000+'"}',content_type="application/json",headers=self.headers)
        self.assertEqual(result.status_code,413)
        self.assertEqual(self.client.post("/api/feedback",data="rating=positive",headers=self.headers).status_code,415)
        self.send.assert_not_called()

    def test_session_cooldown(self):
        self.assertEqual(self.post().status_code,200)
        self.assertEqual(self.post().status_code,429)
        self.assertEqual(self.send.call_count,1)

    def test_tls_mail_contains_only_explicit_feedback(self):
        with patch.object(feedback_delivery.smtplib,"SMTP") as smtp:
            connection=smtp.return_value
            connection.send_message.return_value={}
            feedback_delivery.send_feedback("positive","Example",app.app.config)
            connection.starttls.assert_called_once()
            connection.login.assert_called_once_with("fixture","fixture")
            msg=connection.send_message.call_args.args[0]
            self.assertEqual(msg.get_content(),"Rating: positive\n\nComment:\nExample\n")
            self.assertEqual(msg["To"],"review@example.test")
            self.assertNotIn("Reply-To",msg)
            self.assertEqual(smtp.call_args.kwargs["timeout"],5)

    def test_ssl_and_recipient_refusal(self):
        with patch.dict(app.app.config,SMTP_PORT="465"),patch.object(feedback_delivery.smtplib,"SMTP_SSL") as smtp:
            smtp.return_value.send_message.return_value={"review@example.test":(550,"refused")}
            with self.assertRaises(feedback_delivery.smtplib.SMTPException):
                feedback_delivery.send_feedback("positive","",app.app.config)
            smtp.return_value.starttls.assert_not_called()

    def test_invalid_configuration_disabled(self):
        for changes in ({"SMTP_PORT":"bad"},{"SMTP_PORT":"25"},{"SMTP_PASSWORD":""},{"FEEDBACK_TO":"a@example.test\nBcc:other@example.test"}):
            with patch.dict(app.app.config,**changes):
                self.assertFalse(feedback_delivery.delivery_available(app.app.config))

if __name__ == "__main__":
    unittest.main()
