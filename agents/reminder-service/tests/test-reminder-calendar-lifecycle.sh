#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

CORE="${1:?usage: test-reminder-calendar-lifecycle.sh <core>}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

STATE="$TMP/reminders"
HIST="$TMP/historical"
RECIP="$TMP/recipients.json"
CRON_STATE="$TMP/cron.json"
CAL_STATE="$TMP/calendar.json"
GOG_LOG="$TMP/gog-invocations.jsonl"
GOG_HOME="$TMP/gog-home"
FAKE_OPENCLAW="$TMP/openclaw"
FAKE_GOG="$TMP/gog"

mkdir -p "$STATE" "$HIST" "$GOG_HOME"
printf '%s\n' '{}' > "$CRON_STATE"
printf '%s\n' '{}' > "$CAL_STATE"

cat > "$RECIP" <<'JSON'
{
  "accountId": "benson",
  "timezone": "Asia/Jerusalem",
  "trustedRequesterIds": ["oren", "ilana", "amit"],
  "recipients": [
    {
      "id": "oren",
      "displayName": "Oren",
      "type": "person",
      "channel": "whatsapp",
      "to": "+972500000001",
      "aliases": ["dad"]
    },
    {
      "id": "ilana",
      "displayName": "Ilana",
      "type": "person",
      "channel": "whatsapp",
      "to": "+972500000002",
      "aliases": []
    },
    {
      "id": "amit",
      "displayName": "Amit",
      "type": "person",
      "channel": "whatsapp",
      "to": "+972500000003",
      "aliases": []
    }
  ]
}
JSON

cat > "$FAKE_OPENCLAW" <<'PY'
#!/usr/bin/env python3
import datetime as dt
import json
import os
import sys
import uuid
from pathlib import Path

args = sys.argv[1:]
cron_path = Path(os.environ["FAKE_CRON_STATE"])

def read(path):
    try:
        value = json.loads(path.read_text())
    except Exception:
        value = {}
    return value if isinstance(value, dict) else {}

def write(path, value):
    path.write_text(json.dumps(value, sort_keys=True) + "\n")

def opt(name, default=None):
    try:
        return args[args.index(name)+1]
    except ValueError:
        return default

def canonical_at(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


if args[:2] == ["automations", "list"]:
    if os.environ.get("FAKE_FAIL_AUTOMATION_LIST") == "1":
        print("injected Automation read failure", file=sys.stderr)
        raise SystemExit(9)
    state = read(cron_path)
    print(json.dumps({"jobs": list(state.values())}))
    raise SystemExit(0)

if len(args) >= 3 and args[:2] == ["automations", "get"]:
    state = read(cron_path)
    job_id = args[2]
    if job_id not in state:
        print("not found", file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(state[job_id]))
    raise SystemExit(0)

if len(args) >= 3 and args[:2] == ["automations", "add"]:
    fail_at = int(os.environ.get("FAKE_FAIL_ADD_AT", "0"))
    counter_path = Path(os.environ.get("FAKE_ADD_COUNT", str(cron_path) + ".add-count"))
    try:
        add_count = int(counter_path.read_text()) + 1
    except Exception:
        add_count = 1
    counter_path.write_text(str(add_count))
    if fail_at and add_count == fail_at and os.environ.get("FAKE_FAIL_ADD_AFTER_PERSIST") != "1":
        print("injected Automation add failure", file=sys.stderr)
        raise SystemExit(9)
    state = read(cron_path)
    job_id = "job-" + uuid.uuid4().hex[:10]
    name = opt("--name")
    schedule_value = opt("--at") or opt("--cron")
    recurring = "--cron" in args
    if not recurring:
        schedule_value = canonical_at(schedule_value)
    job = {
        "id": job_id,
        "name": name,
        "description": opt("--description"),
        "declarationKey": opt("--declaration-key"),
        "agentId": opt("--agent"),
        "sessionKey": opt("--session-key"),
        "sessionTarget": opt("--session"),
        "enabled": "--disabled" not in args,
        "schedule": ({"kind": "cron", "expr": schedule_value, "tz": opt("--tz")} if recurring else {"kind": "at", "at": schedule_value}),
        "payload": {"kind": "command", "argv": json.loads(opt("--command-argv", "[]"))},
        "delivery": {"channel": opt("--channel"), "to": opt("--to"), "accountId": opt("--account")},
        "deleteAfterRun": "--delete-after-run" in args,
    }
    state[job_id] = job
    write(cron_path, state)
    if fail_at and os.environ.get("FAKE_FAIL_ADD_AFTER_PERSIST") == "1" and add_count == fail_at:
        print("injected lost Automation add acknowledgement", file=sys.stderr)
        raise SystemExit(9)
    print(json.dumps(job))
    raise SystemExit(0)

if len(args) >= 3 and args[:2] == ["automations", "rm"]:
    state = read(cron_path)
    job_id = args[2]
    state.pop(job_id, None)
    write(cron_path, state)
    print(json.dumps({"removed": True, "id": job_id}))
    raise SystemExit(0)

if len(args) >= 3 and args[:2] in (["automations", "disable"], ["automations", "enable"]):
    state = read(cron_path)
    job_id = args[2]
    if job_id not in state:
        raise SystemExit(1)
    if args[1] == "enable":
        fail_at = int(os.environ.get("FAKE_FAIL_ENABLE_AT", "0"))
        counter_path = Path(os.environ.get("FAKE_ENABLE_COUNT", str(cron_path) + ".enable-count"))
        try:
            enable_count = int(counter_path.read_text()) + 1
        except Exception:
            enable_count = 1
        counter_path.write_text(str(enable_count))
        if fail_at and enable_count == fail_at:
            print("injected Automation enable failure", file=sys.stderr)
            raise SystemExit(9)
    state[job_id]["enabled"] = args[1] == "enable"
    write(cron_path, state)
    print(json.dumps(state[job_id]))
    raise SystemExit(0)

if len(args) >= 3 and args[:2] == ["automations", "edit"]:
    state = read(cron_path)
    job_id = args[2]
    if job_id not in state:
        raise SystemExit(1)
    job = state[job_id]
    if "--command-argv" in args:
        job["payload"]["argv"] = json.loads(opt("--command-argv"))
    if "--at" in args:
        job["schedule"] = {"kind": "at", "at": canonical_at(opt("--at"))}
        job["deleteAfterRun"] = True
    if "--cron" in args:
        job["schedule"] = {"kind": "cron", "expr": opt("--cron"), "tz": opt("--tz")}
        job["deleteAfterRun"] = False
    write(cron_path, state)
    print(json.dumps(job))
    raise SystemExit(0)

print("unsupported fake invocation: " + " ".join(args), file=sys.stderr)
raise SystemExit(2)
PY
chmod 700 "$FAKE_OPENCLAW"

cat > "$FAKE_GOG" <<'PY'
#!/usr/bin/env python3
import json
import os
import sys
import uuid
from pathlib import Path

args = sys.argv[1:]
cal_path = Path(os.environ["FAKE_CAL_STATE"])
log_path = Path(os.environ["FAKE_GOG_LOG"])

def read(path):
    try:
        value = json.loads(path.read_text())
    except Exception:
        value = {}
    return value if isinstance(value, dict) else {}

def write(path, value):
    path.write_text(json.dumps(value, sort_keys=True) + "\n")

def opt(name, default=None):
    try:
        return args[args.index(name)+1]
    except ValueError:
        return default

assert opt("--home") == os.environ["EXPECTED_GOG_HOME"], args
assert opt("--account") == os.environ["EXPECTED_GOG_ACCOUNT"], args
assert "--no-input" in args and "--json" in args, args
assert "--enable-commands" not in args and "--enable-commands-exact" not in args, args

calendar_index = args.index("calendar")
command = args[calendar_index + 1]
tail = args[calendar_index + 2:]
with log_path.open("a") as handle:
    handle.write(json.dumps({"command": "calendar." + command, "argv": args}) + "\n")

state = read(cal_path)
if command == "create":
    calendar_id = tail[0]
    assert calendar_id == "primary", args
    fail_at = int(os.environ.get("FAKE_FAIL_CALENDAR_CREATE_AT", "0"))
    if fail_at:
        count_path = Path(os.environ["FAKE_CAL_CREATE_COUNT"])
        count = int(count_path.read_text()) + 1 if count_path.exists() else 1
        count_path.write_text(str(count))
        if count == fail_at:
            print("injected numbered Calendar create failure", file=sys.stderr)
            raise SystemExit(9)
    if os.environ.get("FAKE_FAIL_CALENDAR_CREATE") == "1":
        print("injected Calendar create failure", file=sys.stderr)
        raise SystemExit(9)
    event_id = "evt-" + uuid.uuid4().hex[:10]
    event = {
        "id": event_id,
        "status": "confirmed",
        "htmlLink": "https://calendar.invalid/" + event_id,
        "summary": opt("--summary"),
        "start": {"dateTime": opt("--from"), "timeZone": opt("--timezone")},
        "end": {"dateTime": opt("--to"), "timeZone": opt("--timezone")},
    }
    for flag, key in (("--description", "description"), ("--location", "location")):
        value = opt(flag)
        if value is not None:
            event[key] = value
    assert opt("--send-updates") == "none", args
    state[event_id] = event
    write(cal_path, state)
    print(json.dumps({"event": event}))
    raise SystemExit(0)

if command == "event":
    calendar_id, event_id = tail[:2]
    assert calendar_id == "primary", args
    if event_id not in state:
        print("not found", file=sys.stderr)
        raise SystemExit(5)
    event = dict(state[event_id])
    if os.environ.get("FAKE_CALENDAR_MISMATCH") == "1":
        event["summary"] = "WRONG SUMMARY"
    print(json.dumps({"event": event}))
    raise SystemExit(0)

if command == "delete":
    calendar_id, event_id = tail[:2]
    assert calendar_id == "primary", args
    assert "--force" in args and opt("--send-updates") == "none", args
    state.pop(event_id, None)
    write(cal_path, state)
    print(json.dumps({"deleted": True, "calendarId": calendar_id, "eventId": event_id}))
    raise SystemExit(0)

print("unsupported fake gog invocation: " + " ".join(args), file=sys.stderr)
raise SystemExit(2)
PY
chmod 700 "$FAKE_GOG"

run_core() {
  REMINDER_LINK_DIR="$STATE" \
  REMINDER_RECIPIENTS_CONFIG="$RECIP" \
  OPENCLAW_BIN="$FAKE_OPENCLAW" \
  REMINDER_GOG_BIN="$FAKE_GOG" \
  REMINDER_GOG_HOME="$GOG_HOME" \
  REMINDER_GOG_ACCOUNT="benson-reminder-calendar-test" \
  EXPECTED_GOG_HOME="$GOG_HOME" \
  EXPECTED_GOG_ACCOUNT="benson-reminder-calendar-test" \
  FAKE_CRON_STATE="$CRON_STATE" \
  FAKE_CAL_STATE="$CAL_STATE" \
  FAKE_GOG_LOG="$GOG_LOG" \
  "$CORE" "$@"
}

FUTURE1="2099-01-01T09:00:00+02:00"
FUTURE2="2099-01-02T10:15:00+02:00"

for IDENTITY_SPEC in \
  'oren|+972500000001' \
  'ilana|+972500000002' \
  'amit|+972500000003'
do
  REQUESTER="${IDENTITY_SPEC%%|*}"
  SOURCE="${IDENTITY_SPEC#*|}"
  SELF_INTENT="$(python3 - "$REQUESTER" "$SOURCE" "$FUTURE1" <<'PY'
import json,sys
requester,source,future=sys.argv[1:]
print(json.dumps({
  "sourceConversation":{"type":"private","id":source},
  "requesterId":requester,"recipientIds":[requester],"content":"Non-Calendar self create",
  "schedule":{"type":"one-shot","resolvedTime":future,"timezone":"Asia/Jerusalem"},
  "calendar":{"requested":False},
},separators=(",",":")))
PY
)"
  SELF_RESULT="$(printf '%s' "$SELF_INTENT" | run_core create-intent --input -)"
  SELF_RID="$(python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["status"]=="success" and r["transaction"]["verified"] is True,r; assert r["data"]["record"]["createdBy"]==sys.argv[1],r; print(r["reminderId"])' "$REQUESTER" <<<"$SELF_RESULT")"
  run_core delete-reminder --reminder-id "$SELF_RID" --requester "$REQUESTER" > /dev/null
