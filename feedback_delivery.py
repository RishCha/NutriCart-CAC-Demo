"""Synchronous feedback mail: no queues, local storage, or shopping metadata."""
from email.message import EmailMessage
import re
import smtplib
import ssl


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
        connection = smtplib.SMTP_SSL(config["SMTP_HOST"], port, timeout=5, context=context)
    else:
        connection = smtplib.SMTP(config["SMTP_HOST"], port, timeout=5)
    with connection:
        if port != 465:
            connection.starttls(context=context)
        connection.login(config["SMTP_USERNAME"], config["SMTP_PASSWORD"])
        if connection.send_message(message):
            raise smtplib.SMTPException("Feedback recipient refused")
