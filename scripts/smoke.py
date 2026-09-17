#!/usr/bin/env python3
"""Local-only HTTP smoke test: no API key or external AI request is used."""
import datetime
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from zoneinfo import ZoneInfo

BASE = os.environ.get("RECALL_URL", "http://127.0.0.1:8080").rstrip("/")
if urllib.parse.urlparse(BASE).hostname not in ("localhost", "127.0.0.1", "::1"):
    raise SystemExit("Smoke tests only support localhost; they create and delete test data.")


def request(method, path, data=None, token=None, expected=200, content_type=None):
    headers = {}
    if token:
        headers["X-Learner-Token"] = token
    if data is not None and not isinstance(data, bytes):
        data = json.dumps(data).encode()
        content_type = "application/json"
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        response = urllib.request.urlopen(req, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    body = response.read()
    assert response.status == expected, (method, path, response.status, body.decode())
    return json.loads(body) if body else None


def text_pdf():
    # A small valid, original text fixture built without third-party PDF tooling.
    text = b"BT /F1 12 Tf 50 750 Td (Operating systems manage processes and memory.) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(text)).encode() + b" >>\nstream\n" + text + b"\nendstream",
    ]
    pdf = b"%PDF-1.4\n"
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf += str(i).encode() + b" 0 obj\n" + obj + b"\nendobj\n"
    xref = len(pdf)
    pdf += b"xref\n0 6\n0000000000 65535 f \n"
    pdf += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:])
    pdf += f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return pdf


def upload(token, content, expected):
    boundary = "RecallSmokeBoundary"
    data = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="smoke.pdf"\r\n'
        "Content-Type: application/pdf\r\n\r\n"
    ).encode() + content + f"\r\n--{boundary}--\r\n".encode()
    return request("POST", "/api/documents", data, token, expected,
                   f"multipart/form-data; boundary={boundary}")


def main():
    assert request("GET", "/actuator/health")["status"] == "UP"
    token = request("POST", "/api/learners", {}, expected=201)["token"]
    other = request("POST", "/api/learners", {}, expected=201)["token"]
    assert len(request("GET", "/api/tags", token=token)) in range(8, 13)
    document = upload(token, text_pdf(), 201)
    assert document["pageCount"] == 1
    upload(token, b"not a PDF", 400)
    assert request("GET", "/api/documents", token=other) == []
    # Sample job deliberately has NO documentId. No LIVE request is ever submitted.
    job = request("POST", "/api/jobs", {"mode": "DEMO"}, token, 202)
    request("GET", f'/api/jobs/{job["id"]}', token=other, expected=404)
    for _ in range(100):
        job = request("GET", f'/api/jobs/{job["id"]}', token=token)
        if job["status"] not in ("queued", "running"):
            break
        time.sleep(0.1)
    assert job["status"] == "succeeded", job
    quiz = request("GET", "/api/questions?view=quiz", token=token)
    assert quiz and all("correctIndex" not in q and "explanation" not in q for q in quiz)
    assert all(q["mode"] == "DEMO" and q["sourceStartPage"] is None for q in quiz)
    assert request("GET", "/api/questions?view=due", token=token) == []
    assert request("GET", "/api/questions?view=manage", token=other) == []
    question = request("GET", "/api/questions?view=manage", token=token)[0]
    qid = question["id"]
    request("GET", f"/api/questions/{qid}", token=other, expected=404)
    payload = {"questionId": qid, "selectedIndex": question["correctIndex"],
               "idempotencyKey": str(uuid.uuid4()), "version": question["version"]}
    first = request("POST", "/api/attempts", payload, token)
    second = request("POST", "/api/attempts", payload, token)
    assert first == second and first["correct"] and first["box"] == 1
    tomorrow = datetime.datetime.now(ZoneInfo("Asia/Seoul")).date() + datetime.timedelta(days=1)
    assert first["dueDate"] == str(tomorrow), first
    assert request("GET", "/api/dashboard", token=token)["attemptCount"] == 1
    payload["idempotencyKey"] = str(uuid.uuid4())
    payload["selectedIndex"] = (question["correctIndex"] + 1) % 4
    wrong = request("POST", "/api/attempts", payload, token)
    assert not wrong["correct"] and wrong["box"] == 1
    assert len(request("GET", "/api/questions?view=mistakes", token=token)) == 1
    edit = {key: question[key] for key in
            ("text", "options", "correctIndex", "tagId", "difficulty", "explanation", "version")}
    edit["text"] += " (edited)"
    request("PUT", f"/api/questions/{qid}", edit, token=other, expected=404)
    request("PUT", f"/api/questions/{qid}", edit, token=token)
    payload["idempotencyKey"] = str(uuid.uuid4())
    request("POST", "/api/attempts", payload, token=token, expected=409)
    assert request("GET", "/api/dashboard", token=token)["attemptCount"] == 0
    for item in quiz:
        request("DELETE", f'/api/questions/{item["id"]}', token=token, expected=204)
    assert request("GET", "/api/dashboard", token=token)["questionCount"] == 0
    print("PASS: text PDF upload, malformed PDF, async DEMO, isolation, hidden answers, "
          "quiz, idempotency, Seoul first-answer due date, mistakes, edit invalidation, delete")
    print("Creates isolated anonymous learners and upload/job metadata; no live AI used.")


if __name__ == "__main__":
    main()