done
MISMATCH_INTENT="$(python3 - "$FUTURE1" <<'PY'
import json,sys
print(json.dumps({
  "sourceConversation":{"type":"private","id":"+972500000002"},
  "requesterId":"oren","recipientIds":["oren"],"content":"Must not create",
  "schedule":{"type":"one-shot","resolvedTime":sys.argv[1],"timezone":"Asia/Jerusalem"},
  "calendar":{"requested":False},
},separators=(",",":")))
PY
)"
set +e
MISMATCH_RESULT="$(printf '%s' "$MISMATCH_INTENT" | run_core create-intent --input -)"
MISMATCH_RC=$?
set -e
[[ "$MISMATCH_RC" -ne 0 ]]
python3 - "$MISMATCH_RESULT" "$CRON_STATE" <<'PY'
import json,sys
result=json.loads(sys.argv[1]); state=json.load(open(sys.argv[2]))
assert result["error"]["code"]=="REMINDER_SOURCE_REQUESTER_MISMATCH",result
assert state=={},state
print("NON_CALENDAR_TRUSTED_SELF_CREATE_AND_IDENTITY_FAIL_CLOSED=PASS")
PY

# The Calendar contract is requester-independent. An omitted summary must be
# derived from Reminder content for every trusted requester and must never be
# materialized as an explicit empty value at the Calendar adapter boundary.
for IDENTITY_SPEC in \
  'oren|+972500000001' \
  'ilana|+972500000002' \
  'amit|+972500000003'
do
  REQUESTER="${IDENTITY_SPEC%%|*}"
  SOURCE="${IDENTITY_SPEC#*|}"
  CONTENT="Calendar derived summary ${REQUESTER}"
  IDENTITY_CREATE="$(python3 - "$REQUESTER" "$SOURCE" "$CONTENT" "$FUTURE1" <<'PY'
import json,sys
requester,source,content,future=sys.argv[1:]
print(json.dumps({
  "sourceConversation":{"type":"private","id":source},
  "requesterId":requester,"recipientIds":[requester],"content":content,
  "schedule":{"type":"one-shot","resolvedTime":future,"timezone":"Asia/Jerusalem"},
  "calendar":{"requested":True,"durationMinutes":20},
},separators=(",",":")))
PY
)"
  printf '%s' "$IDENTITY_CREATE" | run_core create-intent --input - > "$TMP/identity-${REQUESTER}.json"
  IDENTITY_RID="$(python3 - "$TMP/identity-${REQUESTER}.json" "$CAL_STATE" "$CONTENT" <<'PY'
