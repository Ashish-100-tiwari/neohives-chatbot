#!/usr/bin/env bash
# Runnable walkthrough of the Neohives chat API.
#
#   export NEOHIVES_API=http://localhost:3000
#   export NEOHIVES_TOKEN=$(npm run --silent token | grep '^VITE_' | cut -d= -f2)
#   bash examples/curl.sh
#
# Uses node (not jq) to pull fields out of the JSON, so it runs anywhere the
# backend runs.
set -euo pipefail

API="${NEOHIVES_API:-http://localhost:3000}"
TOKEN="${NEOHIVES_TOKEN:?Set NEOHIVES_TOKEN — mint one with: npm run token}"
STATE_FILE="${TMPDIR:-/tmp}/neohives-state.txt"

field() { node -e 'let i="";process.stdin.on("data",c=>i+=c).on("end",()=>{try{const v=JSON.parse(i)[process.argv[1]];console.log(typeof v==="string"?v:JSON.stringify(v)??"")}catch{console.log("")}})' "$1"; }
post() { curl -sS -X POST "$API/api/chat" -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" -d "$1"; }

echo "### 0. health (no auth needed)"
curl -sS "$API/health"; echo

echo
echo "### 1. rejected without a token"
curl -sS -o /dev/stdout -w ' [status %{http_code}]\n' -X POST "$API/api/chat" \
  -H 'content-type: application/json' -d '{"message":"hi"}'

echo
echo "### 2. first turn — no state, so the server starts a new conversation"
R1=$(post '{
  "message": "What does a client portal cost?",
  "pageUrl": "https://neohives.com/pricing",
  "locale": "en-IN",
  "utm": { "utm_source": "google", "utm_campaign": "brand" }
}')
echo "$R1" | node -e 'let i="";process.stdin.on("data",c=>i+=c).on("end",()=>{const d=JSON.parse(i);console.log(JSON.stringify({...d,state:d.state.slice(0,32)+"…"},null,2))})'
echo "$R1" | field state > "$STATE_FILE"
echo "state saved to $STATE_FILE ($(wc -c < "$STATE_FILE") bytes) — this is what localStorage holds"

echo
echo "### 3. follow-up — send the state back to keep the memory"
BODY_FILE="${TMPDIR:-/tmp}/neohives-body.json"
# The state blob is long, so build the body with node and post it with -d @file.
node -e 'require("fs").writeFileSync(process.argv[3], JSON.stringify({ message: process.argv[2], state: require("fs").readFileSync(process.argv[1],"utf8").trim() }))' \
  "$STATE_FILE" "I am Sam from Acme, my email is sam@acme.io, I need a booking portal" "$BODY_FILE"
R2=$(curl -sS -X POST "$API/api/chat" -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" -d "@$BODY_FILE")
echo "$R2" | node -e 'let i="";process.stdin.on("data",c=>i+=c).on("end",()=>{const d=JSON.parse(i);console.log(JSON.stringify({reply:d.reply,turns:d.turns,stateStatus:d.stateStatus,lead:d.lead,missingFields:d.missingFields,submitted:d.submitted},null,2))})'
echo "$R2" | field state > "$STATE_FILE"

echo
echo "### 4. streaming (SSE) — same endpoint, stream:true"
curl -sS -N -X POST "$API/api/chat" -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"message":"How do we get started?","stream":true}' | head -20

echo
echo "### 5. validation error"
curl -sS -o /dev/stdout -w ' [status %{http_code}]\n' -X POST "$API/api/chat" \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" -d '{"message":""}'

echo
echo "Done. Conversation state is in $STATE_FILE — delete it to start over."
