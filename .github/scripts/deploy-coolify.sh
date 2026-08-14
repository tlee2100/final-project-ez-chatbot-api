#!/usr/bin/env bash
set -Eeuo pipefail

: "${COOLIFY_API_URL:?Set COOLIFY_API_URL to the Coolify API base URL ending in /api/v1}"
: "${COOLIFY_TOKEN:?Set COOLIFY_TOKEN to a Coolify API token}"
: "${COOLIFY_APP_UUID:?Set COOLIFY_APP_UUID to the Coolify application UUID}"
: "${IMAGE_TAG:?Set IMAGE_TAG to the image tag that was pushed}"

if [[ ! "$IMAGE_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "Invalid Docker image tag: $IMAGE_TAG" >&2
  exit 1
fi

api_url="${COOLIFY_API_URL%/}"
deploy_mode="${COOLIFY_DEPLOY_MODE:-docker-image}"
resource_type="${COOLIFY_RESOURCE_TYPE:-services}"
env_key="${COOLIFY_ENV_KEY:-IMAGE_TAG}"

case "$deploy_mode" in
  docker-image)
    echo "Updating Docker Image tag to ${IMAGE_TAG}"
    update_payload="$(jq -cn --arg tag "$IMAGE_TAG" '{docker_registry_image_tag: $tag}')"
    curl --fail-with-body --silent --show-error \
      --retry 3 --retry-all-errors --connect-timeout 10 --max-time 120 \
      --request PATCH "${api_url}/applications/${COOLIFY_APP_UUID}" \
      --header "Authorization: Bearer ${COOLIFY_TOKEN}" \
      --header "Content-Type: application/json" \
      --data "$update_payload" >/dev/null

    application="$(curl --fail-with-body --silent --show-error \
      --retry 3 --retry-all-errors --connect-timeout 10 --max-time 120 \
      "${api_url}/applications/${COOLIFY_APP_UUID}" \
      --header "Authorization: Bearer ${COOLIFY_TOKEN}")"
    actual_tag="$(jq -er '.docker_registry_image_tag' <<<"$application")"
    [[ "$actual_tag" == "$IMAGE_TAG" ]] || {
      echo "Coolify tag verification failed: expected $IMAGE_TAG, got $actual_tag" >&2
      exit 1
    }
    ;;
  docker-compose)
    [[ "$resource_type" == "applications" || "$resource_type" == "services" ]] || {
      echo "COOLIFY_RESOURCE_TYPE must be applications or services" >&2
      exit 1
    }
    echo "Updating Docker Compose environment ${env_key}=${IMAGE_TAG}"
    update_payload="$(jq -cn \
      --arg key "$env_key" \
      --arg value "$IMAGE_TAG" \
      '{key: $key, value: $value, is_literal: true, is_preview: false}')"
    curl --fail-with-body --silent --show-error \
      --retry 3 --retry-all-errors --connect-timeout 10 --max-time 120 \
      --request PATCH "${api_url}/${resource_type}/${COOLIFY_APP_UUID}/envs" \
      --header "Authorization: Bearer ${COOLIFY_TOKEN}" \
      --header "Content-Type: application/json" \
      --data "$update_payload" >/dev/null
    ;;
  *)
    echo "Unsupported COOLIFY_DEPLOY_MODE: $deploy_mode" >&2
    exit 1
    ;;
esac

payload="$(jq -cn --arg uuid "$COOLIFY_APP_UUID" '{uuid: $uuid}')"

echo "Requesting Coolify deployment for ${DEPLOY_IMAGE:-$COOLIFY_APP_UUID}"
response="$(curl --fail-with-body --silent --show-error \
  --retry 3 --retry-all-errors --connect-timeout 10 --max-time 120 \
  --request POST "${api_url}/deploy?force=true" \
  --header "Authorization: Bearer ${COOLIFY_TOKEN}" \
  --header "Content-Type: application/json" \
  --data "$payload")"

deployment_uuid="$(jq -er '.deployments[0].deployment_uuid // .deployment_uuid' <<<"$response")" || {
  echo "Coolify did not return a deployment UUID: $response" >&2
  exit 1
}

echo "Coolify deployment queued: $deployment_uuid"
deadline=$((SECONDS + ${COOLIFY_DEPLOY_TIMEOUT_SECONDS:-900}))

while ((SECONDS < deadline)); do
  details="$(curl --fail-with-body --silent --show-error \
    --retry 3 --retry-all-errors --connect-timeout 10 --max-time 120 \
    "${api_url}/deployments/${deployment_uuid}" \
    --header "Authorization: Bearer ${COOLIFY_TOKEN}")"
  status="$(jq -r '.status // "unknown"' <<<"$details")"

  case "$status" in
    finished|completed)
      echo "Coolify deployment finished successfully."
      if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
        {
          echo "### Coolify deployment succeeded"
          echo "- Image: \`${DEPLOY_IMAGE:-not provided}\`"
          echo "- Release: \`${RELEASE_VERSION:-not provided}\`"
          echo "- Mode: \`${deploy_mode}\`"
          echo "- Deployment: \`${deployment_uuid}\`"
        } >>"$GITHUB_STEP_SUMMARY"
      fi
      exit 0
      ;;
    failed|error|cancelled*)
      echo "Coolify deployment ended with status: $status" >&2
      jq -r '.logs // "No deployment logs were returned."' <<<"$details" | tail -n 100 >&2
      exit 1
      ;;
    queued|in_progress)
      echo "Coolify deployment status: $status"
      ;;
    *)
      echo "Coolify deployment status: $status (waiting)"
      ;;
  esac

  sleep 10
done

echo "Timed out waiting for Coolify deployment $deployment_uuid" >&2
exit 1
