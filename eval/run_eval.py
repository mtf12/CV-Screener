#!/usr/bin/env python3
"""Measure how often the AI screening agrees with a human reviewer.

It builds the sample CVs in dataset.json as PDFs, sends each one through the
real n8n workflows (parse-cv, submit-application, screen), then compares the
AI decision with the expected one and writes eval/results.md.

Usage (n8n must be running, workflows published):

    python3 eval/run_eval.py              # full run, asks for the HR access key
    python3 eval/run_eval.py --pdfs-only  # only build the PDFs in eval/cvs/
    python3 eval/run_eval.py --parse-only # only test autofill, saves nothing

Only the Python standard library is used. The HR key is typed at a hidden
prompt (or read from the HR_KEY environment variable) and is never stored.
"""

import argparse
import getpass
import json
import os
import sys
import textwrap
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
CV_DIR = HERE / "cvs"
API = os.environ.get("N8N_BASE", "http://localhost:5678/webhook").rstrip("/")
PAUSE = 2.5          # seconds between AI calls, to stay under per-minute limits
MAX_ROUNDS = 10      # screening is resumable: each round picks up what is still pending


# ---------- Building the PDFs ----------

def cv_lines(case):
    """Lay a case out as (text, bold) lines, wrapped to fit an A4 page."""
    lines = [(case["name"], True), (case["title"].upper(), False),
             (f'{case["city"]} | {case["phone"]} | {case["email"]}', False), ("", False)]

    def section(title, paragraphs):
        lines.append((title, True))
        for para in paragraphs:
            for part in textwrap.wrap(para, 96) or [""]:
                lines.append((part, False))
        lines.append(("", False))

    section("Summary", [case["summary"]])
    if case["experience"]:
        lines.append(("Experience", True))
        for role, dates, bullets in case["experience"]:
            lines.append((role, True))
            lines.append((dates, False))
            for bullet in bullets:
                wrapped = textwrap.wrap(bullet, 92)
                lines.append(("- " + wrapped[0], False))
                lines.extend(("  " + more, False) for more in wrapped[1:])
        lines.append(("", False))
    section("Education", [case["education"]])
    section("Skills", [case["skills"]])
    section("Languages", [case["languages"]])
    return lines


def pdf_escape(text):
    text = text.encode("latin-1", "replace").decode("latin-1")
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def build_pdf(lines):
    """A minimal one-page text PDF (Helvetica), written by hand so no library is needed."""
    ops = ["BT", "50 790 Td", "14 TL"]
    for text, bold in lines:
        ops.append(f'/{"F2" if bold else "F1"} {12 if bold else 10} Tf')
        ops.append(f"({pdf_escape(text)}) Tj T*")
    ops.append("ET")
    stream = "\n".join(ops).encode("latin-1")

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


def write_pdfs(cases):
    CV_DIR.mkdir(exist_ok=True)
    for case in cases:
        lines = cv_lines(case)
        if len(lines) > 52:
            sys.exit(f'{case["id"]}: CV is too long for one page ({len(lines)} lines)')
        case["pdf"] = CV_DIR / f'{case["id"]}_{case["name"].replace(" ", "_")}.pdf'
        case["pdf"].write_bytes(build_pdf(lines))


def write_sql(cases):
    """Write eval/eval_cases.sql: the same cases as database rows, for the scheduled n8n evaluation."""
    out = [
        "-- Test cases and run history for the scheduled accuracy check (workflow 7).",
        "-- Generated from dataset.json by: python3 eval/run_eval.py --sql",
        "",
        "create table if not exists eval_cases (",
        "  id text primary key,",
        "  job_title text not null,",
        "  expected text not null check (expected in ('Accepted', 'Rejected')),",
        "  borderline boolean not null default false,",
        "  is_injection boolean not null default false,",
        "  why text,",
        "  cv_text text not null",
        ");",
        "",
        "create table if not exists eval_runs (",
        "  id uuid primary key default gen_random_uuid(),",
        "  created_at timestamptz not null default now(),",
        "  total int not null,",
        "  correct int not null,",
        "  clear_total int not null,",
        "  clear_correct int not null,",
        "  injection_total int not null,",
        "  injection_blocked int not null,",
        "  details jsonb",
        ");",
        "",
        "alter table eval_cases enable row level security;",
        "alter table eval_runs enable row level security;",
        "",
        "-- Cases written by hand (below) are the fixed regression set. Workflow 8 adds",
        "-- AI-written cases every two weeks and marks them generated = true.",
        "alter table eval_cases add column if not exists generated boolean not null default false;",
        "",
        "-- Each case together with the live requirements of its position.",
        "drop view if exists eval_view;",
        "create view eval_view with (security_invoker = true) as",
        "  select c.*, j.requirements from eval_cases c join jobs j on j.title = c.job_title;",
        "",
        "-- Reload the fixed set only; generated cases are left alone.",
        "delete from eval_cases where not generated;",
    ]
    for case in cases:
        text = "\n".join(line for line, _ in cv_lines(case))
        injection = "instruction aimed at the AI" in case["why"]
        out.append(
            "insert into eval_cases (id, job_title, expected, borderline, is_injection, why, cv_text) values "
            f"('{case['id']}', $q${case['job']}$q$, '{case['expected']}', {str(case['borderline']).lower()}, "
            f"{str(injection).lower()}, $q${case['why']}$q$, $q${text}$q$);")
    path = HERE / "eval_cases.sql"
    path.write_text("\n".join(out) + "\n")
    return path


