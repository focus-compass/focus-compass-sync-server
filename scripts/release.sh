#!/usr/bin/env bash
# Release the sync server without ever pointing `main` at an unpublished image.
#
#   scripts/release.sh <X.Y.Z> [--dry-run] [--skip-tests]
#
# Order (main is touched only in the last step):
#   1. require a clean tree on main, up to date with origin/main
#   2. create release/vX.Y.Z, bump versions/image refs, date the CHANGELOG
#   3. npm test + npm run lint (unless --skip-tests)
#   4. commit "release: prepare vX.Y.Z", push the branch and tag vX.Y.Z
#   5. wait for the "Publish Docker Image" run of the tag (gh run watch)
#   6. verify ghcr.io/<repo>:vX.Y.Z manifest exists (anonymous pull token)
#   7. fast-forward origin/main to the release commit, delete the branch
#
# Any failure before step 7 aborts and leaves main untouched.
set -euo pipefail

REPO="focus-compass/focus-compass-sync-server"
IMAGE="ghcr.io/${REPO}"
WORKFLOW_FILE="publish-docker.yml"
GIT_ID=(-c user.name=SARFEX -c user.email=801248+SARFEX@users.noreply.github.com)

DRY_RUN=0
SKIP_TESTS=0
VERSION=""

usage() {
  echo "Usage: $0 <X.Y.Z> [--dry-run] [--skip-tests]" >&2
  exit 2
}

[ $# -gt 0 ] || usage
PUSHED=0
for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    -h|--help) usage ;;
    -*) echo "Unknown option: ${arg}" >&2; usage ;;
    *) [ -z "${VERSION}" ] || usage; VERSION="${arg#v}" ;;
  esac
done
[ -n "${VERSION}" ] || usage
[[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Version must be X.Y.Z, got '${VERSION}'" >&2; exit 2; }

TAG="v${VERSION}"
BRANCH="release/${TAG}"
TODAY="$(date +%Y-%m-%d)"

# Exact image ref match (v0.0.9 must not match v0.0.90). Portable ERE.
ref_re() { printf '%s([^0-9A-Za-z.-]|$)' "$(printf '%s' "$1" | sed 's/[.]/\\./g')"; }
has_ref() { grep -qE "$(ref_re "$1")" "$2"; }

log() { printf '\n==> %s\n' "$*"; }
recovery_hint() {
  [ "${DRY_RUN}" -eq 1 ] && return 0
  if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "${BRANCH}" ]; then
    printf 'Local cleanup:  git switch main && git branch -D %s && git tag -d %s 2>/dev/null\n' "${BRANCH}" "${TAG}" >&2
  fi
  if [ "${PUSHED}" -eq 1 ]; then
    printf 'Remote cleanup: git push origin --delete %s refs/tags/%s\n' "${BRANCH}" "${TAG}" >&2
    printf '(If the image %s:%s was already published, re-tagging later may produce a different digest.)\n' "${IMAGE}" "${TAG}" >&2
  fi
}
die() {
  printf '\nRELEASE ABORTED: %s\n' "$*" >&2
  printf 'main was NOT changed.\n' >&2
  recovery_hint
  exit 1
}
run() {
  # Mutating commands: print in dry-run, execute otherwise.
  if [ "${DRY_RUN}" -eq 1 ]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git work tree"
cd "${TOPLEVEL}"
for cmd in git gh npm node curl; do
  command -v "${cmd}" >/dev/null || die "required command not found: ${cmd}"
done

# --- 1. Preconditions -------------------------------------------------------
log "Checking working tree and branch"
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "check out main first"
[ -z "$(git status --porcelain)" ] || die "working tree is not clean"
git fetch --quiet --tags origin main || die "git fetch failed"
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || die "local main differs from origin/main (pull/push first)"
case "$(git remote get-url origin)" in
  *"${REPO}"|*"${REPO}.git") ;;
  *) die "origin is not ${REPO}" ;;
esac
git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null && die "tag ${TAG} already exists locally"
git rev-parse -q --verify "refs/heads/${BRANCH}" >/dev/null && die "local branch ${BRANCH} already exists (git branch -D ${BRANCH})"
REMOTE_REFS="$(git ls-remote origin "refs/tags/${TAG}" "refs/heads/${BRANCH}")" || die "git ls-remote origin failed"
[ -z "${REMOTE_REFS}" ] || die "tag ${TAG} or branch ${BRANCH} already exists on origin"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated"

