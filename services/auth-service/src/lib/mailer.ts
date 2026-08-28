import nodemailer from "nodemailer";

/**
 * §9 lists transactional email as an accepted, unmitigated external
 * dependency. This module keeps that dependency swappable behind one
 * interface rather than hardwired, so a future provider change (or adding
 * a fallback) doesn't touch route logic.
 */
export async function sendOtpEmail(email: string, code: string): Promise<void> {
  const transport = process.env.OTP_TRANSPORT ?? "console";

  if (transport === "console") {
    // Local/dev default — no real email dependency needed to run Phase 1.
    console.log(`[otp] ${email} -> ${code} (valid 10 min)`);
    return;
  }

  if (transport === "smtp") {
    const smtp = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await smtp.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: "Your login code",
      text: `Your login code is ${code}. It expires in 10 minutes.`,
    });
    return;
  }

  throw new Error(`Unknown OTP_TRANSPORT: ${transport}`);
}
