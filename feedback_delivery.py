"""Synchronous feedback delivery through Resend HTTPS with no shopping metadata."""
import re

import requests


RESEND_EMAILS_URL = "https://api.resend.com/emails"
RESEND_STAGES = {"send", "response"}
_EMAIL = r"[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+"


class FeedbackDeliveryError(Exception):
    """Carry only safe provider failure metadata across layers."""

    def __init__(self, stage, error=None, status=None):
        super().__init__()
        self.stage = stage if stage in RESEND_STAGES else "send"
        self.exception_class = type(error).__name__ if error is not None else None
        self.status = int(status) if isinstance(status, int) else None


def _delivery_step(stage, operation):
    try:
        return operation()
    except FeedbackDeliveryError:
        raise
    except Exception as error:
        raise FeedbackDeliveryError(stage, error=error) from None


def _valid_address(value, allow_display_name=False):
    value = str(value or "").strip()
    if not value or len(value) > 320 or "\r" in value or "\n" in value:
        return False
    if re.fullmatch(_EMAIL, value):
        return True
    return bool(allow_display_name and re.fullmatch(rf"[^<>]{{1,100}}\s*<({_EMAIL})>", value))


def delivery_available(config):
    if config.get("FEEDBACK_ENABLED") is not True:
        return False
    return bool(
        str(config.get("RESEND_API_KEY") or "").strip()
        and _valid_address(config.get("FEEDBACK_FROM"), allow_display_name=True)
        and _valid_address(config.get("FEEDBACK_TO"))
    )


def send_feedback(rating, comment, config):
    """Send rating and optional comment; return only after Resend accepts it."""
    subject_rating = "Positive" if rating == "positive" else "Negative"
    response = _delivery_step(
        "send",
        lambda: requests.post(
            RESEND_EMAILS_URL,
            headers={
                "Authorization": "Bearer " + str(config["RESEND_API_KEY"]).strip(),
                "Content-Type": "application/json",
            },
            json={
                "from": str(config["FEEDBACK_FROM"]).strip(),
                "to": [str(config["FEEDBACK_TO"]).strip()],
                "subject": f"NutriCart Feedback — {subject_rating}",
                "text": "Rating: " + subject_rating + "\n\nComment:\n" + (comment or "(No comment)"),
            },
            timeout=5,
        ),
    )
    if response.status_code != 200:
        raise FeedbackDeliveryError("send", status=response.status_code)
    payload = _delivery_step("response", response.json)
    if not isinstance(payload, dict) or not isinstance(payload.get("id"), str) or not payload["id"].strip():
        raise FeedbackDeliveryError("response", error=ValueError())
    return payload["id"]
