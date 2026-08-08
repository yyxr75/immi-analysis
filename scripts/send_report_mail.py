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
import hashlib
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


JOB_FILE = "/tmp/report_job.json"


def fetch(env):
    """Stage 1: prove the shared secret works and collect the address."""
    job = call(env["WORKER_URL"], env["DISPATCH_SECRET"], "/pending",
               {"id": env["REPORT_ID"]})
    with open(JOB_FILE, "w") as f:
        json.dump(job, f)
    print("got job for", mask(job["to"]))


def send(env):
    """Stage 2: hand the mail to Gmail as the account owner."""
    with open(JOB_FILE) as f:
        job = json.load(f)
    msg = EmailMessage()
    msg["From"] = formataddr(("澳洲移民工具箱", env["MAIL_USER"]))
    msg["To"] = job["to"]
    msg["Subject"] = job["subject"]
    msg["Auto-Submitted"] = "auto-generated"      # keep vacation responders quiet
    msg.set_content(job["text"])
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=45) as s:
        s.starttls(context=ssl.create_default_context())
        s.login(env["MAIL_USER"], env["MAIL_PASS"])
        s.send_message(msg)
    print("sent to", mask(job["to"]))


def done(env):
    """Stage 3: one-shot record goes away only after the mail is out."""
    call(env["WORKER_URL"], env["DISPATCH_SECRET"], "/pending/done",
         {"id": env["REPORT_ID"]})
    print("marked done")


def fingerprint(env):
    """Stage 0: do the Worker and this runner hold the same shared secret?

    Compares a hash prefix, never the secret. Its own step so that a mismatch
    is distinguishable from every other reason /pending can fail."""
    fp = hashlib.sha256(env["DISPATCH_SECRET"].encode()).hexdigest()[:12]
    try:
        call(env["WORKER_URL"], "-", "/pending/fp", {"fp": fp})
    except urllib.error.HTTPError as e:
        if e.code == 409:
            sys.exit("DISPATCH_SECRET here does not match the Worker's")
        raise
    print("shared secret matches the Worker")


STAGES = {"fp": fingerprint, "fetch": fetch, "send": send, "done": done}

# Each stage checks only what it uses. Checking everything everywhere made a
# missing MAIL_PASS fail in the fetch step, which points the finger at the
# shared secret instead -- exactly the wrong place to look.
NEEDS = {
    "fp":    ["WORKER_URL", "DISPATCH_SECRET"],
    "fetch": ["WORKER_URL", "DISPATCH_SECRET", "REPORT_ID"],
    "send":  ["MAIL_USER", "MAIL_PASS"],
    "done":  ["WORKER_URL", "DISPATCH_SECRET", "REPORT_ID"],
}


def main():
    stage = sys.argv[1] if len(sys.argv) > 1 else ""
    if stage not in STAGES:
        sys.exit("usage: send_report_mail.py {%s}" % "|".join(STAGES))

    allv = ["WORKER_URL", "DISPATCH_SECRET", "MAIL_USER", "MAIL_PASS", "REPORT_ID"]
    env = {k: (os.environ.get(k) or "").strip() for k in allv}
    need = NEEDS[stage]
    # Google displays an App Password as four spaced groups. Pasted verbatim it
    # usually still works, but not always -- and the failure is an opaque
    # authentication error. Strip whitespace rather than let a space decide it.
    env["MAIL_PASS"] = "".join(env["MAIL_PASS"].split())
    missing = [k for k in need if not env[k]]
    if missing:
        sys.exit("missing env: " + ", ".join(missing))

    if "REPORT_ID" in need:
        rid = env["REPORT_ID"]
        if len(rid) != 32 or any(c not in "0123456789abcdef" for c in rid):
            sys.exit("bad REPORT_ID")

    try:
        STAGES[stage](env)
    except urllib.error.HTTPError as e:
        # 404 on fetch is ordinary: the record is one-shot and lives an hour, so
        # a replayed dispatch finds nothing. Not a failure worth alarming on.
        if stage == "fetch" and e.code == 404:
            print("nothing pending for this id (already sent, or expired)")
            sys.exit(0)
        raise RuntimeError("worker said %s: %s"
                           % (e.code, e.read()[:200].decode("utf-8", "replace")))


if __name__ == "__main__":
    # Report why, then still fail the job. A workflow log is not readable
    # without a token even on a public repo, so a failure that only lands there
    # is a report nobody knows went missing. This best-effort call needs the
    # shared secret to be right, so it cannot explain a secret mismatch -- for
    # that, read which named step failed, which the API does expose.
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        try:
            call(os.environ.get("WORKER_URL", ""), os.environ.get("DISPATCH_SECRET", ""),
                 "/pending/fail",
                 {"id": os.environ.get("REPORT_ID", ""),
                  "error": "%s in %s: %s" % (type(exc).__name__,
                                             sys.argv[1] if len(sys.argv) > 1 else "?", exc)})
        except Exception:
            pass
        raise
