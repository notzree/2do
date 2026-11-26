# Gmail and Google Calendar setup

The API Worker runs two Google adapters using the official SDKs. Each signed-in planner can connect one Gmail inbox and one Google Calendar account. The accounts may differ. Install them under **Settings → Connections**.

## Configure Google Cloud

1. Enable the Gmail API, Google Calendar API and Cloud Pub/Sub API in the Google Cloud project that owns the OAuth client.
2. Create a Web application OAuth client. Register the exact redirect URIs `https://<planner-host>/api/connections/gmail/callback` and `https://<planner-host>/api/connections/google-calendar/callback`. Access must cover both callbacks. For a testing app, add the intended Google test accounts to its audience. Add email/profile identity as needed for the consent flow. The app requests `openid email` and the selected feature scopes.
3. For Gmail, create a Pub/Sub topic in that same project. Grant **Pub/Sub Publisher** on the topic to `gmail-api-push@system.gserviceaccount.com`. Create an authenticated **push** subscription targeting `https://<planner-host>/hooks/gmail`. Set the OIDC audience to that exact URL. Choose a dedicated push service account and configure the Pub/Sub service agent's token creation permission as described by Google. [Gmail push setup](https://developers.google.com/workspace/gmail/api/guides/push) · [Authenticated push](https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions)
4. Make the two exact paths `/hooks/gmail` and `/hooks/google-calendar` reachable by Google over HTTPS. The existing web Worker forwards these paths and the private API verifies each delivery. Calendar watches are registered programmatically. Gmail authenticates the subscription/service account, and Calendar uses the stored channel token, channel ID and resource ID. [Calendar watch requirements](https://developers.google.com/workspace/calendar/api/guides/push)
5. Set the following bindings on **2do-api**. Use Worker secrets for the client secret and encryption key. The other entries can also be set with `wrangler secret put NAME` from `apps/api`. Local development reads `apps/api/.dev.vars`. Use a bare origin with no trailing slash. Both new Durable Object bindings and their class migration are included in the Worker configuration.

| Binding | Value |
| --- | --- |
| `GOOGLE_CONNECTOR_ORIGIN` | Public planner origin, e.g. `https://planner.example.com` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Credentials for the Google web OAuth client |
| `GOOGLE_TOKEN_KEY` | Base64 encoding of 32 cryptographically random bytes. Generate with `openssl rand -base64 32` and store securely. Changing this key requires reconnecting existing grants. |
| `GMAIL_PUBSUB_TOPIC` | Full topic name, e.g. `projects/PROJECT/topics/gmail` |
| `GMAIL_PUSH_SUBSCRIPTION` | Full subscription name, e.g. `projects/PROJECT/subscriptions/2do` |
| `GMAIL_PUSH_SERVICE_ACCOUNT` | Email of the service account selected on the push subscription |

## What sync does

**Gmail.** Connect with read-only Gmail permission. Google posts a mailbox change notification. The Worker reads inbox additions since the last committed history ID and invokes the receive hook with each message ID and optional thread ID. The default hook has no side effects. Its delivery receipts contain IDs only. The connection renews its watch daily, checks for missed notifications every five minutes, and rebuilds from messages still in the inbox if Google expires the history cursor. A message permanently deleted during a history outage cannot be recovered from that scan. A future agent consumer should use the account and message ID as its idempotency key. A crash after an external side effect and before recording its receipt can repeat delivery. Mail mutation and send permissions are outside this installation. [Gmail history](https://developers.google.com/workspace/gmail/api/guides/sync)

**Google Calendar → 2do.** Select import to display the primary calendar's occurrences from 30 days ago through 90 days ahead. Timed events retain their instants. All-day events retain a date range with an exclusive end. A moved occurrence updates its existing local item. A canceled or out-of-window import loses its schedule and any leftover deadline, preserving notebook and dependency references. Edit imported titles and times in Google. Turning import off stops updates and leaves the previous import in the planner.

**2do → Google Calendar.** Select export and authorize the app-created calendar scope. In a scheduled event's inspector, choose **Sync to Google Calendar**. On first publication 2do creates a secondary calendar named **2do**. Subsequent sync transfers title and schedule for that selected personal event. With both directions enabled, editing the published event in Google also updates the original planner event. A simultaneous edit to the same field group shows a conflict. Match the values in both apps to resume or choose **Stop syncing** to keep separate copies. Adding attendees or recurrence to the Google copy pauses writes. Removing a planner event normally detaches its Google copy. **Delete from 2do and Google** explicitly queues removal of both copies, conditional on the local revision and the remote event version. 2do checks the local revision immediately before dispatch and pauses edits to that event while deletion settles. Deleting the Google copy leaves the planner event and unlinks it. If the dedicated calendar disappears, 2do can recreate it for exports. Events whose previously published copies disappeared stay in 2do and can be selected for sync again.

Calendar notifications wake the sync worker. A paged scan also runs about every five minutes, including when watch delivery is unavailable. An open planner checks its revision every minute. **Disconnect** stops processing and discards the locally stored credential. To withdraw the Google OAuth grant itself use Google's account permissions page. The two features can share a provider-side app grant.

## Verify a configured installation

Connect a test inbox, send it two messages, and check that the last-sync time advances in Settings. Inspect the connection object's `received:<message-id>` receipts to confirm both messages arrived. Connect a test calendar, create and move a timed event in Google, and check it in Week. Publish one 2do event, change its time on the secondary Google calendar, and verify that the same planner item moves when import is enabled. An unselected event should stay local. Use synthetic content for this check.