import json,sys
result=json.load(open(sys.argv[1])); calendar=json.load(open(sys.argv[2])); content=sys.argv[3]
assert result["status"] == "success" and result["transaction"]["verified"] is True,result
record=result["data"]["record"]
assert record["calendar"]["summary"] == content,record
assert record["calendar"]["summaryFollowsContent"] is True,record
assert calendar[record["calendar"]["eventId"]]["summary"] == content,calendar
print(record["reminderId"])
PY
)"
  run_core delete-reminder --reminder-id "$IDENTITY_RID" --requester "$REQUESTER" > /dev/null
done
python3 - "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json,sys
from pathlib import Path
assert json.load(open(sys.argv[1])) == {}
assert json.load(open(sys.argv[2])) == {}
assert not list(Path(sys.argv[3]).glob("*.json"))
print("CALENDAR_DERIVED_SUMMARY_REQUESTER_INDEPENDENT=PASS")
PY

EXPLICIT_SUMMARY_JSON="$(python3 - "$FUTURE1" <<'PY'
import json,sys
print(json.dumps({
  "sourceConversation":{"type":"private","id":"+972500000001"},
  "requesterId":"oren","recipientIds":["oren"],"content":"Reminder content",
  "verbatimRequest":"Use summary Explicit Calendar summary, description Explicit Calendar description, and location Explicit Calendar location.",
  "schedule":{"type":"one-shot","resolvedTime":sys.argv[1],"timezone":"Asia/Jerusalem"},
  "calendar":{
    "requested":True,"durationMinutes":20,
    "summary":{"value":"Explicit Calendar summary","evidenceQuote":"summary Explicit Calendar summary"},
    "description":{"value":"Explicit Calendar description","evidenceQuote":"description Explicit Calendar description"},
    "location":{"value":"Explicit Calendar location","evidenceQuote":"location Explicit Calendar location"}
  },
},separators=(",",":")))
PY
)"
printf '%s' "$EXPLICIT_SUMMARY_JSON" | run_core create-intent --input - > "$TMP/explicit-summary.json"
EXPLICIT_RID="$(python3 - "$TMP/explicit-summary.json" "$CAL_STATE" <<'PY'
import json,sys
result=json.load(open(sys.argv[1])); calendar=json.load(open(sys.argv[2])); record=result["data"]["record"]
assert result["status"] == "success" and result["transaction"]["verified"] is True,result
assert record["calendar"]["summary"] == "Explicit Calendar summary",record
assert record["calendar"]["summaryFollowsContent"] is False,record
assert record["calendar"]["description"] == "Explicit Calendar description",record
assert record["calendar"]["location"] == "Explicit Calendar location",record
assert calendar[record["calendar"]["eventId"]]["summary"] == "Explicit Calendar summary",calendar
assert calendar[record["calendar"]["eventId"]]["description"] == "Explicit Calendar description",calendar
assert calendar[record["calendar"]["eventId"]]["location"] == "Explicit Calendar location",calendar
print(record["reminderId"])
PY
)"
run_core delete-reminder --reminder-id "$EXPLICIT_RID" --requester oren > /dev/null
echo "CALENDAR_EXPLICIT_SUMMARY_PRESERVED=PASS"

EMPTY_SUMMARY_JSON="$(python3 - "$FUTURE1" <<'PY'
import json,sys
print(json.dumps({
  "sourceConversation":{"type":"private","id":"+972500000001"},
  "requesterId":"oren","recipientIds":["oren"],"content":"Invalid empty summary",
  "schedule":{"type":"one-shot","resolvedTime":sys.argv[1],"timezone":"Asia/Jerusalem"},
  "calendar":{"requested":True,"durationMinutes":20,"summary":""},
},separators=(",",":")))
PY
)"
set +e
printf '%s' "$EMPTY_SUMMARY_JSON" | run_core create-intent --input - > "$TMP/empty-summary.json"
EMPTY_SUMMARY_RC=$?
set -e
[[ "$EMPTY_SUMMARY_RC" -ne 0 ]]
python3 - "$TMP/empty-summary.json" "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json,sys
from pathlib import Path
result=json.load(open(sys.argv[1]))
assert result["status"] == "failure" and result["error"]["code"] == "REMINDER_CALENDAR_METADATA_PROVENANCE_INVALID",result
assert json.load(open(sys.argv[2])) == {}
assert json.load(open(sys.argv[3])) == {}
assert not list(Path(sys.argv[4]).glob("*.json"))
print("CALENDAR_EMPTY_SUMMARY_REJECTED_WITHOUT_MUTATION=PASS")
PY

UNGROUNDED_JSON="$(python3 - "$FUTURE1" <<'PY'
import json,sys
print(json.dumps({
  "sourceConversation":{"type":"private","id":"+972500000001"},
  "requesterId":"oren","recipientIds":["oren"],"content":"Ungrounded metadata",
  "verbatimRequest":"Create a calendar event lasting 20 minutes.",
  "schedule":{"type":"one-shot","resolvedTime":sys.argv[1],"timezone":"Asia/Jerusalem"},
  "calendar":{"requested":True,"durationMinutes":20,"location":{"value":"/","evidenceQuote":"/"}},
},separators=(",",":")))
PY
)"
set +e
printf '%s' "$UNGROUNDED_JSON" | run_core create-intent --input - > "$TMP/ungrounded.json"
UNGROUNDED_RC=$?
set -e
[[ "$UNGROUNDED_RC" -ne 0 ]]
python3 - "$TMP/ungrounded.json" "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json,sys
from pathlib import Path
result=json.load(open(sys.argv[1]))
assert result["status"] == "failure" and result["error"]["code"] == "REMINDER_CALENDAR_METADATA_NOT_GROUNDED",result
assert json.load(open(sys.argv[2])) == {}
assert json.load(open(sys.argv[3])) == {}
assert not list(Path(sys.argv[4]).glob("*.json"))
print("CALENDAR_UNGROUNDED_METADATA_REJECTED_WITHOUT_MUTATION=PASS")
PY

CREATE_JSON="$(cat <<JSON
{"sourceConversation":{"type":"private","id":"+972500000001"},"requesterId":"oren","recipientIds":["oren"],"content":"Calendar restore test","schedule":{"type":"one-shot","resolvedTime":"$FUTURE1","timezone":"Asia/Jerusalem"},"calendar":{"requested":true,"durationMinutes":30,"calendarId":"primary"}}
JSON
)"

printf '%s' "$CREATE_JSON" | run_core create-intent --input - > "$TMP/create.json"
python3 - "$TMP/create.json" "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json, sys
from pathlib import Path
result=json.loads(Path(sys.argv[1]).read_text())
cron=json.loads(Path(sys.argv[2]).read_text())
cal=json.loads(Path(sys.argv[3]).read_text())
state=Path(sys.argv[4])
assert result["status"] == "success", result
record=result["data"]["record"]
assert record["calendar"]["requested"] is True, record
assert record["calendar"]["eventId"] in cal, (record, cal)
assert record["calendar"]["start"] == "2099-01-01T09:00:00+02:00"
assert record["calendar"]["end"] == "2099-01-01T09:30:00+02:00"
assert len(cron) == 1, cron
assert len(cal) == 1, cal
assert len(list(state.glob("*.json"))) == 1
print("CALENDAR_CREATE_VERIFY_LINK=PASS")
print(record["reminderId"])
PY
RID="$(tail -n1 "$TMP/create.json.rid" 2>/dev/null || true)"
RID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["reminderId"])' "$TMP/create.json")"
OLD_EVENT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["data"]["record"]["calendar"]["eventId"])' "$TMP/create.json")"

