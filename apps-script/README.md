# Phone updates in existing Google Sheets

`phone-sync.gs` belongs in the existing payment Apps Script project. It updates
only column B of existing contact or payment rows. It never appends leads,
changes worksheet structure, or overwrites formulas.

## Setup

1. Add `phone-sync.gs` to the payment Apps Script project.
2. Add this route at the start of its existing `doPost(e)`, before request
   logging and before the legacy handler acquires its script lock. Preserve the
   remainder of the existing handler. Do not log the parsed phone-sync request:
   it contains a server-only secret and personal data.

   ```js
   var phoneRequest;
   try {
     phoneRequest = JSON.parse(e.postData && e.postData.contents || '');
   } catch (_) {
     // Existing multipart/form registration and receipt requests continue below.
   }
   if (phoneRequest && typeof phoneRequest.action === 'string' &&
       (phoneRequest.action === 'updatePhone' ||
        phoneRequest.action.indexOf('phone_') === 0)) {
     return ContentService.createTextOutput(
       JSON.stringify(phoneSyncDispatch_(phoneRequest))
     ).setMimeType(ContentService.MimeType.JSON);
   }
   ```

3. Configure these Script Properties. Use verified document IDs, not Apps Script
   deployment IDs or IDs copied from screenshots.

   | Property | Value |
   | --- | --- |
   | `PHONE_UPDATE_SECRET` | A new random secret with at least 32 characters |
   | `PHONE_CONTACT_SHEET_ID` | Existing contacts spreadsheet ID |
   | `PHONE_PAYMENT_SHEET_ID` | Existing payment spreadsheet ID |
   | `PHONE_UPDATE_TARGETS` | `contacts`, `payments`, or `both` |

4. Publish a versioned web-app deployment using the account that can edit both
   documents. Configure the bot's `PHONE_UPDATE_SCRIPT_URL` with that deployment's
   `/exec` URL and `PHONE_UPDATE_SECRET` with the same secret. A Git push deploys
   the bot runtime; it does **not** publish Apps Script changes.
5. From a trusted server/operator tool, POST JSON
   `{ "action": "phone_health", "secret": "<SERVER_SECRET>" }` and verify
   `ok: true` and `headersValid: true`. The health check does not expose rows.
6. Seed verified legacy payment-row mappings for users without captured delivery
   identities. New successful deliveries capture these identities automatically.
   Then test a permitted account and read back its intended row.

## Matching existing rows

Contacts use `Sheet1`, column E `Telegram ID`, matching the exact string ID.
Column B is `Telefon (botda kiritilgan)`. The other columns remain unchanged.

Payment sheets currently have no Telegram-ID column. New successful registration
and receipt deliveries capture their validated submitted fingerprints, which the
authenticated bot passes to phone updates as `entries`. The backend verifies a
unique matching row before saving its mapping. Legacy rows without captured
identities require a trusted operator to match bot database identity to live Sheet
cell values. Never create mappings from an unverified name/phone submitted by a
user. This project checks the fixed existing registration and receipt tab IDs in
`phone-sync.gs`; another project must explicitly adapt these IDs and headers.

Authenticated seed request, up to 100 records per call:

```json
{
  "action": "phone_seed",
  "secret": "<SERVER_SECRET>",
  "records": [{
    "telegramId": "<VERIFIED_TELEGRAM_ID>",
    "entries": [{
      "sheetId": "<VERIFIED_REGISTRATION_TAB_ID_AS_NUMBER>",
      "name": "<EXACT_CELL_TEXT>",
      "originalPhone": "<EXACT_CELL_TEXT>",
      "date": "<EXACT_CELL_TEXT>"
    }]
  }]
}
```

Replace the tab-ID placeholder with the verified numeric ID, without quotes.
Receipt entries additionally require exact `time` and `checkUrl` cell text and
their verified numeric `sheetId`. Seeding is additive and idempotent; it does not write Sheet cells or
reset previous revisions. Ambiguous, missing, or conflicting mappings fail.
Rows are reidentified from their full fingerprint each time, so sorting the
worksheet does not redirect an update to a different person.
Previously mapped rows that were deleted externally are skipped only when other
verified destinations remain. Their saved identity and recovery values are kept
for a possible return; ambiguous rows, formulas, and newly supplied unmatched
identities still fail. If every destination is missing, the update fails.

The existing contacts export covers its existing users only. New deliveries can
update payment rows without being in that export: the bot captures fingerprints
only after Google confirms delivery and sends them in authenticated updates.
The backend accepts recognized date/time display equivalents and Drive links to
the same verified file, then preserves the actual matched Sheet values. Names
and phone values still require exact matches. Legacy users without captured
fingerprints or an existing mapping need an additive verified seed. Unmatched
updates return `ROW_NOT_FOUND` and remain queued until mapping is resolved; this
backend never guesses an identity or appends a contact row.

## Update contract and delivery

`updatePhone` requires `secret`, string `telegramId`, E.164 `phone`, nullable
E.164 `additionalPhone`, positive safe-integer `revision`, and ISO `updatedAt`.
Optional `entries` contains up to 40 captured successful-delivery fingerprints;
request validation and revision checks run before any automatic mapping changes.
Both numbers, when present, are written to the existing phone cell separated by
` / `. With `both`, a contact-only or mapped-payment-only user is supported.

Success includes `result: "success"`, `updated: true`, the exact `telegramId`
and `revision`, and positive `matchedRows`. The bot validates this complete ACK.
HTTP success alone is not proof that a number was saved. Requests with an older
revision return `STALE_REVISION`; a different payload using the same revision
returns `REVISION_CONFLICT`.

A script lock and a persisted pending revision fence prevent older requests
from overwriting newer updates. A flush completes before the committed revision
is stored. Retrying the same request repairs partial writes and any newly seeded
or newly enabled destinations. Errors do not include phone numbers or secrets.

## Tests and deployment boundary

Run `npm run test:apps-script` from the full local repository. Its offline VM
tests include a bridge through the actual bot HTTP client, identity matching,
formula preservation, partial writes, stale requests, and retries.

The server poller copies only the seven bot runtime files, root `tests/*.test.cjs`,
and its fixed deployment files. Apps Script sources and these separate tests
are deliberately outside that runtime snapshot. Run this suite locally before
publishing an Apps Script version; the runtime CI does not run or publish it.
