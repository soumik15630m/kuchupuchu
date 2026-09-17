import logging
import os
import smtplib
import ssl
from email.mime.text import MIMEText

logger = logging.getLogger(__name__)

# smtplib has no default timeout; an unresponsive provider otherwise
# holds a threadpool worker indefinitely.
SMTP_TIMEOUT_SECONDS = 10

# §9 lists transactional email as an accepted, unmitigated external
# dependency. This module keeps that dependency swappable behind one
# interface rather than hardwired, so a future provider change (or adding
# a fallback) doesn't touch route logic.


VALID_TRANSPORTS = ("console", "smtp")


def validate_transport() -> None:
    """Fails startup unless OTP_TRANSPORT is explicitly set.

    This defaulted to "console", which prints every login code to
    stdout and sends no email -- a deployment that forgot to set it
    looked healthy while anyone with log access could authenticate as
    any member. There is no safe default, so there isn't one.
    """
    transport = os.environ.get("OTP_TRANSPORT")
    if transport not in VALID_TRANSPORTS:
        raise RuntimeError(
            f"OTP_TRANSPORT must be explicitly set to one of {VALID_TRANSPORTS}, got {transport!r}"
        )
    if transport == "smtp":
        missing = [k for k in ("SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM") if not os.environ.get(k)]
        if missing:
            raise RuntimeError(f"OTP_TRANSPORT=smtp but {', '.join(missing)} not set; refusing to start")
    else:
        logger.warning(
            "OTP_TRANSPORT=console: login codes are printed to stdout and NOT emailed. "
            "Local development only -- anyone who can read this process's logs can log in as any member."
        )


def send_otp_email(email: str, code: str) -> None:
    transport = os.environ.get("OTP_TRANSPORT")

    if transport == "console":
        # Local/dev only -- see validate_transport, which refuses to start
        # unless this was chosen deliberately.
        print(f"[otp] {email} -> {code} (valid 10 min)")
        return

    if transport == "smtp":
        msg = MIMEText(f"Your login code is {code}. It expires in 10 minutes.")
        msg["Subject"] = "Your login code"
        msg["From"] = os.environ["SMTP_FROM"]
        msg["To"] = email

        with smtplib.SMTP(
            os.environ["SMTP_HOST"],
            int(os.environ.get("SMTP_PORT", 587)),
            timeout=SMTP_TIMEOUT_SECONDS,
        ) as smtp:
            # Explicit verifying context rather than relying on the
            # default: this carries a login password and a live OTP.
            smtp.starttls(context=ssl.create_default_context())
            smtp.login(os.environ["SMTP_USER"], os.environ["SMTP_PASS"])
            smtp.send_message(msg)
        return

    raise ValueError(f"Unknown OTP_TRANSPORT: {transport}")
