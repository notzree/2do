import { gmail } from "@googleapis/gmail";
import { calendar, type calendar_v3 } from "@googleapis/calendar";
import { OAuth2Client } from "google-auth-library";
import {
  CalendarDestinationMissing,
  EmailCursorExpired,
  eventFields,
  type Calendar,
  type CalendarEvent,
  type Email,
  type EventFields,
} from "../interfaces/connectors.ts";

export function httpStatus(e: unknown) {
  return (e as { response?: { status?: number } } | null)?.response?.status;
}
const network = { timeout: 15_000, retry: false };

export function gmailInbox(auth: OAuth2Client, topicName: string): Email {
  const users = gmail({ version: "v1", auth, ...network }).users;
  const userId = "me";
  async function watch() {
    const { data } = await users.watch({
      userId,
      requestBody: { topicName, labelIds: ["INBOX"], labelFilterBehavior: "include" },
    });
    if (!data.historyId || !Number(data.expiration)) throw new Error("Incomplete Gmail watch");
    return {
      cursor: data.historyId,
      renewAt: Math.min(Date.now() + 86_400_000, Number(data.expiration) - 300_000),
    };
  }
  return {
    start: watch,
    async renew() {
      return (await watch()).renewAt;
    },
    async changes(cursor, pageToken) {
      try {
        const { data } = await users.history.list({
          userId,
          startHistoryId: cursor,
          pageToken,
          labelId: "INBOX",
          historyTypes: ["messageAdded"],
          maxResults: 50,
        });
        const messages = (data.history ?? []).flatMap((h) =>
          (h.messagesAdded ?? []).flatMap(({ message }) =>
            message?.id && (!message.labelIds || message.labelIds.includes("INBOX"))
              ? [{ id: message.id, threadId: message.threadId ?? undefined }]
              : [],
          ),
        );
        if (data.nextPageToken) return { messages, nextPage: data.nextPageToken };
        if (!data.historyId) throw new Error("Missing Gmail history cursor");
        return { messages, cursor: data.historyId };
      } catch (e) {
        if (httpStatus(e) === 404) throw new EmailCursorExpired();
        throw e;
      }
    },
    async inboxSince(since, pageToken) {
      const { data } = await users.messages.list({
        userId,
        labelIds: ["INBOX"],
        q: "after:" + Math.floor(since / 1000),
        maxResults: 50,
        pageToken,
      });
      return {
        messages: (data.messages ?? []).flatMap((m) =>
          m.id ? [{ id: m.id, threadId: m.threadId ?? undefined }] : [],
        ),
        nextPage: data.nextPageToken ?? undefined,
      };
    },
    async stop() {
      await users.stop({ userId });
    },
  };
}

function nextDay(date: string) {
  const value = new Date(date + "T00:00:00Z");
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}
export function googleEvent(e: calendar_v3.Schema$Event): CalendarEvent {
  if (!e.id) throw new Error("Calendar event missing ID");
  const start = e.start,
    end = e.end;
  const schedule =
    start?.date && end?.date
      ? {
          type: "day",
          date: start.date,
          endDateExclusive: nextDay(start.date) === end.date ? undefined : end.date,
        }
      : { type: "fixed", start: start?.dateTime, end: end?.dateTime };
  const title = e.summary?.trim();
  const parsed = eventFields.safeParse({ title: (title || "Busy").slice(0, 240), schedule });
  return {
    id: e.id,
    version: e.etag ?? "",
    cancelled: e.status === "cancelled",
    fields: e.status !== "cancelled" && parsed.success ? parsed.data : null,
    personal:
      !!e.etag &&
      !!title &&
      title.length <= 240 &&
      !e.recurringEventId &&
      !e.recurrence?.length &&
      !e.attendees?.length &&
      !e.attendeesOmitted &&
      !e.conferenceData &&
      (!e.eventType || e.eventType === "default"),
    ownerTag: e.extendedProperties?.private?.twodo,
  };
}
function eventBody({ title, schedule: s }: EventFields): calendar_v3.Schema$Event {
  return s.type === "day"
    ? {
        summary: title,
        start: { date: s.date },
        end: { date: s.endDateExclusive ?? nextDay(s.date) },
      }
    : { summary: title, start: { dateTime: s.start }, end: { dateTime: s.end } };
}
export function googleCalendar(auth: OAuth2Client): Calendar {
  const api = calendar({ version: "v3", auth, ...network });
  const missing = (error: unknown) => [404, 410].includes(httpStatus(error) ?? 0);
  async function checkDestination(calendarId: string, eventError: unknown) {
    if (!missing(eventError)) throw eventError;
    try {
      const { data } = await api.calendarList.get({ calendarId });
      if (data.deleted) throw new CalendarDestinationMissing();
    } catch (error) {
      if (missing(error)) throw new CalendarDestinationMissing();
      throw error;
    }
  }
  return {
    notifications: {
      async subscribe(calendarId, address, id, token) {
        const { data } = await api.events.watch({
          calendarId,
          requestBody: { address, id, token, type: "web_hook", params: { ttl: "604800" } },
        });
        if (!data.resourceId || !Number(data.expiration))
          throw new Error("Incomplete calendar watch");
        return { resource: data.resourceId, expires: Number(data.expiration) };
      },
      async stop(id, resourceId) {
        await api.channels.stop({ requestBody: { id, resourceId } });
      },
    },
    async occurrences(timeMin, timeMax, pageToken) {
      const { data } = await api.events.list({
        calendarId: "primary",
        singleEvents: true,
        timeMin,
        timeMax,
        pageToken,
        maxResults: 100,
      });
      return {
        events: (data.items ?? []).map(googleEvent),
        nextPage: data.nextPageToken ?? undefined,
      };
    },
    async destination(ownerTag) {
      const description = "Personal events synced by 2do. " + ownerTag;
      let pageToken: string | undefined;
      do {
        const { data }: { data: calendar_v3.Schema$CalendarList } = await api.calendarList.list({
          pageToken,
          minAccessRole: "owner",
          showHidden: true,
        });
        const found = data.items?.find((c) => !c.deleted && c.description === description);
        if (found?.id) return found.id;
        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken);
      const { data } = await api.calendars.insert({ requestBody: { summary: "2do", description } });
      if (!data.id) throw new Error("Missing destination calendar");
      return data.id;
    },
    async get(calendarId, eventId) {
      try {
        return googleEvent((await api.events.get({ calendarId, eventId })).data);
      } catch (e) {
        await checkDestination(calendarId, e);
        return null;
      }
    },
    async create(calendarId, id, fields, ownerTag) {
      try {
        const { data } = await api.events.insert({
          calendarId,
          sendUpdates: "none",
          requestBody: {
            id,
            ...eventBody(fields),
            extendedProperties: { private: { twodo: ownerTag } },
          },
        });
        return googleEvent(data);
      } catch (error) {
        await checkDestination(calendarId, error);
        throw error;
      }
    },
    async remove(calendarId, eventId, version) {
      try {
        await api.events.delete(
          { calendarId, eventId, sendUpdates: "none" },
          { headers: { "If-Match": version } },
        );
      } catch (e) {
        await checkDestination(calendarId, e);
      }
    },
    async update(calendarId, eventId, version, fields) {
      try {
        const { data } = await api.events.patch(
          { calendarId, eventId, sendUpdates: "none", requestBody: eventBody(fields) },
          { headers: { "If-Match": version } },
        );
        return googleEvent(data);
      } catch (error) {
        await checkDestination(calendarId, error);
        throw error;
      }
    },
  };
}
