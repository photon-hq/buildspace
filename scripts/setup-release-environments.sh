#!/usr/bin/env bash
set -euo pipefail

# Show supported arguments and the protections preserved by the command.
usage() {
  cat <<'EOF'
Usage: setup-release-environments.sh [--dry-run] OWNER/REPO [@USER | @ORG/TEAM ...]

Create main-only staging and production environments. Production requires one of
the given reviewers (at most six); without reviewers, use CODEOWNERS from main.
Requires gh, jq and a gh login with repository administration access to apply.
--dry-run reads GitHub and prints the planned API writes without applying them.
Existing wait timers, self-review and administrator-bypass settings are kept.
Other branch/tag policies must be resolved manually; the script does not remove them.
Reruns replace production's reviewer list with the arguments or CODEOWNERS.
EOF
}

# Report a failure and stop without continuing to the next environment.
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# Call GitHub.com using the pinned REST API version.
api() {
  gh api --hostname github.com -H 'X-GitHub-Api-Version: 2022-11-28' "$@"
}

# Represent missing resources as null; propagate other API failures.
optional_get() {
  local response
  if response=$(api --method GET "$@" 2>&1); then
    printf '%s\n' "$response"
  elif [[ $response == *'(HTTP 404)'* ]]; then
    printf 'null\n'
  else
    printf '%s\n' "$response" >&2
    return 1
  fi
}

# Print the planned write, applying it only outside dry-run mode.
write_api() {
  local method=$1 endpoint=$2 body=$3
  printf '%s %s %s\n' "$method" "$endpoint" "$body"
  if [[ $dry_run == false ]]; then
    api --method "$method" "$endpoint" --input - <<<"$body" >/dev/null
  fi
}

dry_run=false
repository=''
reviewer_specs=''
for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run=true ;;
    -h|--help) usage; exit 0 ;;
    -*) die "Unknown option: $argument" ;;
    *)
      if [[ -z $repository ]]; then
        repository=$argument
      else
        reviewer_specs+="$argument"$'\n'
      fi
      ;;
  esac
done
[[ $repository =~ ^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$ ]] || { usage >&2; exit 1; }
command -v gh >/dev/null || die 'Install the GitHub CLI (gh) and run gh auth login.'
command -v jq >/dev/null || die 'Install jq.'

# Check the repository first: its 404 must not be mistaken for a missing environment.
repo=$(api --method GET "repos/$repository")
if [[ $dry_run == false ]] && ! jq -e '.permissions.admin == true' <<<"$repo" >/dev/null; then
  die "Repository administrator access is required for $repository; use --dry-run to preview."
fi
api --method GET "repos/$repository/branches/main" >/dev/null

if [[ -z $reviewer_specs ]]; then
  for path in .github/CODEOWNERS CODEOWNERS docs/CODEOWNERS; do
    owners=$(optional_get "repos/$repository/contents/$path?ref=main" -H 'Accept: application/vnd.github.raw+json')
    [[ $owners != null ]] || continue
    reviewer_specs=$(awk '{ sub(/#.*/, ""); for (i = 2; i <= NF; i++) if ($i ~ /^@/) print $i }' <<<"$owners")
    printf 'Reviewers from %s on main.\n' "$path"
    break
  done
fi
[[ -n $reviewer_specs ]] || die 'No GitHub users or teams found in CODEOWNERS; pass @USER or @ORG/TEAM explicitly.'

