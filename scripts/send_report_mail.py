"""Mail one report link, from a GitHub Actions runner.

Why here and not in the Worker: Cloudflare Workers have no SMTP path, and an
HTTP mail API would demand a verified sending domain. A runner can talk to
smtp.gmail.com and authenticate as the account owner -- at which point the mail
genuinely originates from Google on that account's behalf, so SPF and DKIM
align and it lands like any other mail that account sends.

The recipient address is fetched from the Worker rather than passed in on the
dispatch payload: this repo is public, and so is everything attached to a
workflow run. For the same reason nothing here ever prints a full address.

env:
  WORKER_URL        https://...workers.dev
  DISPATCH_SECRET   shared with the Worker
  MAIL_USER         the Gmail address doing the sending
  MAIL_PASS         a Gmail App Password (not the account password)
  REPORT_ID         32 hex chars, from the dispatch payload
"""
import json
import os
import smtplib
import ssl
import sys
import urllib.error
import urllib.request
from email.message import EmailMessage
from email.utils import formataddr

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587


def mask(addr):
    """t***@example.com -- enough to debug a run, not enough to harvest."""
    try:
        local, domain = addr.split("@", 1)
    except ValueError:
        return "<malformed>"
    return (local[0] if local else "") + "***@" + domain


def call(url, secret, path, payload):
    req = urllib.request.Request(
        url.rstrip("/") + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + secret},
        method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main():
    need = ["WORKER_URL", "DISPATCH_SECRET", "MAIL_USER", "MAIL_PASS", "REPORT_ID"]
    env = {k: (os.environ.get(k) or "").strip() for k in need}
    missing = [k for k in need if not env[k]]
    if missing:
        sys.exit("missing env: " + ", ".join(missing))

    rid = env["REPORT_ID"]
    if len(rid) != 32 or any(c not in "0123456789abcdef" for c in rid):
        sys.exit("bad REPORT_ID")

    try:
        job = call(env["WORKER_URL"], env["DISPATCH_SECRET"], "/pending", {"id": rid})
    except urllib.error.HTTPError as e:
        # 404 is the ordinary case for a replayed or expired dispatch: the
        # record is one-shot and lives an hour. Not a failure worth alarming on.
        if e.code == 404:
            print("nothing pending for this id (already sent, or expired)")
            return
        sys.exit("worker said %s: %s" % (e.code, e.read()[:200]))

    to = job["to"]
    msg = EmailMessage()
    msg["From"] = formataddr(("澳洲移民工具箱", env["MAIL_USER"]))
    msg["To"] = to
    msg["Subject"] = job["subject"]
    msg["Auto-Submitted"] = "auto-generated"      # keep vacation responders quiet
    msg.set_content(job["text"])

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=45) as s:
        s.starttls(context=ssl.create_default_context())
        s.login(env["MAIL_USER"], env["MAIL_PASS"])
        s.send_message(msg)
    print("sent to", mask(to))

    # Only now drop the record; a crash before this leaves it for a retry rather
    # than losing the report someone is waiting for.
    call(env["WORKER_URL"], env["DISPATCH_SECRET"], "/pending/done", {"id": rid})


if __name__ == "__main__":
    main()