CURRENT="$(node -p 'require("./package.json").version')"
node -e '
  const [a, b] = process.argv.slice(1).map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) { if (b[i] !== a[i]) process.exit(b[i] > a[i] ? 0 : 1); }
  process.exit(1);
' "${CURRENT}" "${VERSION}" || die "version ${VERSION} must be greater than current ${CURRENT}"
log "Releasing ${CURRENT} -> ${VERSION} (${TAG})"

# Image refs currently point at the previous published tag. Read it from
# docker-compose.yml (source of truth for the pinned image).
PREV_TAG="$(sed -nE "s|.*${IMAGE}:(v[0-9]+\.[0-9]+\.[0-9]+).*|\1|p" docker-compose.yml)"
PREV_TAG="${PREV_TAG%%$'\n'*}"
[ -n "${PREV_TAG}" ] || die "could not find the current image tag in docker-compose.yml"
[ "${PREV_TAG}" != "${TAG}" ] || die "image refs already point at ${TAG}"

IMAGE_FILES=(.env.example docker-compose.yml README.md .github/workflows/guides-e2e.yml tests/test-docker-guide.sh)
for f in "${IMAGE_FILES[@]}"; do
  [ -f "${f}" ] || die "expected file missing: ${f}"
  has_ref "${IMAGE}:${PREV_TAG}" "${f}" || die "${f} does not reference ${IMAGE}:${PREV_TAG}"
done

# CHANGELOG: accept "## X.Y.Z - Unreleased" or "## Unreleased".
CHANGELOG_RE="^## (${VERSION//./\\.} - )?Unreleased\$"
grep -qE "${CHANGELOG_RE}" CHANGELOG.md \
  || die "CHANGELOG.md needs a '## ${VERSION} - Unreleased' (or '## Unreleased') section"

# --- 2. Branch + bumps --------------------------------------------------------
log "Creating ${BRANCH} and bumping versions"
if [ "${DRY_RUN}" -eq 1 ]; then
  printf '[dry-run] git switch -c %s\n' "${BRANCH}"
  printf '[dry-run] npm version %s --no-git-tag-version (package.json + lock)\n' "${VERSION}"
  for f in "${IMAGE_FILES[@]}"; do
    printf '[dry-run] %s: %s:%s -> %s\n' "${f}" "${IMAGE}" "${PREV_TAG}" "${TAG}"
    grep -nE "$(ref_re "${IMAGE}:${PREV_TAG}")" "${f}" | sed 's/^/            /'
  done
  printf '[dry-run] CHANGELOG.md: "%s" -> "## %s - %s"\n' "$(grep -m1 -E "${CHANGELOG_RE}" CHANGELOG.md)" "${VERSION}" "${TODAY}"
else
  # From here on, a failure leaves the local release branch behind; main is safe.
  trap 'printf "\nRELEASE ABORTED (unexpected error). main was NOT changed.\n" >&2; recovery_hint' ERR
  git switch -q -c "${BRANCH}"
  npm version "${VERSION}" --no-git-tag-version --allow-same-version >/dev/null
  for f in "${IMAGE_FILES[@]}"; do
    # Replace only exact refs (not e.g. v0.0.9 inside v0.0.90).
    PREV="${IMAGE}:${PREV_TAG}" NEXT="${IMAGE}:${TAG}" node -e '
      const fs = require("fs");
      const f = process.argv[1];
      const esc = process.env.PREV.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(esc + "(?![0-9A-Za-z.-])", "g");
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(re, process.env.NEXT));
    ' "${f}"
    if has_ref "${IMAGE}:${PREV_TAG}" "${f}"; then
      die "${f} still references ${IMAGE}:${PREV_TAG} after the bump"
    fi
    has_ref "${IMAGE}:${TAG}" "${f}" || die "${f} was not bumped to ${TAG}"
  done
  node -e '
    const fs = require("fs");
    const [version, today] = process.argv.slice(1);
    const re = new RegExp(`^## (${version.replace(/\./g, "\\.")} - )?Unreleased$`, "m");
    const s = fs.readFileSync("CHANGELOG.md", "utf8");
    if (!re.test(s)) { console.error("CHANGELOG Unreleased heading not found"); process.exit(1); }
    fs.writeFileSync("CHANGELOG.md", s.replace(re, `## ${version} - ${today}`));
  ' "${VERSION}" "${TODAY}" || die "could not date the CHANGELOG section"
  git --no-pager diff --stat
fi

# --- 3. Checks ----------------------------------------------------------------
if [ "${SKIP_TESTS}" -eq 1 ]; then
  log "Skipping tests and lint (--skip-tests)"