reviewers='[]'
while IFS= read -r spec; do
  [[ -n $spec ]] || continue
  spec=${spec#@}
  [[ $spec =~ ^[A-Za-z0-9-]+(/[A-Za-z0-9_.-]+)?$ ]] || die "Invalid reviewer: $spec"
  if [[ $spec == */* ]]; then
    type=Team
    endpoint="orgs/${spec%/*}/teams/${spec#*/}"
    query='.id'
  else
    type=User
    endpoint="users/$spec"
    query='select(.type == "User") | .id'
  fi
  if ! id=$(api --method GET "$endpoint" --jq "$query"); then
    die "Could not resolve reviewer @$spec; check its name and your gh access."
  fi
  [[ $id =~ ^[0-9]+$ ]] || die "Could not resolve reviewer: $spec"
  reviewers=$(jq -c --arg type "$type" --argjson id "$id" '. + [{type: $type, id: $id}] | unique_by([.type, .id])' <<<"$reviewers")
done <<<"$reviewer_specs"
if ! jq -e 'length >= 1 and length <= 6' <<<"$reviewers" >/dev/null; then
  printf 'Reviewers found:\n%s\n' "$reviewer_specs" >&2
  printf "Example with the first six entries (adjust your selection):\n  script=\$(gh api -H 'Accept: application/vnd.github.raw+json' 'repos/photon-hq/buildspace/contents/scripts/setup-release-environments.sh?ref=main') && bash -s --" >&2
  [[ $dry_run == false ]] || printf ' --dry-run' >&2
  printf ' %q' "$repository" >&2
  count=0
  while IFS= read -r spec; do
    [[ -n $spec ]] || continue
    printf ' %q' "$spec" >&2
    count=$((count + 1))
    [[ $count -lt 6 ]] || break
  done <<<"$reviewer_specs"
  printf ' <<<"$script"\n' >&2
  die 'GitHub allows one to six reviewers; rerun with an explicit list.'
fi

# Resolve both environments before making any writes.
plan='{}'
for environment in production staging; do
  before=$(optional_get "repos/$repository/environments/$environment")
  if jq -e '.deployment_branch_policy.protected_branches == true' <<<"$before" >/dev/null; then
    die "$environment allows protected branches; resolve its deployment policy manually before rerunning. No environments changed."
  fi
  policies='[]'
  if jq -e '.deployment_branch_policy.custom_branch_policies == true' <<<"$before" >/dev/null; then
    policies=$(api --method GET --paginate "repos/$repository/environments/$environment/deployment-branch-policies?per_page=100" | jq -sc '[.[].branch_policies[]]')
    if jq -e 'any(.[]; .name != "main" or (.type // "branch") != "branch")' <<<"$policies" >/dev/null; then
      die "$environment has other deployment branch/tag policies; resolve them manually before rerunning. No environments changed."
    fi
  fi
  after=$(jq -c --arg environment "$environment" --argjson reviewers "$reviewers" '{
    wait_timer: ([.protection_rules[]? | select(.type == "wait_timer") | .wait_timer][0] // 0),
    prevent_self_review: ([.protection_rules[]? | select(.type == "required_reviewers") | .prevent_self_review][0] // false),
    reviewers: (if $environment == "production" then $reviewers else [.protection_rules[]? | select(.type == "required_reviewers") | .reviewers[]? | {type, id: .reviewer.id}] end),
    deployment_branch_policy: {protected_branches: false, custom_branch_policies: true}
  } + (if .can_admins_bypass == null then {} else {can_admins_bypass} end)' <<<"$before")
  plan=$(jq -c --arg environment "$environment" --argjson before "$before" --argjson after "$after" --argjson policies "$policies" '. + {($environment): {before: $before, after: $after, policies: $policies}}' <<<"$plan")
done

# Production's reviewer/plan validation must succeed before staging changes.
for environment in production staging; do
  entry=$(jq -c --arg environment "$environment" '.[$environment]' <<<"$plan")
  before_summary=$(jq -c '.before | if . == null then "missing" else {
    reviewers: [.protection_rules[]? | select(.type == "required_reviewers") | .reviewers[]? | {type, id: .reviewer.id}],
    wait_timer: ([.protection_rules[]? | select(.type == "wait_timer") | .wait_timer][0] // 0),
    prevent_self_review: ([.protection_rules[]? | select(.type == "required_reviewers") | .prevent_self_review][0] // false),
    can_admins_bypass, deployment_branch_policy
  } end' <<<"$entry")
  printf '%s before: %s\n' "$environment" "$before_summary"
  printf '%s after: main branch only; %s\n' "$environment" "$(jq -c '.after' <<<"$entry")"
  write_api PUT "repos/$repository/environments/$environment" "$(jq -c '.after' <<<"$entry")"
  if ! jq -e '.policies | any(.[]; .name == "main" and (.type // "branch") == "branch")' <<<"$entry" >/dev/null; then
    if ! write_api POST "repos/$repository/environments/$environment/deployment-branch-policies" '{"name":"main","type":"branch"}'; then
      printf 'Error: Could not add the main policy for %s; restoring its saved branch policy.\n' "$environment" >&2
      write_api PUT "repos/$repository/environments/$environment" "$(jq -c '.after + {deployment_branch_policy: .before.deployment_branch_policy}' <<<"$entry")" ||
        die "Could not restore $environment's branch policy; resolve it manually before rerunning."
      die "Could not add the main policy for $environment; its saved branch policy was restored. The environment and other applied settings remain."
    fi
  fi
done

if [[ $dry_run == true ]]; then
  printf 'Dry run: no changes made. Applying requires repository administration access.\n'
else
  printf 'Configured staging and production for %s.\n' "$repository"
fi
