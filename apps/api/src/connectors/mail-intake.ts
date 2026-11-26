import { EmailCursorExpired, type Email, type EmailReceiver } from "../interfaces/connectors.ts";

export interface MailProgress {
  cursor: string;
  renewAt: number;
  since: number;
  page?: string;
  recovering?: boolean;
}
/** Each completed page is checkpointed by the caller after every delivery is durable. */
export async function readMailPage(
  email: Email,
  mailbox: string,
  previous: MailProgress,
  receive: EmailReceiver,
  now: number,
) {
  const progress = { ...previous };
  if (now >= progress.renewAt) progress.renewAt = await email.renew();
  if (!progress.recovering) {
    try {
      const page = await email.changes(progress.cursor, progress.page);
      for (const message of page.messages) await receive(mailbox, message);
      if (page.nextPage === undefined) progress.cursor = page.cursor;
      return { ...progress, page: page.nextPage, since: page.nextPage ? progress.since : now };
    } catch (err) {
      if (!(err instanceof EmailCursorExpired)) throw err;
      const watch = await email.start();
      Object.assign(progress, watch, { recovering: true, page: undefined });
    }
  }
  // Take the replacement history baseline before listing so mail arriving mid-scan is covered.
  const page = await email.inboxSince(progress.since, progress.page);
  for (const message of page.messages) await receive(mailbox, message);
  return { ...progress, recovering: !!page.nextPage, page: page.nextPage };
}