else
  log "Running npm test and npm run lint"
  run npm test || die "npm test failed"
  run npm run lint || die "npm run lint failed"
  run npm audit --omit=dev || die "npm audit --omit=dev failed (CI would fail too)"
fi

# --- 4. Commit, push branch + tag ---------------------------------------------
log "Committing and pushing ${BRANCH} + ${TAG} (not main)"
run git "${GIT_ID[@]}" commit -q -am "release: prepare ${TAG}"
run git "${GIT_ID[@]}" tag -a "${TAG}" -m "focus-compass-server ${TAG}"
run git push -q origin "${BRANCH}" || die "pushing ${BRANCH} failed"
PUSHED=1
run git push -q origin "refs/tags/${TAG}" || die "pushing tag ${TAG} failed"
RELEASE_SHA="$( [ "${DRY_RUN}" -eq 1 ] && echo '<release-commit>' || git rev-parse HEAD )"

# --- 5. Wait for the publish workflow -----------------------------------------
log "Waiting for ${WORKFLOW_FILE} on ${TAG}"
if [ "${DRY_RUN}" -eq 1 ]; then
  printf '[dry-run] gh run list --workflow %s --branch %s (match sha) -> gh run watch <id> --exit-status\n' "${WORKFLOW_FILE}" "${TAG}"
else
  RUN_ID=""
  attempt=0
  while [ "${attempt}" -lt 60 ]; do
    attempt=$((attempt + 1))
    RUN_ID="$(gh run list --repo "${REPO}" --workflow "${WORKFLOW_FILE}" --branch "${TAG}" \
      --event push --limit 20 --json databaseId,headSha \
      --jq "[.[] | select(.headSha == \"${RELEASE_SHA}\")][0].databaseId // empty" || true)"
    [ -n "${RUN_ID}" ] && break
    sleep 5
  done
  [ -n "${RUN_ID}" ] || die "no ${WORKFLOW_FILE} run appeared for ${TAG} within 5 minutes"
  echo "Run: https://github.com/${REPO}/actions/runs/${RUN_ID}"
  gh run watch "${RUN_ID}" --repo "${REPO}" --exit-status --interval 20 \
    || die "${WORKFLOW_FILE} run ${RUN_ID} failed"
fi

# --- 6. Verify the manifest on GHCR -------------------------------------------
log "Verifying ${IMAGE}:${TAG} on GHCR"
verify_manifest() {
  local ref="$1" token code
  token="$(curl -fsS "https://ghcr.io/token?scope=repository:${REPO}:pull" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).token||""))')" || return 1
  [ -n "${token}" ] || return 1
  code="$(curl -sS -o /dev/null -w '%{http_code}' -I \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
    "https://ghcr.io/v2/${REPO}/manifests/${ref}")"
  echo "GHCR manifest ${ref}: HTTP ${code}"
  [ "${code}" = "200" ]
}
if [ "${DRY_RUN}" -eq 1 ]; then
  printf '[dry-run] HEAD https://ghcr.io/v2/%s/manifests/%s must return 200\n' "${REPO}" "${TAG}"
  # Read-only sanity check of the probe against the currently published tag.
  verify_manifest "${PREV_TAG}" || echo "warning: probe of current ${PREV_TAG} did not return 200"
else
  ok=0
  for _try in 1 2 3; do
    if verify_manifest "${TAG}"; then ok=1; break; fi
    sleep 10
  done
  [ "${ok}" -eq 1 ] || die "${IMAGE}:${TAG} manifest not found on GHCR"
fi

# --- 7. Fast-forward main -----------------------------------------------------
log "Fast-forwarding origin/main to ${RELEASE_SHA}"
# Plain push (no --force): GitHub rejects it unless it is a fast-forward.
run git push -q origin "${RELEASE_SHA}:refs/heads/main" \
  || die "fast-forward of main was rejected (main moved?). Release ${TAG} is published; merge ${BRANCH} manually"
# main is published now: remaining steps are local/remote tidy-up only.
trap - ERR
PUSHED=0
tidy() { run "$@" || printf 'warning: tidy-up step failed: %s\n' "$*" >&2; }
tidy git switch -q main
tidy git merge -q --ff-only "${RELEASE_SHA}"
tidy git push -q origin --delete "${BRANCH}"
tidy git branch -q -d "${BRANCH}"

log "Released ${TAG}: ${IMAGE}:${TAG}"
[ "${DRY_RUN}" -eq 1 ] && echo "(dry run: nothing was changed)"
exit 0