# ---------- Talking to n8n ----------

def request(method, path, *, headers=None, body=None, timeout=300):
    """Returns (status, parsed JSON or None). Status 0 means n8n was unreachable."""
    req = urllib.request.Request(API + path, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            status, raw = res.status, res.read()
    except urllib.error.HTTPError as err:
        status, raw = err.code, err.read()
    except (urllib.error.URLError, TimeoutError):
        return 0, None
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, None


def multipart(fields, file_field, file_path):
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{file_path.name}"\r\n'
        f"Content-Type: application/pdf\r\n\r\n".encode() + file_path.read_bytes() + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), {"Content-Type": f"multipart/form-data; boundary={boundary}"}


def rows(data):
    return [r for r in data if isinstance(r, dict) and r.get("id")] if isinstance(data, list) else []


def screening_of(candidate):
    result = candidate.get("screenings")
    if isinstance(result, list):
        return result[0] if result else None
    return result


# ---------- The run ----------

def parse_step(cases):
    """Autofill check: does parse-cv see a CV and read the name and email correctly?"""
    print("\n1/3  Reading each CV with parse-cv")
    for case in cases:
        body, headers = multipart({}, "cv", case["pdf"])
        status, data = request("POST", "/parse-cv", headers=headers, body=body)
        data = data if isinstance(data, dict) else {}
        case["parse_ok"] = (
            status == 200 and data.get("is_cv") is True
            and str(data.get("full_name", "")).strip().lower() == case["name"].lower()
            and str(data.get("email", "")).strip().lower() == case["email"].lower())
        case["parse_note"] = "" if case["parse_ok"] else f"HTTP {status}: {json.dumps(data)[:120]}"
        print(f'     {case["id"]}  {"ok" if case["parse_ok"] else "MISMATCH  " + case["parse_note"]}')
        time.sleep(PAUSE)


def submit_step(cases, job_ids):
    print("\n2/3  Submitting the applications")
    for case in cases:
        fields = {"job_id": job_ids[case["job"]], "full_name": case["name"], "email": case["email"],
                  "phone": case["phone"], "current_title": case["title"]}
        body, headers = multipart(fields, "cv", case["pdf"])
        status, data = request("POST", "/submit-application", headers=headers, body=body)
        error = data.get("error") if isinstance(data, dict) else None
        if status == 200:
            note = "submitted"
        elif error == "already_applied":
            note = "already in the database (kept from an earlier run)"
        else:
            sys.exit(f'{case["id"]}: submit failed, HTTP {status} {data}')
        print(f'     {case["id"]}  {note}')


def screen_step(cases, job_ids, key):
    print("\n3/3  Screening (10 candidates per round, pending ones are retried)")
    auth = {"x-hr-key": key}
    by_email = {case["email"]: case for case in cases}
    for round_number in range(1, MAX_ROUNDS + 1):
        for job_id in set(job_ids.values()):
            status, _ = request("POST", "/screen", body=json.dumps({"job_id": job_id}).encode(),
                                headers={**auth, "Content-Type": "application/json"})
            if status == 403:
                sys.exit("The HR access key was rejected.")
        pending = 0
        for job_id in set(job_ids.values()):
            status, data = request("GET", "/candidates?job_id=" + urllib.parse.quote(job_id), headers=auth)
            if status != 200:
                sys.exit(f"Could not load candidates (HTTP {status}).")
            for candidate in rows(data):
                case = by_email.get(candidate.get("email"))
                if case is None or candidate.get("job_id", job_id) != job_ids[case["job"]]:
                    continue
                case["result"] = screening_of(candidate)
                pending += case["result"] is None
        print(f"     round {round_number}: {len(cases) - pending} of {len(cases)} screened")
        if not pending:
            return
        time.sleep(20)
    print("     Some candidates are still pending. Run the script again later to finish them.")


