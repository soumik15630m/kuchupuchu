import os
import smtplib
from email.mime.text import MIMEText

# §9 lists transactional email as an accepted, unmitigated external
# dependency. This module keeps that dependency swappable behind one
# interface rather than hardwired, so a future provider change (or adding
# a fallback) doesn't touch route logic.


def send_otp_email(email: str, code: str) -> None:
    transport = os.environ.get("OTP_TRANSPORT", "console")

    if transport == "console":
        # Local/dev default — no real email dependency needed to run Phase 1.
        print(f"[otp] {email} -> {code} (valid 10 min)")
        return

    if transport == "smtp":
        msg = MIMEText(f"Your login code is {code}. It expires in 10 minutes.")
        msg["Subject"] = "Your login code"
        msg["From"] = os.environ["SMTP_FROM"]
        msg["To"] = email

        with smtplib.SMTP(os.environ["SMTP_HOST"], int(os.environ.get("SMTP_PORT", 587))) as smtp:
            smtp.starttls()
            smtp.login(os.environ["SMTP_USER"], os.environ["SMTP_PASS"])
            smtp.send_message(msg)
        return

    raise ValueError(f"Unknown OTP_TRANSPORT: {transport}")
