#!/usr/bin/env python3
"""Manual MCC frontend controller. Standard library only; no backend operations.

Preparation is not release authorization. Never retry a failed/uncertain POST.
The source payload consists only of the immutable apps/web Git blobs. It contains
no gitSource, gitMetadata, projectSettings, environment values, or backend files.
"""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CANDIDATE = "c3e6f4ea4cc39e15e6c3cc9bca6422d1b81f2217"
WEB_TREE = "9c0af59fd5689fc079647d368fee9f1642ba604c"
MANIFEST_SHA256 = "bdc3a9a11a6c6876b147f6b0e4491c6531f99f80c2cc832b8b6d2907bed421cd"
REPOSITORY = "nicci-afk/comminicationstation"
INSPECT_BRANCH = "mcc-release/frontend-preflight-c3e6f4e"
CI_RUN = "37054086235"
CI_JOBS = {"Phase 1 + Phase 1.5 safety suite", "Phase 3B Focus and capture candidate", "Phase 3B isolated Supabase and browser"}
PROJECT = "prj_kypK3A8FOS9XdLadXmAr6pUHW7hA"
TEAM = "team_VyloIj0OJAb3IN63CmPGvqeG"
BASELINE_ID = "dpl_G4Ju1NMyeA6VMyGWkEmmusxNpjb2"
BASELINE_CREATED_AT = 1790855758615
BASELINE_SHA = "37754b86f6ce910fe06903624d55cea03745ed1c"
DOMAINS = ["message-command-center-iota.vercel.app"]
BASELINE_URL = "message-command-center-2eg3fq85d-agentedge.vercel.app"
BASELINE_BRANCH_ALIAS = "message-command-center-git-37754b86f6ce910fe06-3ad478-agentedge.vercel.app"
RELEASE_AUTHORIZATION = "NOT_GRANTED"
ROLLBACK_AUTHORIZATION = "NOT_GRANTED"
EXPECTED_SETTINGS = {"rootDirectory": ".", "framework": "vite", "buildCommand": "AUTO", "installCommand": "AUTO", "outputDirectory": "AUTO", "nodeVersion": "24.x", "gitConnection": None}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def project_settings(project, auto_assignment=True):
    require(project.get("id") == PROJECT and project.get("accountId") == TEAM and project.get("name") == "message-command-center", "Wrong project/team")
    # Dashboard independently verified each disabled override. Only documented
    # absence/null/empty encodings of that default are normalized, never strings.
    settings = {key: project.get(key) for key in ("framework", "nodeVersion")}
    settings["rootDirectory"] = "." if project.get("rootDirectory") in (None, "") else project["rootDirectory"]
    for key in ("buildCommand", "installCommand", "outputDirectory"):
        settings[key] = "AUTO" if project.get(key) is None else project[key]
    settings["gitConnection"] = project.get("link")
    require(settings == EXPECTED_SETTINGS, "Build/runtime/Git settings drift; do not change settings automatically")
    require(project.get("autoAssignCustomDomains") is auto_assignment, "Production auto-assignment differs or is not explicitly reported")
    crons = project.get("crons")
    require(isinstance(crons, dict) and crons.get("definitions") == [], "Zero Vercel cron definitions not explicitly established")
    require(not crons.get("disabledAt"), "Vercel cron feature state changed")
    return settings


def domain_inventory(response):
    require(isinstance(response.get("pagination"), dict) and response["pagination"].get("next") is None, "Domain inventory pagination unknown/incomplete")
    domains = response.get("domains")
    require(isinstance(domains, list) and sorted(d.get("name", "") for d in domains) == DOMAINS, "Project domain inventory changed")
    for domain in domains:
        require(domain.get("projectId") == PROJECT and domain.get("verified") is True, "Wrong/unverified domain")
        require(domain.get("redirect") is None and domain.get("gitBranch") is None and domain.get("customEnvironmentId") is None, "Redirect/branch/custom environment domain is out of scope")


def deployment_identity(deployment, expected_id, candidate=False, ready=True):
    require(deployment.get("id") == expected_id and deployment.get("projectId") == PROJECT, "Deployment identity/project differs")
    require(deployment.get("target") == "production", "Deployment is not production")
    if ready:
        require(deployment.get("readyState") == "READY", "Deployment is not READY")
    metadata = deployment.get("meta", {})
    if candidate:
        require(metadata.get("mccSourceCommit") == CANDIDATE and metadata.get("mccSourceTree") == WEB_TREE and metadata.get("mccSourceManifest") == MANIFEST_SHA256, "Candidate source provenance differs")
    else:
        require(metadata.get("githubCommitSha") == BASELINE_SHA, "Rollback baseline source differs")
    require(not deployment.get("aliasError"), "Deployment alias error")