printf '%s' "$CREATE_JSON" | run_core create-intent --input - > "$TMP/retry.json"
python3 - "$TMP/retry.json" "$CRON_STATE" "$CAL_STATE" <<'PY'
import json, sys
from pathlib import Path
r=json.loads(Path(sys.argv[1]).read_text())
assert r["status"] == "success" and r["idempotent"] is True, r
assert len(json.loads(Path(sys.argv[2]).read_text())) == 1
assert len(json.loads(Path(sys.argv[3]).read_text())) == 1
print("CALENDAR_IDEMPOTENT_RETRY=PASS")
PY

UPDATE_JSON="$(cat <<JSON
{"content":"Calendar restore test updated","schedule":{"type":"one-shot","resolvedTime":"$FUTURE2","timezone":"Asia/Jerusalem"}}
JSON
)"
printf '%s' "$UPDATE_JSON" | run_core update-reminder --reminder-id "$RID" --requester oren --input - > "$TMP/update.json"
python3 - "$TMP/update.json" "$CAL_STATE" "$OLD_EVENT" <<'PY'
import json, sys
from pathlib import Path
r=json.loads(Path(sys.argv[1]).read_text())
cal=json.loads(Path(sys.argv[2]).read_text())
old=sys.argv[3]
assert r["status"] == "success", r
rec=r["data"]["record"]
assert rec["content"] == "Calendar restore test updated"
assert rec["calendar"]["requested"] is True
assert rec["calendar"]["summary"] == "Calendar restore test updated"
assert rec["calendar"]["eventId"] != old
assert old not in cal
assert list(cal) == [rec["calendar"]["eventId"]]
assert rec["calendar"]["start"] == "2099-01-02T10:15:00+02:00"
assert rec["calendar"]["end"] == "2099-01-02T10:45:00+02:00"
print("CALENDAR_LINKED_UPDATE_REPLACEMENT=PASS")
PY
NEW_EVENT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["data"]["record"]["calendar"]["eventId"])' "$TMP/update.json")"

run_core pause-reminder --reminder-id "$RID" --requester oren > "$TMP/pause.json"
run_core resume-reminder --reminder-id "$RID" --requester oren > "$TMP/resume.json"
python3 - "$TMP/pause.json" "$TMP/resume.json" "$CAL_STATE" "$NEW_EVENT" <<'PY'
import json, sys
from pathlib import Path
for p in sys.argv[1:3]:
    r=json.loads(Path(p).read_text())
    assert r["status"] == "success" and r["transaction"]["verified"] is True, r
cal=json.loads(Path(sys.argv[3]).read_text())
assert list(cal) == [sys.argv[4]], cal
print("PAUSE_RESUME_PRESERVES_CALENDAR=PASS")
PY

run_core delete-reminder --reminder-id "$RID" --requester oren > "$TMP/delete.json"
python3 - "$TMP/delete.json" "$CRON_STATE" "$CAL_STATE" "$STATE" "$HIST" "$RID" <<'PY'
import json, sys
from pathlib import Path
r=json.loads(Path(sys.argv[1]).read_text())
assert r["status"] == "success" and r["transaction"]["verified"] is True, r
assert json.loads(Path(sys.argv[2]).read_text()) == {}
assert json.loads(Path(sys.argv[3]).read_text()) == {}
assert not (Path(sys.argv[4]) / (sys.argv[6]+".json")).exists()
assert not list(Path(sys.argv[5]).glob("**/*.json"))
print("CALENDAR_LINKED_DELETE=PASS")
PY

# A linked multi-recipient split keeps the original Calendar event and every
# unaffected Automation intact; the changed recipient gets a separate event.
CAL_MULTI="$(python3 - "$FUTURE1" <<'PY'
import json,sys
print(json.dumps({
  "sourceConversation":{"type":"private","id":"+972500000002"},
  "requesterId":"ilana","recipientIds":["amit","oren"],
  "content":"Linked multi original",
  "schedule":{"type":"one-shot","resolvedTime":sys.argv[1],"timezone":"Asia/Jerusalem"},
  "calendar":{"requested":True,"durationMinutes":20},"notifyRecipients":False,
},separators=(",",":")))
PY
)"
printf '%s' "$CAL_MULTI" | run_core create-intent --input - > "$TMP/cal-multi-create.json"
CAL_MULTI_RID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["reminderId"])' "$TMP/cal-multi-create.json")"
CAL_MULTI_PATCH="$(python3 - "$FUTURE2" <<'PY'
import json,sys
print(json.dumps({"recipientId":"amit","schedule":{"type":"one-shot","resolvedTime":sys.argv[1],"timezone":"Asia/Jerusalem"}},separators=(",",":")))
PY
)"
set +e
printf '%s' "$CAL_MULTI_PATCH" | run_core update-reminder --reminder-id "$CAL_MULTI_RID" --requester ilana --input - > "$TMP/cal-multi-update.json"
CAL_MULTI_RC=$?
set -e
if [[ "$CAL_MULTI_RC" -ne 0 ]]; then
  python3 - "$TMP/cal-multi-update.json" <<'PY'
import json,sys
result=json.load(open(sys.argv[1]))
print('CALENDAR_RECIPIENT_RESTRUCTURE_FAILED='+result['error']['code']+': '+result['error']['message'],file=sys.stderr)
PY
  exit 1
fi
CAL_MULTI_NEW_RID="$(python3 - "$TMP/cal-multi-create.json" "$TMP/cal-multi-update.json" "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json,sys
from pathlib import Path
before=json.load(open(sys.argv[1]))['data']['record']
result=json.load(open(sys.argv[2])); jobs=json.load(open(sys.argv[3])); events=json.load(open(sys.argv[4]))
assert result['status']=='success' and result['transaction']['verified'] is True,result
assert result['transport']['deliveries']==[],result
old=result['data']['record']; new=result['data']['restructuredRecord']
assert old['recipientIds']==['oren'] and new['recipientIds']==['amit'],result
assert old['cronJobs'][0]['jobId']==before['cronJobs'][1]['jobId'],result
assert old['calendar']['eventId']==before['calendar']['eventId'],result
assert old['calendar']['eventId']!=new['calendar']['eventId'],result
assert set(events)=={old['calendar']['eventId'],new['calendar']['eventId']},events
assert len(jobs)==2,jobs
for record in (old,new):
    link=json.load(open(Path(sys.argv[5])/(record['reminderId']+'.json')))
    assert link['automationIds']==[record['cronJobs'][0]['jobId']],link
print('CALENDAR_RECIPIENT_RESTRUCTURE_NOTIFY_FALSE=PASS',file=sys.stderr)
print(new['reminderId'])
PY
)"
run_core delete-reminder --reminder-id "$CAL_MULTI_RID" --requester ilana > /dev/null
run_core delete-reminder --reminder-id "$CAL_MULTI_NEW_RID" --requester ilana > /dev/null
python3 - "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json,sys
from pathlib import Path
assert json.load(open(sys.argv[1]))=={}
assert json.load(open(sys.argv[2]))=={}
assert not list(Path(sys.argv[3]).glob('*.json'))
print('CALENDAR_RESTRUCTURE_NO_ORPHANS=PASS')
PY

