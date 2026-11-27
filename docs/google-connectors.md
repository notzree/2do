# Google connections

The API Worker runs Gmail, Google Calendar and Google Health adapters using the official SDKs. Each signed-in planner can authorize a separate Google account for each service. Install them under **Settings → Connections**.

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

**Gmail.** Connect with read-only Gmail permission. By default the receiver records inbox delivery IDs. In Connections, enable task suggestions to let Workers AI analyze the subject and a short excerpt from newly received inbox mail. A supported action becomes a proposed task in Agent Inbox with the original evidence and Gmail link. Approval creates the task. The mailbox and message ID identify the candidate across webhook retries and reconnects. Disabling suggestions stops new analysis. The connection renews its watch daily, checks for missed notifications every five minutes, and recovers expired history by scanning the inbox. [Gmail history](https://developers.google.com/workspace/gmail/api/guides/sync) · [Gmail message retrieval](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)

**Google Calendar → 2do.** Select import to display the primary calendar's occurrences from 30 days ago through 90 days ahead. Timed events retain their instants. All-day events retain a date range with an exclusive end. A moved occurrence updates its existing local item. A canceled or out-of-window import loses its schedule and any leftover deadline, preserving notebook and dependency references. Edit imported titles and times in Google. Turning import off stops updates and leaves the previous import in the planner.

**2do → Google Calendar.** Select export and authorize the app-created calendar scope. In a scheduled event's inspector, choose **Sync to Google Calendar**. On first publication 2do creates a secondary calendar named **2do**. Subsequent sync transfers title and schedule for that selected personal event. With both directions enabled, editing the published event in Google also updates the original planner event. A simultaneous edit to the same field group shows a conflict. Match the values in both apps to resume or choose **Stop syncing** to keep separate copies. Adding attendees or recurrence to the Google copy pauses writes. Removing a planner event normally detaches its Google copy. **Delete from 2do and Google** explicitly queues removal of both copies, conditional on the local revision and the remote event version. 2do checks the local revision immediately before dispatch and pauses edits to that event while deletion settles. Deleting the Google copy leaves the planner event and unlinks it. If the dedicated calendar disappears, 2do can recreate it for exports. Events whose previously published copies disappeared stay in 2do and can be selected for sync again.

Calendar notifications wake the sync worker. A paged scan also runs about every five minutes, including when watch delivery is unavailable. An open planner checks its revision every minute. **Disconnect** stops processing and discards the locally stored credential. To withdraw the Google OAuth grant itself use Google's account permissions page. The two features can share a provider-side app grant.

## Fitbit Air and Google Health

1. In the Google Cloud project that owns the environment’s web OAuth client, enable **Google Health API**. Add `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly` in **Google Auth Platform → Data Access**. If the project is in testing, add the Google account paired with the Fitbit Air under **Audience → Test users**. [Google Health setup](https://developers.google.com/health/setup)
2. Register `<GOOGLE_CONNECTOR_ORIGIN>/api/connections/google-health/callback` on the same OAuth client. The adapter reuses the shared OAuth credentials and encryption key. Polling uses the existing connection alarm and needs no Pub/Sub topic or inbound webhook.
3. Enable **Fitness** under **Settings → Plugins**. Under **Settings → Connections → Google Health (Fitbit)**, choose **Connect with Google**. Complete consent with the Google account paired with the tracker. The card shows the last successful sync and the five most recent workouts.
4. Record a workout, sync the tracker to Google Health, and check the Fitness reports and weekly activity goal after the next import. Each connected account starts with 30 days of history and refreshes about every 15 minutes. A complete scan revisits previously imported days to pick up corrections and deletions. Time is assigned to days in the planner’s reporting time zone. Active minutes exclude pauses when the device supplies active duration. Run performance uses elapsed minutes. Missing distance stays unknown. [Exercise data](https://developers.google.com/health/data-types/workouts) · [Wearable source filter](https://developers.google.com/health/filters)
5. Disabling Fitness pauses import. Disconnecting Google Health clears the imported sessions and their goal credit. A planned activity earns credit through the tracker record, so leave its manual log empty for the same workout. Workout publishing and automatic linking to a specific planner task are outside this import.

## Verify a configured installation

Connect a test inbox, send it two messages, and check that the last-sync time advances in Settings. Inspect the connection object's `received:<message-id>` receipts to confirm both messages arrived. Connect a test calendar, create and move a timed event in Google, and check it in Week. Publish one 2do event, change its time on the secondary Google calendar, and verify that the same planner item moves when import is enabled. An unselected event should stay local. Use synthetic content for this check.

## Connecting from chat

Ask the agent to connect Gmail, Google Calendar or Google Health. The Google Connections tool negotiates MCP form and URL elicitation with 2do's connection guide. When the service is unspecified, its form offers the available services. The URL card shows the destination host and opens the authenticated Connections page. Complete Google's consent flow there, return to the card and confirm. The guide checks the stored grant before reporting a connected account.

The planner persists the provider's opaque continuation separately from the visible inbox item. Declining, canceling and accepting each resume the registered provider operation through a durable receipt. A provider registration specifies its transport, expected server identity, replay-safe tools, allowed form fields and allowed consent origins. This adapter supports the SDK's negotiated multi-round protocol (2026-07-28), one outstanding form or URL per round and up to four rounds. The form renderer handles flat strings, numeric values, booleans, string choices and their supported bounds. Unrecognized inputs surface as an unsupported interaction.