def git(*args):
    return subprocess.check_output(["git", *args])


def validate_files(records):
    """Validate and base64-encode an immutable Git tree's regular files only."""
    files, manifest = [], []
    require(len(records) == 29, "Unexpected candidate source file count")
    seen = set()
    for name, mode, data in sorted(records):
        parts = PurePosixPath(name).parts
        require(parts and "\\" not in name and not name.startswith("/") and all(p not in (".", "..") for p in parts) and str(PurePosixPath(name)) == name, "Unsafe source path")
        require(not data.startswith(b"version https://git-lfs.github.com/spec/v1"), "Git LFS pointer is not source bytes")
        require(mode == "100644" and name not in seen, "Non-regular/executable/duplicate source file")
        require(not any(p.startswith(".") or p in {"node_modules", "dist", "supabase", "api", "functions"} for p in parts), "Excluded or hidden source path")
        require(len(data) < 128_000, "Source file unexpectedly large")
        seen.add(name)
        manifest.append({"path": name, "mode": mode, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        files.append({"file": name, "data": base64.b64encode(data).decode("ascii"), "encoding": "base64"})
    require({"package.json", "package-lock.json", "vercel.json", "index.html", "vite.config.ts", "tsconfig.json"}.issubset(seen), "Required frontend files missing")
    content = {name: data for name, _, data in records}
    require(json.loads(content["vercel.json"]) == {"rewrites": [{"source": "/(.*)", "destination": "/index.html"}]}, "Vercel config differs or adds crons/functions/settings")
    package = json.loads(content["package.json"])
    require(package.get("scripts") == {"dev": "vite", "build": "tsc -b && vite build", "preview": "vite preview"}, "Frontend build scripts differ")
    require(digest(manifest) == MANIFEST_SHA256, "Source manifest differs from reviewed immutable candidate")
    return files, manifest


def source_payload():
    require(git("rev-parse", f"{CANDIDATE}:apps/web").decode().strip() == WEB_TREE, "Candidate web tree differs")
    raw = git("ls-tree", "-rz", f"{CANDIDATE}:apps/web")
    records = []
    for entry in raw.split(b"\0"):
        if not entry:
            continue
        info, path = entry.split(b"\t", 1)
        mode, kind, object_id = info.decode().split()
        require(kind == "blob", "Non-blob source object")
        # Read the committed blob, never runner working-tree/generated files.
        records.append((path.decode("utf-8"), mode, git("cat-file", "blob", object_id.decode() if isinstance(object_id, bytes) else object_id)))
    files, manifest = validate_files(records)
    payload = {"name": "message-command-center", "project": PROJECT, "target": "production", "files": files, "meta": {"mccSourceCommit": CANDIDATE, "mccSourceTree": WEB_TREE, "mccSourceManifest": MANIFEST_SHA256, "mccSourceDirectory": "apps/web", "mccControllerRun": os.environ.get("GITHUB_RUN_ID", "unknown")}}
    require(len(canonical(payload)) < 1_000_000, "Inline payload exceeds reviewed local 1MB safety cap")
    return payload, manifest


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Unexpected redirect; refusing to forward authorization")


class API:
    def __init__(self):
        self.opener = urllib.request.build_opener(NoRedirect)
        require(bool(os.environ.get("VERCEL_TOKEN")) and bool(os.environ.get("GH_TOKEN")), "Existing required credentials unavailable")

    def json(self, service, path, body=None):
        require(service in ("vercel", "github") and path.startswith("/"), "Invalid API destination")
        empty_rollback_response = service == "vercel" and path == f"/v1/projects/{PROJECT}/rollback/{BASELINE_ID}" and body == {}
        host = "https://api.vercel.com" if service == "vercel" else "https://api.github.com"
        if service == "vercel":
            path += ("&" if "?" in path else "?") + urllib.parse.urlencode({"teamId": TEAM})
        token = os.environ["VERCEL_TOKEN" if service == "vercel" else "GH_TOKEN"]
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "mcc-frontend-release"}
        request = urllib.request.Request(host + path, data=None if body is None else canonical(body), headers=headers, method="GET" if body is None else "POST")
        # Exactly one request. A POST timeout/error may mean the mutation happened.
        try:
            with self.opener.open(request, timeout=60) as response:
                raw = response.read()
                # Documented rollback success is HTTP 201 with no response body.
                # Accept that only for this exact endpoint; create still needs JSON/ID.
                if empty_rollback_response and response.status == 201 and raw == b"":
                    return {}
                return json.loads(raw)
        except Exception as exc:
            action = "Read failed" if body is None else "POST outcome uncertain: reconcile project/deployments before any retry"
            raise RuntimeError(f"{action} ({type(exc).__name__}); response/body/token not logged") from None

    def deployment(self, identity):
        require(bool(re.fullmatch(r"[A-Za-z0-9.-]+|dpl_[A-Za-z0-9]+", identity)), "Invalid deployment identifier")
        return self.json("vercel", f"/v13/deployments/{identity}")


def verify_ci(api):
    run = api.json("github", f"/repos/{REPOSITORY}/actions/runs/{CI_RUN}")
    require(run.get("head_sha") == CANDIDATE and run.get("status") == "completed" and run.get("conclusion") == "success" and run.get("path") == ".github/workflows/mcc-validation.yml", "Exact candidate CI has not passed")
    response = api.json("github", f"/repos/{REPOSITORY}/actions/runs/{CI_RUN}/jobs?per_page=100")
    jobs = response.get("jobs", [])
    require(response.get("total_count") == len(jobs), "CI jobs pagination/inventory incomplete")
    for name in CI_JOBS:
        matches = [job for job in jobs if job.get("name") == name]
        require(len(matches) == 1 and matches[0].get("status") == "completed" and matches[0].get("conclusion") == "success", "Required candidate CI job missing/failed/ambiguous")


def verify_no_later_deployment(api):
    response = api.json("vercel", f"/v6/deployments?projectId={PROJECT}&target=production&since={BASELINE_CREATED_AT + 1}&limit=100")
    require(response.get("deployments") == [], "A post-baseline production deployment exists, possibly from an uncertain request; reconcile before release")


def verify_live(api, current_id, candidate=False, auto_assignment=True):
    project_settings(api.json("vercel", f"/v9/projects/{PROJECT}"), auto_assignment)
    # Unfiltered list deliberately rejects any newly added project domain.
    domain_inventory(api.json("vercel", f"/v9/projects/{PROJECT}/domains?limit=100"))
    deployment_identity(api.deployment(BASELINE_ID), BASELINE_ID)
    for domain in DOMAINS:
        deployment_identity(api.deployment(domain), current_id, candidate)
    # These are historical generated URLs, not domains to repoint to the release.
    for historical_url in (BASELINE_URL, BASELINE_BRANCH_ALIAS):
        deployment_identity(api.deployment(historical_url), BASELINE_ID)


def validate_operation(operation, confirmation, release_id):
    require(operation in ("inspect", "deploy", "rollback"), "Unknown operation")
    require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Wrong repository/event")
    allowed_refs = {"refs/heads/main"}
    if operation == "inspect":
        allowed_refs.add(f"refs/heads/{INSPECT_BRANCH}")
    require(os.environ.get("GITHUB_REF") in allowed_refs, "Wrong ref for selected operation")
    if operation != "inspect":
        require(os.environ.get("GITHUB_RUN_ATTEMPT") == "1", "Do not rerun a consequential workflow; reconcile the first attempt")
    if operation == "deploy":
        require(RELEASE_AUTHORIZATION == "APPROVED" and confirmation == CANDIDATE, "Fresh release approval not recorded or confirmation differs")
        require(not release_id, "Deploy must not supply a rollback release ID")
    elif operation == "rollback":
        require(ROLLBACK_AUTHORIZATION == "APPROVED" and confirmation == BASELINE_ID, "Bounded rollback approval not recorded or confirmation differs")
        require(bool(re.fullmatch(r"dpl_[A-Za-z0-9]+", release_id)), "Exact new release ID required")
        require(release_id != BASELINE_ID, "Rollback release ID cannot be baseline")


def receipt(operation, identity, state, payload_sha256=None):
    result = {"operation": operation, "deployment_id": identity, "state": state, "candidate_commit": CANDIDATE, "candidate_tree": WEB_TREE, "source_manifest_sha256": MANIFEST_SHA256, "baseline_id": BASELINE_ID, "production_domains": DOMAINS, "payload_sha256": payload_sha256, "workflow_run": os.environ.get("GITHUB_RUN_ID"), "workflow_attempt": os.environ.get("GITHUB_RUN_ATTEMPT")}
    Path("mcc-release-receipt.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result), flush=True)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
            output.write(f"MCC {operation}: {state}; deployment {identity}; source {CANDIDATE}; manifest {MANIFEST_SHA256}\n\n")


def smoke(api):
    for route in ("today", "executive", "trust"):
        with api.opener.open(f"https://{DOMAINS[0]}/{route}", timeout=30) as response:
            html = response.read(1_000_000).decode("utf-8")
        require('id="root"' in html, f"SPA root absent from {route}")
    assets = re.findall(r'src="(/assets/[A-Za-z0-9_.-]+\.js)"', html)
    require(len(assets) == 1, "Unexpected frontend asset reference")
    with api.opener.open(f"https://{DOMAINS[0]}{assets[0]}", timeout=30) as response:
        asset = response.read(5_000_001)
    require(len(asset) <= 5_000_000 and len(asset) > 1000, "Unexpected frontend asset size")
    print(f"Static asset {assets[0]} SHA256 {hashlib.sha256(asset).hexdigest()}")
    print("Static routes only; authenticated live Today remains a separate acceptance gate.")


def main():
    operation = os.environ.get("OPERATION", "")
    release_id = os.environ.get("RELEASE_DEPLOYMENT_ID", "")
    validate_operation(operation, os.environ.get("CONFIRMATION", ""), release_id)
    if operation != "rollback":
        subprocess.run(["git", "merge-base", "--is-ancestor", CANDIDATE, "HEAD"], check=True)
        subprocess.run(["git", "diff", "--exit-code", CANDIDATE, "HEAD", "--", "apps/web"], check=True)
        payload, manifest = source_payload()
        print(f"Verified {len(manifest)} committed frontend blobs; payload {len(canonical(payload))} bytes; settings {digest(EXPECTED_SETTINGS)}")
    api = API()
    if operation != "rollback":
        verify_ci(api)
    current_id = release_id if operation == "rollback" else BASELINE_ID
    verify_live(api, current_id, candidate=operation == "rollback")
    if operation != "rollback":
        verify_no_later_deployment(api)
    if operation == "inspect":
        print("PASS: read-only preflight; no source upload/build/deployment/settings change")
        return
    # Recheck complete project/domain/source preconditions immediately before POST.
    verify_live(api, current_id, candidate=operation == "rollback")
    payload_sha = None
    if operation == "deploy":
        verify_no_later_deployment(api)
        payload_sha = hashlib.sha256(canonical(payload)).hexdigest()
        receipt(operation, None, "REQUEST_PREPARED_DO_NOT_RETRY_IF_UNCERTAIN", payload_sha)
        created = api.json("vercel", "/v13/deployments", payload)
        release_id = created.get("id", "")
        require(isinstance(release_id, str) and bool(re.fullmatch(r"dpl_[A-Za-z0-9]+", release_id)), "POST may have succeeded but did not return a valid ID; reconcile, do not retry")
        receipt(operation, release_id, "CREATED_AWAITING_VERIFICATION", payload_sha)
        expected_id = release_id
    else:
        receipt(operation, BASELINE_ID, "ROLLBACK_REQUEST_STARTING")
        api.json("vercel", f"/v1/projects/{PROJECT}/rollback/{BASELINE_ID}", {})
        expected_id = BASELINE_ID
    for attempt in range(120):
        status = api.deployment(expected_id)
        require(status.get("readyState") not in ("ERROR", "CANCELED", "CANCELLED"), "Deployment failed; reconcile before any retry/rollback")
        if status.get("readyState") == "READY":
            deployment_identity(status, expected_id, candidate=operation == "deploy")
            alias = api.deployment(DOMAINS[0])
            if alias.get("id") == expected_id:
                break
        if attempt == 119:
            raise RuntimeError("Readiness/alias observation window ended; release unverified; reconcile without retrying POST")
        time.sleep(5)
    verify_live(api, expected_id, candidate=operation == "deploy", auto_assignment=operation != "rollback")
    smoke(api)
    receipt(operation, expected_id, "STATIC_VERIFIED_AUTHENTICATED_ACCEPTANCE_PENDING", payload_sha)
    if operation == "rollback":
        print("Production auto-assignment verified OFF. No automatic re-enable/promotion is authorized.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"STOP: {error}", file=sys.stderr)
        sys.exit(1)