# Missing duration must fail before any Automation/Calendar/link side effect.
printf '%s\n' '{}' > "$CRON_STATE"
printf '%s\n' '{}' > "$CAL_STATE"
rm -f "$STATE"/*.json
BAD_DURATION="$(cat <<JSON
{"sourceConversation":{"type":"private","id":"+972500000001"},"requesterId":"oren","recipientIds":["oren"],"content":"Missing duration","schedule":{"type":"one-shot","resolvedTime":"$FUTURE1","timezone":"Asia/Jerusalem"},"calendar":{"requested":true}}
JSON
)"
set +e
printf '%s' "$BAD_DURATION" | run_core create-intent --input - > "$TMP/missing.json"
RC=$?
set -e
[[ "$RC" -ne 0 ]]
python3 - "$TMP/missing.json" "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json, sys
from pathlib import Path
r=json.loads(Path(sys.argv[1]).read_text())
assert r["status"] == "failure" and r["error"]["code"] == "REMINDER_CALENDAR_DURATION_REQUIRED", r
assert json.loads(Path(sys.argv[2]).read_text()) == {}
assert json.loads(Path(sys.argv[3]).read_text()) == {}
assert not list(Path(sys.argv[4]).glob("*.json"))
print("CALENDAR_MISSING_DURATION_FAILS_CLOSED=PASS")
PY

# Recurring Calendar linkage remains unsupported and must fail before side effects.
RECURRING="$(cat <<JSON
{"sourceConversation":{"type":"private","id":"+972500000001"},"requesterId":"oren","recipientIds":["oren"],"content":"Recurring calendar","schedule":{"type":"recurring","cron":"0 9 * * *","timezone":"Asia/Jerusalem"},"calendar":{"requested":true,"durationMinutes":30}}
JSON
)"
set +e
printf '%s' "$RECURRING" | run_core create-intent --input - > "$TMP/recurring.json"
RC=$?
set -e
[[ "$RC" -ne 0 ]]
python3 - "$TMP/recurring.json" "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json, sys
from pathlib import Path
r=json.loads(Path(sys.argv[1]).read_text())
assert r["status"] == "failure" and r["error"]["code"] == "REMINDER_CALENDAR_RECURRING_UNSUPPORTED", r
assert json.loads(Path(sys.argv[2]).read_text()) == {}
assert json.loads(Path(sys.argv[3]).read_text()) == {}
assert not list(Path(sys.argv[4]).glob("*.json"))
print("RECURRING_CALENDAR_FAILS_CLOSED=PASS")
PY

# Verification mismatch must roll back the newly-created Calendar event and leave no other durable state.
printf '%s\n' '{}' > "$CRON_STATE"
printf '%s\n' '{}' > "$CAL_STATE"
rm -f "$STATE"/*.json
set +e
printf '%s' "$CREATE_JSON" | \
  FAKE_CALENDAR_MISMATCH=1 \
  REMINDER_LINK_DIR="$STATE" \
  REMINDER_RECIPIENTS_CONFIG="$RECIP" \
  OPENCLAW_BIN="$FAKE_OPENCLAW" \
  REMINDER_GOG_BIN="$FAKE_GOG" \
  REMINDER_GOG_HOME="$GOG_HOME" \
  REMINDER_GOG_ACCOUNT="benson-reminder-calendar-test" \
  EXPECTED_GOG_HOME="$GOG_HOME" \
  EXPECTED_GOG_ACCOUNT="benson-reminder-calendar-test" \
  FAKE_CRON_STATE="$CRON_STATE" \
  FAKE_CAL_STATE="$CAL_STATE" \
  FAKE_GOG_LOG="$GOG_LOG" \
  "$CORE" create-intent --input - > "$TMP/mismatch.json"
RC=$?
set -e
[[ "$RC" -ne 0 ]]
python3 - "$TMP/mismatch.json" "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json, sys
from pathlib import Path
r=json.loads(Path(sys.argv[1]).read_text())
assert r["status"] == "failure", r
assert r["error"]["code"] == "REMINDER_CALENDAR_VERIFY_FAILED", r
assert json.loads(Path(sys.argv[2]).read_text()) == {}
assert json.loads(Path(sys.argv[3]).read_text()) == {}
assert not list(Path(sys.argv[4]).glob("*.json"))
print("CALENDAR_VERIFY_FAILURE_ROLLBACK=PASS")
PY

# One logical plan may contain multiple Reminder schedules and one independent
# Calendar event. Provenance is explicit and the plan commits atomically.
PLAN_JSON="$(python3 - <<'PY'
import datetime as dt,json
now=dt.datetime.now(dt.timezone.utc)
turns=[
  ("turn-1","Family plan at Menora at 21:00"),
  ("turn-2","For Amit and Oren"),
  ("turn-3","Remind at 10:00 and 18:00"),
  ("turn-4","Also in Calendar"),
  ("turn-5","One hour"),
]
citations=[("content",0),("calendar.eventSchedule",0),("calendar.location",0),("recipientIds",1),("schedules[0]",2),("schedules[1]",2),("calendar.requested",3),("calendar.durationMinutes",4)]
print(json.dumps({
  "sourceConversation":{"type":"private","id":"+972500000002"},
  "requesterId":"ilana","recipientIds":["amit","oren"],"content":"Family plan",
  "schedules":[
    {"type":"one-shot","resolvedTime":"2099-03-01T10:00:00+02:00","timezone":"Asia/Jerusalem"},
    {"type":"one-shot","resolvedTime":"2099-03-01T18:00:00+02:00","timezone":"Asia/Jerusalem"}],
  "calendar":{"requested":True,"durationMinutes":60,
    "eventSchedule":{"type":"one-shot","resolvedTime":"2099-03-01T21:00:00+02:00","timezone":"Asia/Jerusalem"},
    "location":{"value":"Menora","evidenceQuote":turns[0][1],"evidenceId":"turn-1"}},
  "notifyRecipients":True,
  "provenance":{"schemaVersion":1,"contextId":"ctx-family-plan","revision":len(turns),
    "createdAt":now.isoformat(),"expiresAt":(now+dt.timedelta(hours=1)).isoformat(),
    "sourceConversation":{"type":"private","id":"+972500000002"},"requesterId":"ilana",
    "currentEvidenceId":turns[-1][0],"evidence":[{"id":key,"text":text} for key,text in turns],
    "fieldEvidence":[{"field":field,"evidenceId":turns[index][0],"quote":turns[index][1]} for field,index in citations]}
},separators=(",",":")))
PY
)"
printf '%s' "$PLAN_JSON" | run_core create-intent --input - > "$TMP/plan-create.json"
python3 - "$TMP/plan-create.json" "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json,sys
from pathlib import Path
r=json.load(open(sys.argv[1])); jobs=json.load(open(sys.argv[2])); events=json.load(open(sys.argv[3]))
assert r['status']=='success' and r['transaction']['verified'] is True,r
record=r['data']['record']
assert len(record['schedules'])==2 and 'schedule' not in record,record
assert len(record['cronJobs'])==4 and len(jobs)==4,(record,jobs)
assert {(j['scheduleIndex'],j['recipientId']) for j in record['cronJobs']}=={(0,'amit'),(0,'oren'),(1,'amit'),(1,'oren')}
assert all(job['enabled'] is True for job in jobs.values()),jobs
assert len(events)==1 and record['calendar']['start']=='2099-03-01T21:00:00+02:00',events
assert record['calendar']['end']=='2099-03-01T22:00:00+02:00'
assert len(r['transport']['deliveries'])==2,r
assert len(list(Path(sys.argv[4]).glob('*.json')))==1
print('ATOMIC_MULTI_SCHEDULE_CALENDAR_PLAN=PASS')
PY
PLAN_RID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["reminderId"])' "$TMP/plan-create.json")"
printf '%s' "$PLAN_JSON" | run_core create-intent --input - > "$TMP/plan-retry.json"
python3 - "$TMP/plan-retry.json" "$CRON_STATE" "$CAL_STATE" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['idempotent'] is True,r
assert len(json.load(open(sys.argv[2])))==4
assert len(json.load(open(sys.argv[3])))==1
print('ATOMIC_PLAN_IDEMPOTENT_NO_DUPLICATES=PASS')
PY
run_core delete-reminder --reminder-id "$PLAN_RID" --requester ilana > /dev/null
python3 - "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json,sys
from pathlib import Path
assert json.load(open(sys.argv[1]))=={}
assert json.load(open(sys.argv[2]))=={}
assert not list(Path(sys.argv[3]).glob('*.json'))
print('ATOMIC_PLAN_DELETE_NO_ORPHANS=PASS')
PY

# Readback unavailable before mutation must fail closed and never create jobs or events.
set +e
printf '%s' "$PLAN_JSON" | FAKE_FAIL_AUTOMATION_LIST=1 run_core create-intent --input - > "$TMP/plan-read-failure.json"
PLAN_READ_RC=$?
set -e
[[ "$PLAN_READ_RC" -ne 0 ]]
python3 - "$TMP/plan-read-failure.json" "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json,sys
from pathlib import Path
assert json.load(open(sys.argv[1]))['status']=='failure'
assert json.load(open(sys.argv[2]))=={}
assert json.load(open(sys.argv[3]))=={}
assert not list(Path(sys.argv[4]).glob('*.json'))
print('ATOMIC_PLAN_READ_FAILURE_FAILS_CLOSED=PASS')
PY

# Failure after a subset of staged Automations and Calendar verification
# failure after all staged Automations both compensate without active residue.
set +e
printf '%s' "$PLAN_JSON" | FAKE_FAIL_ADD_AT=3 FAKE_ADD_COUNT="$TMP/add-count" run_core create-intent --input - > "$TMP/plan-add-failure.json"
PLAN_ADD_RC=$?
set -e
[[ "$PLAN_ADD_RC" -ne 0 ]]
python3 - "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json,sys
from pathlib import Path
assert json.load(open(sys.argv[1]))=={}
assert json.load(open(sys.argv[2]))=={}
assert not list(Path(sys.argv[3]).glob('*.json'))
print('ATOMIC_PLAN_SUBSET_FAILURE_ROLLBACK=PASS')
PY
set +e
printf '%s' "$PLAN_JSON" | FAKE_FAIL_ADD_AT=2 FAKE_FAIL_ADD_AFTER_PERSIST=1 FAKE_ADD_COUNT="$TMP/lost-add-count" run_core create-intent --input - > "$TMP/plan-lost-add-ack.json"
PLAN_LOST_ACK_RC=$?
set -e
[[ "$PLAN_LOST_ACK_RC" -ne 0 ]]
python3 - "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json,sys
from pathlib import Path
assert json.load(open(sys.argv[1]))=={}
assert json.load(open(sys.argv[2]))=={}
assert not list(Path(sys.argv[3]).glob('*.json'))
print('ATOMIC_PLAN_LOST_ADD_ACK_ROLLBACK=PASS')
PY
set +e
printf '%s' "$PLAN_JSON" | FAKE_CALENDAR_MISMATCH=1 run_core create-intent --input - > "$TMP/plan-calendar-failure.json"
PLAN_CAL_RC=$?
set -e
[[ "$PLAN_CAL_RC" -ne 0 ]]
python3 - "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json,sys
from pathlib import Path
assert json.load(open(sys.argv[1]))=={}
assert json.load(open(sys.argv[2]))=={}
assert not list(Path(sys.argv[3]).glob('*.json'))
print('ATOMIC_PLAN_CALENDAR_VERIFY_ROLLBACK=PASS')
PY

# Calendar creation failure after job staging must remove all disabled jobs.
set +e
printf '%s' "$PLAN_JSON" | FAKE_FAIL_CALENDAR_CREATE=1 run_core create-intent --input - > "$TMP/plan-calendar-create-failure.json"
PLAN_CAL_CREATE_RC=$?
set -e
[[ "$PLAN_CAL_CREATE_RC" -ne 0 ]]
python3 - "$TMP/plan-calendar-create-failure.json" "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json,sys
from pathlib import Path
assert json.load(open(sys.argv[1]))['status']=='failure'
assert json.load(open(sys.argv[2]))=={}
assert json.load(open(sys.argv[3]))=={}
assert not list(Path(sys.argv[4]).glob('*.json'))
print('ATOMIC_PLAN_CALENDAR_CREATE_FAILURE_ROLLBACK=PASS')
PY

# A failed enable after one committed job must compensate both job and event.
set +e
printf '%s' "$PLAN_JSON" | FAKE_FAIL_ENABLE_AT=2 FAKE_ENABLE_COUNT="$TMP/enable-count" run_core create-intent --input - > "$TMP/plan-enable-failure.json"
PLAN_ENABLE_RC=$?
set -e
[[ "$PLAN_ENABLE_RC" -ne 0 ]]
python3 - "$TMP/plan-enable-failure.json" "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json,sys
from pathlib import Path
assert json.load(open(sys.argv[1]))['status']=='failure'
assert json.load(open(sys.argv[2]))=={}
assert json.load(open(sys.argv[3]))=={}
assert not list(Path(sys.argv[4]).glob('*.json'))
print('ATOMIC_PLAN_ENABLE_FAILURE_ROLLBACK=PASS')
PY

# Two separate Reminder+Calendar pairs are one deterministic transaction.
PAIR_JSON="$(python3 - <<'PY'
import datetime as dt,json
now=dt.datetime.now(dt.timezone.utc)
turns=[
  ("turn-1","Create Event at 11 and Event at 17 for Amit in Calendar"),
  ("turn-2","Each event is thirty minutes"),
  ("turn-3","Yes, create both separately"),
]
items=[]
for index,(content,hour) in enumerate((("Event at 11",11),("Event at 17",17))):
  fields=["content","recipientIds","schedule","calendar.requested","calendar.eventSchedule"]
  citations=[{"field":field,"evidenceId":"turn-1","quote":turns[0][1]} for field in fields]
  citations.append({"field":"calendar.durationMinutes","evidenceId":"turn-2","quote":turns[1][1]})
  items.append({
    "sourceConversation":{"type":"private","id":"+972500000002"},
    "requesterId":"ilana","recipientIds":["amit"],"content":content,
    "schedule":{"type":"one-shot","resolvedTime":f"2099-04-01T{hour:02d}:00:00+03:00","timezone":"Asia/Jerusalem"},
    "calendar":{"requested":True,"durationMinutes":30,
      "eventSchedule":{"type":"one-shot","resolvedTime":f"2099-04-01T{hour:02d}:00:00+03:00","timezone":"Asia/Jerusalem"}},
    "notifyRecipients":True,
    "provenance":{"schemaVersion":1,"contextId":f"ctx-pairs-{index}","revision":len(turns),
      "createdAt":now.isoformat(),"expiresAt":(now+dt.timedelta(hours=1)).isoformat(),
      "sourceConversation":{"type":"private","id":"+972500000002"},"requesterId":"ilana",
      "currentEvidenceId":"turn-3",
      "evidence":[{"id":key,"text":text} for key,text in turns],
      "fieldEvidence":citations}
  })
print(json.dumps({"items":items},separators=(",",":")))
PY
)"
PAIR_SUPERSET_JSON="$(PAIR_JSON="$PAIR_JSON" python3 - <<'PY'
import json, os
value=json.loads(os.environ["PAIR_JSON"])
for item in value["items"]:
    extras={"cron":"unused","offset":{"value":1,"unit":"seconds"},"reference":"request"}
    item["schedule"].update(extras)
    item["schedules"]=[dict(item["schedule"])]
    item["calendar"]["eventSchedule"].update(extras)
    for field in ("summary","description","location"):
        item["calendar"][field]={"value":item["content"],"evidenceQuote":item["content"],"evidenceId":"turn-1"}
print(json.dumps(value,separators=(",",":")))
PY
)"
set +e
printf '%s' "$PAIR_SUPERSET_JSON" | run_core create-intent --input - > "$TMP/pairs-superset-rejected.json"
PAIR_SUPERSET_RC=$?
set -e
[[ "$PAIR_SUPERSET_RC" -ne 0 ]]
python3 - "$TMP/pairs-superset-rejected.json" "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json,sys
from pathlib import Path
result=json.load(open(sys.argv[1]))
assert result["status"]=="failure" and result["error"]["code"]=="REMINDER_PLAN_INVALID",result
assert json.load(open(sys.argv[2]))=={}
assert json.load(open(sys.argv[3]))=={}
assert not list(Path(sys.argv[4]).glob("*.json"))
print("ATOMIC_PAIRS_SUPERSET_REJECTED_BEFORE_MUTATION=PASS")
PY
printf '%s' "$PAIR_JSON" | run_core create-intent --input - > "$TMP/pairs-create.json"
python3 - "$TMP/pairs-create.json" "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json,sys
from pathlib import Path
r=json.load(open(sys.argv[1])); jobs=json.load(open(sys.argv[2])); events=json.load(open(sys.argv[3]))
records=r["data"]["records"]
assert r["status"]=="success" and r["transaction"]["verified"] is True,r
assert len(records)==2 and len(set(r["reminderIds"]))==2,r
assert all(record["status"]=="active" and len(record["cronJobs"])==1 for record in records),records
assert len(jobs)==2 and all(job["enabled"] is True for job in jobs.values()),jobs
assert len(events)==2 and len(list(Path(sys.argv[4]).glob("*.json")))==2,events
assert {event["start"]["dateTime"] for event in events.values()}=={"2099-04-01T11:00:00+03:00","2099-04-01T17:00:00+03:00"}
assert {event["end"]["dateTime"] for event in events.values()}=={"2099-04-01T11:30:00+03:00","2099-04-01T17:30:00+03:00"}
assert len({record["calendar"]["eventId"] for record in records})==2
assert len(r["transport"]["deliveries"])==2,r
print("ATOMIC_TWO_CALENDAR_PAIRS=PASS")
PY
printf '%s' "$PAIR_JSON" | run_core create-intent --input - > "$TMP/pairs-retry.json"
python3 - "$TMP/pairs-create.json" "$TMP/pairs-retry.json" "$CRON_STATE" "$CAL_STATE" <<'PY'
import json,sys
before=json.load(open(sys.argv[1])); retry=json.load(open(sys.argv[2]))
assert retry["idempotent"] is True and retry["reminderIds"]==before["reminderIds"],retry
assert len(json.load(open(sys.argv[3])))==2 and len(json.load(open(sys.argv[4])))==2
print("ATOMIC_PAIRS_RECONCILE_NO_DUPLICATES=PASS")
PY
PAIR_FIRST="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["reminderIds"][0])' "$TMP/pairs-create.json")"
PAIR_SECOND="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["reminderIds"][1])' "$TMP/pairs-create.json")"
run_core delete-reminder --reminder-id "$PAIR_SECOND" --requester ilana > /dev/null
set +e
printf '%s' "$PAIR_JSON" | run_core create-intent --input - > "$TMP/pairs-partial-retry.json"
PAIR_PARTIAL_RC=$?
set -e
[[ "$PAIR_PARTIAL_RC" -ne 0 ]]
python3 - "$TMP/pairs-partial-retry.json" "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json,sys
from pathlib import Path
r=json.load(open(sys.argv[1]))
assert r["error"]["code"]=="REMINDER_PLAN_PARTIAL_STATE",r
assert len(json.load(open(sys.argv[2])))==1
assert len(json.load(open(sys.argv[3])))==1
assert len(list(Path(sys.argv[4]).glob("*.json")))==1
print("ATOMIC_PAIRS_PARTIAL_RETRY_FAIL_CLOSED=PASS")
PY
run_core delete-reminder --reminder-id "$PAIR_FIRST" --requester ilana > /dev/null
set +e
printf '%s' "$PAIR_JSON" | FAKE_FAIL_CALENDAR_CREATE_AT=2 FAKE_CAL_CREATE_COUNT="$TMP/pair-cal-count" run_core create-intent --input - > "$TMP/pairs-calendar-failure.json"
PAIR_CAL_RC=$?
set -e
[[ "$PAIR_CAL_RC" -ne 0 ]]
python3 - "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json,sys
from pathlib import Path
assert json.load(open(sys.argv[1]))=={}
assert json.load(open(sys.argv[2]))=={}
assert not list(Path(sys.argv[3]).glob("*.json"))
print("ATOMIC_PAIRS_SECOND_CALENDAR_FAILURE_ROLLBACK=PASS")
PY
set +e
printf '%s' "$PAIR_JSON" | FAKE_FAIL_ENABLE_AT=2 FAKE_ENABLE_COUNT="$TMP/pair-enable-count" run_core create-intent --input - > "$TMP/pairs-enable-failure.json"
PAIR_ENABLE_RC=$?
set -e
[[ "$PAIR_ENABLE_RC" -ne 0 ]]
python3 - "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json,sys
from pathlib import Path
assert json.load(open(sys.argv[1]))=={}
assert json.load(open(sys.argv[2]))=={}
assert not list(Path(sys.argv[3]).glob("*.json"))
print("ATOMIC_PAIRS_ENABLE_FAILURE_ROLLBACK=PASS")
PY

# A trusted requester needs no user-text citation for their own recipient id.
SELF_PAIR_JSON="$(PAIR_JSON="$PAIR_JSON" python3 - <<'PY'
import json, os
plan = json.loads(os.environ["PAIR_JSON"])
for item in plan["items"]:
    item["recipientIds"] = ["ilana"]
    item["provenance"]["contextId"] = "self-" + item["provenance"]["contextId"]
    item["provenance"]["fieldEvidence"] = [
        citation for citation in item["provenance"]["fieldEvidence"]
        if citation["field"] != "recipientIds"
    ]
print(json.dumps(plan, separators=(",", ":")))
PY
)"
EXTERNAL_NO_RECIP_JSON="$(PAIR_JSON="$PAIR_JSON" python3 - <<'PY'
import json, os
plan = json.loads(os.environ["PAIR_JSON"])
for item in plan["items"]:
    item["provenance"]["fieldEvidence"] = [
        citation for citation in item["provenance"]["fieldEvidence"]
        if citation["field"] != "recipientIds"
    ]
print(json.dumps(plan, separators=(",", ":")))
PY
)"
set +e
printf '%s' "$EXTERNAL_NO_RECIP_JSON" | run_core create-intent --input - > "$TMP/pairs-external-no-recipient-evidence.json"
EXTERNAL_NO_RECIP_RC=$?
set -e
[[ "$EXTERNAL_NO_RECIP_RC" -ne 0 ]]
python3 - "$TMP/pairs-external-no-recipient-evidence.json" "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json, sys
from pathlib import Path
result = json.load(open(sys.argv[1]))
assert result["error"]["code"] == "REMINDER_PROVENANCE_INCOMPLETE", result
assert json.load(open(sys.argv[2])) == {}
assert json.load(open(sys.argv[3])) == {}
assert not list(Path(sys.argv[4]).glob("*.json"))
print("ATOMIC_PAIRS_EXTERNAL_RECIPIENT_EVIDENCE_REQUIRED=PASS")
PY
printf '%s' "$SELF_PAIR_JSON" | run_core create-intent --input - > "$TMP/pairs-self-recipient.json"
python3 - "$TMP/pairs-self-recipient.json" "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json, sys
from pathlib import Path
result = json.load(open(sys.argv[1]))
records = result["data"]["records"]
assert result["status"] == "success" and result["transaction"]["verified"] is True, result
assert len(records) == 2 and all(record["recipientIds"] == ["ilana"] for record in records)
assert len(json.load(open(sys.argv[2]))) == 2
assert len(json.load(open(sys.argv[3]))) == 2
assert len(list(Path(sys.argv[4]).glob("*.json"))) == 2
assert result["transport"]["deliveries"] == [], result
print("ATOMIC_PAIRS_SELF_RECIPIENT_NO_EVIDENCE=PASS")
PY
for reminder_id in $(python3 -c 'import json,sys; print(*json.load(open(sys.argv[1]))["reminderIds"])' "$TMP/pairs-self-recipient.json"); do
  run_core delete-reminder --reminder-id "$reminder_id" --requester ilana > /dev/null
done

# Replay the last production tool-call shape through the isolated core. Only the
# trusted route and next-Tuesday date are adapted for the fake backend.
PRODUCTION_PAIR_JSON="$(python3 - <<'PY'
import datetime as dt
import json
from zoneinfo import ZoneInfo

zone = ZoneInfo("Asia/Jerusalem")
now = dt.datetime.now(zone)
days_ahead = (1 - now.weekday()) % 7 or 7
target = now.date() + dt.timedelta(days=days_ahead)
request = "תזכיר לי ביום שלישי הבא ב־11:00 וב־17:00 ׳יעלי׳, והוסף לכל שעה אירוע ביומן של חצי שעה"
source = {"type": "private", "id": "+972500000001"}
provenance = {
    "schemaVersion": 1,
    "contextId": "yaeli-production-shape-regression",
    "revision": 1,
    "createdAt": now.isoformat(timespec="seconds"),
    "expiresAt": (now + dt.timedelta(hours=1)).isoformat(timespec="seconds"),
    "sourceConversation": source,
    "requesterId": "oren",
    "currentEvidenceId": "ev-current",
    "evidence": [{"id": "ev-current", "text": request}],
}
items = []
for hour in (11, 17):
    when = dt.datetime.combine(target, dt.time(hour), zone).isoformat()
    schedule = {"type": "one-shot", "resolvedTime": when, "timezone": "Asia/Jerusalem"}
    time_quote = "ביום שלישי הבא ב־11:00" if hour == 11 else "וב־17:00"
    citations = [
        {"field": field, "evidenceId": "ev-current", "quote": quote}
        for field, quote in (
            ("recipientIds", "תזכיר לי"),
            ("schedule", time_quote),
            ("content", "׳יעלי׳"),
            ("calendar.requested", "והוסף לכל שעה אירוע ביומן"),
            ("calendar.durationMinutes", "של חצי שעה"),
            ("calendar.eventSchedule", time_quote),
        )
    ]
    items.append({
        "requesterId": "oren",
        "sourceConversation": source,
        "recipientIds": ["oren"],
        "content": "יעלי",
        "verbatimRequest": request,
        "provenance": {**provenance, "fieldEvidence": citations},
        "schedule": schedule,
        "calendar": {
            "requested": True, "calendarId": "primary", "durationMinutes": 30,
            "eventSchedule": dict(schedule),
        },
        "notifyRecipients": True,
    })
print(json.dumps({"items": items}, ensure_ascii=False, separators=(",", ":")))
PY
)"
printf '%s' "$PRODUCTION_PAIR_JSON" | run_core create-intent --input - > "$TMP/production-pair-create.json"
python3 - "$TMP/production-pair-create.json" "$CRON_STATE" "$CAL_STATE" "$STATE" "$PRODUCTION_PAIR_JSON" <<'PY'
import datetime as dt
import json
import sys
from pathlib import Path

result = json.load(open(sys.argv[1]))
jobs = json.load(open(sys.argv[2]))
events = json.load(open(sys.argv[3]))
expected_items = json.loads(sys.argv[5])["items"]
records = result["data"]["records"]
assert result["status"] == "success" and result["transaction"]["verified"] is True, result
assert len(records) == len(jobs) == len(events) == len(list(Path(sys.argv[4]).glob("*.json"))) == 2
assert len(set(result["reminderIds"])) == len({record["calendar"]["eventId"] for record in records}) == 2
assert result["transport"]["deliveries"] == [], result
for record, item in zip(records, expected_items):
    start = item["schedule"]["resolvedTime"]
    end = (dt.datetime.fromisoformat(start) + dt.timedelta(minutes=30)).isoformat()
    event = events[record["calendar"]["eventId"]]
    job = jobs[record["cronJobs"][0]["jobId"]]
    assert record["status"] == "active" and record["content"] == "יעלי"
    assert record["recipientIds"] == ["oren"] and record["schedule"]["timezone"] == "Asia/Jerusalem"
    assert dt.datetime.fromisoformat(record["schedule"]["resolvedTime"].replace("Z", "+00:00")) == dt.datetime.fromisoformat(start)
    assert len(record["cronJobs"]) == 1 and job["enabled"] is True
    assert job["schedule"]["at"].endswith("Z")
    assert dt.datetime.fromisoformat(job["schedule"]["at"].replace("Z", "+00:00")) == dt.datetime.fromisoformat(start)
    assert event["summary"] == "יעלי" and event["start"]["dateTime"] == start
    assert event["end"]["dateTime"] == end
    assert "description" not in event and "location" not in event
print("PRODUCTION_PAYLOAD_CORE_ATOMIC_PAIRS=PASS")
PY
printf '%s' "$PRODUCTION_PAIR_JSON" | run_core create-intent --input - > "$TMP/production-pair-reconcile.json"
python3 - "$TMP/production-pair-create.json" "$TMP/production-pair-reconcile.json" "$CRON_STATE" "$CAL_STATE" <<'PY'
import json
import sys

created = json.load(open(sys.argv[1]))
reconciled = json.load(open(sys.argv[2]))
assert reconciled["status"] == "success" and reconciled["idempotent"] is True, reconciled
assert reconciled["reminderIds"] == created["reminderIds"], reconciled
assert len(json.load(open(sys.argv[3]))) == len(json.load(open(sys.argv[4]))) == 2
print("PRODUCTION_PAYLOAD_UTC_RECONCILE_NO_DUPLICATES=PASS")
PY
for reminder_id in $(python3 -c 'import json,sys; print(*json.load(open(sys.argv[1]))["reminderIds"])' "$TMP/production-pair-create.json"); do
  run_core delete-reminder --reminder-id "$reminder_id" --requester oren > /dev/null
done
python3 - "$CRON_STATE" "$CAL_STATE" "$STATE" <<'PY'
import json
import sys
from pathlib import Path

assert json.load(open(sys.argv[1])) == {}
assert json.load(open(sys.argv[2])) == {}
assert not list(Path(sys.argv[3]).glob("*.json"))
print("PRODUCTION_PAYLOAD_CLEANUP_NO_ORPHANS=PASS")
PY
python3 - "$GOG_LOG" <<'PY'
import json, sys
from pathlib import Path
rows = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines()]
commands = {row["command"] for row in rows}
assert commands == {"calendar.create", "calendar.event", "calendar.delete"}, commands
for row in rows:
    argv = row["argv"]
    assert "--no-input" in argv and "--json" in argv, argv
    assert "--home" in argv and "--account" in argv, argv
print("GOG_ADAPTER_COMMAND_SURFACE=PASS")
PY

echo "REMINDER_CALENDAR_LIFECYCLE_TESTS=PASS"
