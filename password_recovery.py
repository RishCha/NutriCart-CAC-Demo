"""Bounded background delivery of password-reset mail; never log tokens or mail bodies."""

import logging
import queue
import smtplib
import ssl
import threading
from email.message import EmailMessage
from urllib.parse import urlsplit

from account_store import AccountStore

_jobs = queue.Queue(maxsize=32)
_worker_lock = threading.Lock()
_worker = None
_logger = logging.getLogger(__name__)


def reset_origin(config):
    value = str(config.get("PASSWORD_RESET_ORIGIN") or "").rstrip("/")
    parsed = urlsplit(value)
    local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path or not (parsed.scheme == "https" or (local and parsed.scheme == "http"))):
        return None
    return value


def delivery_available(config):
    return bool(reset_origin(config) and (callable(config.get("PASSWORD_RESET_SENDER"))
                or (config.get("SMTP_HOST") and config.get("SMTP_FROM"))))


def send_reset_mail(recipient, link, config):
    message = EmailMessage()
    message["Subject"] = "Reset your NutriCart password"
    message["From"] = config["SMTP_FROM"]
    message["To"] = recipient
    message.set_content(f"Set a new NutriCart password using this link:\n\n{link}\n\n"
                        "This link expires in 30 minutes and can be used once. "
                        "If you did not request it, you can ignore this email.")
    context = ssl.create_default_context()
    if config.get("SMTP_SSL"):
        connection = smtplib.SMTP_SSL(config["SMTP_HOST"], int(config["SMTP_PORT"]), timeout=10, context=context)
    else:
        connection = smtplib.SMTP(config["SMTP_HOST"], int(config["SMTP_PORT"]), timeout=10)
    with connection:
        if not config.get("SMTP_SSL"):
            connection.starttls(context=context)
        if config.get("SMTP_USERNAME"):
            connection.login(config["SMTP_USERNAME"], config.get("SMTP_PASSWORD") or "")
        connection.send_message(message)


def deliver_reset(database_path, email, config):
    try:
        if not delivery_available(config):
            return
        reset = AccountStore(database_path).create_password_reset(email)
        if reset:
            recipient, token = reset
            # Fragments are not sent in HTTP requests, keeping tokens out of access logs.
            link = reset_origin(config) + "/reset-password#token=" + token
            sender = config.get("PASSWORD_RESET_SENDER")
            if callable(sender):
                sender(recipient, link)
            else:
                send_reset_mail(recipient, link, config)
    except Exception:
        # Provider exceptions can contain credentials or message contents.
        _logger.warning("Password reset delivery failed; check mail configuration.")


def _run():
    while True:
        args = _jobs.get()
        try:
            deliver_reset(*args)
        finally:
            _jobs.task_done()


def queue_reset(database_path, email, config):
    global _worker
    if not delivery_available(config):
        return
    with _worker_lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_run, name="nutricart-reset-mail", daemon=True)
            _worker.start()
    try:
        _jobs.put_nowait((database_path, email, config))
    except queue.Full:
        _logger.warning("Password reset delivery queue is full.")
