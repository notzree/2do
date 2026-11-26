import type { CalendarNotifications } from "../interfaces/connectors.ts";

interface Channel {
  id: string;
  secret: string;
  calendar: string;
  resource?: string;
  expires: number;
}
const hour = 3_600_000;
export class CalendarWatches {
  constructor(
    private kv: DurableObjectStorage["kv"],
    private owner: string,
  ) {}
  matches(id: string, secret: string, resource: string) {
    const channel = this.kv.get<Channel>("channel:" + id);
    return (
      !!channel &&
      channel.expires > Date.now() &&
      channel.secret === secret &&
      (!channel.resource || channel.resource === resource)
    );
  }
  async refresh(notices: CalendarNotifications, endpoint: string, calendars: string[]) {
    const now = Date.now();
    const active = Array.from(
      this.kv.list<Channel>({ prefix: "channel:" }),
      ([, channel]) => channel,
    );
    for (const calendar of calendars) {
      if (
        !endpoint.startsWith("https://") ||
        active.some((c) => c.calendar === calendar && c.resource && c.expires > now + hour)
      )
        continue;
      const retryKey = "watchRetry:" + calendar;
      if ((this.kv.get<number>(retryKey) ?? 0) > now) continue;
      const channel: Channel = {
        calendar,
        id: crypto.randomUUID(),
        secret: crypto.randomUUID(),
        expires: now + hour,
      };
      // The initial Google notification may arrive before subscribe resolves.
      this.kv.put("channel:" + channel.id, channel);
      try {
        const result = await notices.subscribe(
          calendar,
          endpoint,
          channel.id,
          this.owner + "." + channel.secret,
        );
        Object.assign(channel, result);
        this.kv.put("channel:" + channel.id, channel);
        active.push(channel);
        this.kv.delete(retryKey);
      } catch {
        this.kv.delete("channel:" + channel.id);
        // Domain/watch registration failures must not stop periodic sync.
        this.kv.put(retryKey, now + hour);
      }
    }
    for (const channel of active) {
      const replaced = active.some(
        (c) =>
          c.calendar === channel.calendar &&
          c.id !== channel.id &&
          !!c.resource &&
          c.expires > channel.expires,
      );
      if (calendars.includes(channel.calendar) && !replaced && channel.expires > now) continue;
      this.kv.delete("channel:" + channel.id);
      if (channel.resource && channel.expires > now) {
        try {
          await notices.stop(channel.id, channel.resource);
        } catch {
          /* Google expires retired channels. */
        }
      }
    }
  }
}
