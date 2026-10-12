"""Synchronous feedback mail: no queues, local storage, or shopping metadata."""
from email.message import EmailMessage
import re
import smtplib
import ssl


SMTP_STAGES = {"smtp_connect", "smtp_starttls", "smtp_login", "smtp_send"}


class FeedbackDeliveryError(Exception):
    """Carry only a safe transport stage and exception type across layers."""

    def __init__(self, stage, error):
        super().__init__()
        self.stage = stage if stage in SMTP_STAGES else "smtp_send"
        self.exception_class = type(error).__name__


def _delivery_step(stage, operation):
    try:
        return operation()
    except FeedbackDeliveryError:
        raise
    except Exception as error:
        raise FeedbackDeliveryError(stage, error) from None


def delivery_available(config):
    if config.get("FEEDBACK_ENABLED") is not True:
        return False
    address = r"[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+"
    try:
        port = int(config.get("SMTP_PORT", 0))
    except (TypeError, ValueError):
        return False
    return bool(port in (465, 587) and config.get("SMTP_HOST")
                and config.get("SMTP_USERNAME") and config.get("SMTP_PASSWORD")
                and all(re.fullmatch(address, str(config.get(key) or ""))
                        for key in ("SMTP_FROM", "FEEDBACK_TO")))


def send_feedback(rating, comment, config):
    message = EmailMessage()
    message["Subject"] = "NutriCart user feedback"
    message["From"] = config["SMTP_FROM"]
    message["To"] = config["FEEDBACK_TO"]
    message.set_content("Rating: " + rating + "\n\nComment:\n" + (comment or "(No comment)"))
    context = ssl.create_default_context()
    port = int(config["SMTP_PORT"])
    if port == 465:
        connection = _delivery_step(
            "smtp_connect",
            lambda: smtplib.SMTP_SSL(config["SMTP_HOST"], port, timeout=5, context=context),
        )
    else:
        connection = _delivery_step(
            "smtp_connect", lambda: smtplib.SMTP(config["SMTP_HOST"], port, timeout=5)
        )
    try:
        if port != 465:
            _delivery_step("smtp_starttls", lambda: connection.starttls(context=context))
        _delivery_step(
            "smtp_login",
            lambda: connection.login(config["SMTP_USERNAME"], config["SMTP_PASSWORD"]),
        )

        def send_message():
            refused = connection.send_message(message)
            if refused:
                raise smtplib.SMTPRecipientsRefused(refused)

        _delivery_step("smtp_send", send_message)
    finally:
        try:
            connection.quit()
        except Exception:
            # Delivery has already succeeded or raised a safely classified failure.
            pass
