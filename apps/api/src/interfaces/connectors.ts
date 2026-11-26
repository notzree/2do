import { z } from "zod";
import { fixedSchedule, daySchedule } from "./plan.ts";

export const connectorKind = z.enum(["gmail", "google-calendar"]);
export type ConnectorKind = z.infer<typeof connectorKind>;
export const directions = z.strictObject({ importEvents: z.boolean(), exportEvents: z.boolean() });
export type Directions = z.infer<typeof directions>;
export const connectorStatus = z.object({
  configured: z.boolean(),
  account: z.string().nullable(),
  directions: directions,
  lastSync: z.number().nullable(),
  error: z.string().nullable(),
});
export const calendarLinkStatus = z.enum(["unlinked", "imported", "linked", "conflict"]);
export type CalendarLinkStatus = z.infer<typeof calendarLinkStatus>;

/** IDs and cursors are opaque to the receiver. No mail write capability is needed for intake. */
export interface ReceivedEmail {
  id: string;
  threadId?: string;
}
export type EmailPage = { messages: ReceivedEmail[] } & (
  | { nextPage: string; cursor?: never }
  | { nextPage?: undefined; cursor: string }
);
export class EmailCursorExpired extends Error {}
export interface Email {
  /** Establish a change feed and a safe starting checkpoint for this inbox. */
  start(): Promise<{ cursor: string; renewAt: number }>;
  renew(): Promise<number>;
  changes(cursor: string, page?: string): Promise<EmailPage>;
  inboxSince(
    since: number,
    page?: string,
  ): Promise<{ messages: ReceivedEmail[]; nextPage?: string }>;
  stop(): Promise<void>;
}
export type EmailReceiver = (mailbox: string, message: ReceivedEmail) => Promise<void>;

export const eventFields = z.object({
  title: z.string().min(1).max(240),
  schedule: z.union([daySchedule, fixedSchedule]),
});
export type EventFields = z.infer<typeof eventFields>;
export interface CalendarEvent {
  id: string;
  version: string;
  fields: EventFields | null;
  personal: boolean;
  cancelled?: boolean;
  ownerTag?: string;
}
export interface CalendarNotifications {
  subscribe(
    calendarId: string,
    endpoint: string,
    channel: string,
    token: string,
  ): Promise<{ resource: string; expires: number }>;
  stop(channel: string, resource: string): Promise<void>;
}
/** An absent destination is distinct from a missing event in a live calendar. */
export class CalendarDestinationMissing extends Error {}
export interface Calendar {
  notifications?: CalendarNotifications;
  remove(calendarId: string, id: string, version: string): Promise<void>;
  occurrences(
    start: string,
    end: string,
    page?: string,
  ): Promise<{ events: CalendarEvent[]; nextPage?: string }>;
  destination(ownerTag: string): Promise<string>;
  get(calendarId: string, id: string): Promise<CalendarEvent | null>;
  create(
    calendarId: string,
    id: string,
    fields: EventFields,
    ownerTag: string,
  ): Promise<CalendarEvent>;
  update(
    calendarId: string,
    id: string,
    version: string,
    fields: EventFields,
  ): Promise<CalendarEvent>;
}