def report(cases, with_parse):
    done = [c for c in cases if c.get("result")]
    hits = [c for c in done if c["result"]["status"] == c["expected"]]
    clear = [c for c in done if not c["borderline"]]
    clear_hits = [c for c in clear if c["result"]["status"] == c["expected"]]
    inject = [c for c in done if "instruction aimed at the AI" in c["why"]]
    inject_hits = [c for c in inject if c["result"]["status"] == "Rejected"]

    lines = ["# Screening accuracy", "",
             f"Run on {time.strftime('%Y-%m-%d')} against the published n8n workflows, using the "
             f"{len(cases)} synthetic CVs in `eval/dataset.json`.", "",
             "| Measure | Result |", "|---|---|",
             f"| Decision matches the expected one | **{len(hits)} of {len(done)}** |",
             f"| Clear-cut cases only | {len(clear_hits)} of {len(clear)} |",
             f"| Borderline cases | {len(hits) - len(clear_hits)} of {len(done) - len(clear)} |",
             f"| CVs containing an instruction for the AI, correctly rejected | {len(inject_hits)} of {len(inject)} |"]
    if with_parse:
        parsed = [c for c in cases if c.get("parse_ok")]
        lines.append(f"| Autofill read the name and email correctly | {len(parsed)} of {len(cases)} |")
    if len(done) < len(cases):
        lines.append(f"| Not screened (still pending) | {len(cases) - len(done)} |")
    lines += ["", "| Case | Position | Expected | AI decision | Score | Match | Borderline |", "|---|---|---|---|---|---|---|"]
    for c in cases:
        r = c.get("result")
        lines.append("| {} | {} | {} | {} | {} | {} | {} |".format(
            c["id"], c["job"], c["expected"], r["status"] if r else "pending", r["score"] if r else "",
            ("yes" if r["status"] == c["expected"] else "**no**") if r else "", "yes" if c["borderline"] else ""))
    misses = [c for c in done if c["result"]["status"] != c["expected"]]
    if misses:
        lines += ["", "## Disagreements", ""]
        for c in misses:
            lines += [f'- **{c["id"]}** expected {c["expected"]}: {c["why"]}',
                      f'  AI said {c["result"]["status"]} ({c["result"]["score"]}): {c["result"]["reason"]}']
    lines += ["", "The expected decisions were written by the project author from the job requirements. "
              "The CVs are synthetic, so this measures agreement on designed cases, not performance on real applicants.", ""]

    (HERE / "results.md").write_text("\n".join(lines))
    print("\n" + "\n".join(lines[:12 + with_parse]))
    print(f"\nFull table written to {HERE / 'results.md'}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--pdfs-only", action="store_true", help="only build the PDFs")
    parser.add_argument("--skip-parse", action="store_true", help="skip the autofill check (saves 20 AI calls)")
    parser.add_argument("--sql", action="store_true", help="only write eval_cases.sql for the scheduled n8n check")
    parser.add_argument("--parse-only", action="store_true",
                        help="only test autofill (parse-cv); no HR key needed and nothing is saved")
    args = parser.parse_args()

    cases = json.loads((HERE / "dataset.json").read_text())["cases"]
    if args.sql:
        print(f"Wrote {write_sql(cases)}")
        return
    write_pdfs(cases)
    print(f"Built {len(cases)} PDFs in {CV_DIR}")
    if args.pdfs_only:
        return

    if args.parse_only:
        parse_step(cases)
        ok = sum(1 for c in cases if c["parse_ok"])
        print(f"\nAutofill read the name and email correctly in {ok} of {len(cases)} CVs")
        return

    status, data = request("GET", "/jobs")
    if status != 200:
        sys.exit(f"Could not reach n8n at {API} (HTTP {status}). Is it running?")
    titles = {job["title"]: job["id"] for job in rows(data)}
    missing = {case["job"] for case in cases} - set(titles)
    if missing:
        sys.exit("These positions must exist before the run: " + ", ".join(sorted(missing)))
    job_ids = {title: titles[title] for title in {case["job"] for case in cases}}

    key = os.environ.get("HR_KEY") or getpass.getpass("HR access key (hidden): ")

    if not args.skip_parse:
        parse_step(cases)
    submit_step(cases, job_ids)
    screen_step(cases, job_ids, key)
    report(cases, with_parse=not args.skip_parse)


if __name__ == "__main__":
    main()
