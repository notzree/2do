import webpush from "web-push";
import type { ReminderSubscription } from "../interfaces/reminders.ts";

export interface ReminderPushEnv {
  WEB_PUSH_PUBLIC_KEY?: string;
  WEB_PUSH_PRIVATE_KEY?: string;
  WEB_PUSH_SUBJECT?: string;
}

export function pushPublicKey(env: ReminderPushEnv) {
  return (env.WEB_PUSH_PRIVATE_KEY && env.WEB_PUSH_SUBJECT && env.WEB_PUSH_PUBLIC_KEY) || null;
}

export async function sendReminderPush(
  env: ReminderPushEnv,
  sub: ReminderSubscription,
  notice: {
    id: string;
    title: string;
    body: string;
  },
  expires: number,
  scope: string,
): Promise<number> {
  const publicKey = pushPublicKey(env);
  if (!publicKey) return 503;
  const { id, title, body } = notice;
  const bodyLimit = (value: string, max: number) => Array.from(value).slice(0, max).join("");
  const payload = {
    id,
    scope,
    title: bodyLimit(title, 100),
    body: bodyLimit(body, 600),
    url: "/app?inbox=" + id,
    tag: id,
  };
  const request = webpush.generateRequestDetails(sub, JSON.stringify(payload), {
    TTL: Math.max(0, Math.min(3600, Math.floor((expires - Date.now()) / 1000))),
    vapidDetails: {
      subject: env.WEB_PUSH_SUBJECT!,
      privateKey: env.WEB_PUSH_PRIVATE_KEY!,
      publicKey,
    },
    topic: id.replaceAll("-", ""),
  });
  // Workers fetch controls timeout and redirect handling. Notification encryption and VAPID
  // authentication are delegated to web-push.
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers ?? {}))
    headers.set(name, String(value));
  const result = await fetch(sub.endpoint, {
    method: "POST",
    headers,
    body: new Uint8Array(request.body as Buffer),
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  });
  await result.body?.cancel();
  return result.status;
}

declare global {
  interface Env extends ReminderPushEnv {}
}
