import type { InboxDecision, InboxItem } from "@2do/api/agent-inbox";
import type { FormEvent } from "react";

type Request = NonNullable<InboxItem["elicitation"]>;
type Field = Extract<Request, { mode: "form" }>["fields"][number];
type Answer = NonNullable<InboxDecision["elicitation"]>;

export function providerUrl(url: string, host: string) {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === "https:" &&
      parsed.host === host &&
      !parsed.username &&
      !parsed.password
    )
      return parsed.href;
  } catch {
    /* Unknown providers can supply malformed destinations. */
  }
}

export function providerFormValues(fields: Field[], form: FormData) {
  const entries: [string, string | number | boolean][] = [];
  for (const field of fields) {
    const value = form.get(field.name);
    if (typeof value !== "string" || value === "") continue;
    entries.push([
      field.name,
      field.type === "boolean"
        ? value === "true"
        : field.type === "integer" || field.type === "number"
          ? Number(value)
          : value,
    ]);
  }
  return Object.fromEntries(entries);
}
function FormField({ field }: { field: Field }) {
  const props = { name: field.name, required: field.required, "aria-label": field.label };
  const options = field.options;
  if (field.type === "boolean" || options?.length) {
    return (
      <label>
        {field.label}
        <select {...props} defaultValue="">
          <option value="">{field.required ? "Choose an answer" : "Unspecified"}</option>
          {field.type === "boolean" ? (
            <>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </>
          ) : (
            options?.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))
          )}
        </select>
      </label>
    );
  }
  if (field.type === "number" || field.type === "integer")
    return (
      <label>
        {field.label}
        <input
          {...props}
          type="number"
          step={field.type === "integer" ? "1" : "any"}
          min={field.min}
          max={field.max}
        />
      </label>
    );
  return (
    <label>
      {field.label}
      <input
        {...props}
        type="text"
        minLength={field.minLength}
        maxLength={Math.min(field.maxLength ?? 2000, 2000)}
      />
    </label>
  );
}

export function ProviderQuestion({
  request,
  busy,
  respond,
}: {
  request: Request;
  busy: boolean;
  respond: (answer: Answer) => void;
}) {
  const href = request.mode === "url" ? providerUrl(request.url, request.host) : undefined;
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (request.mode === "form")
      respond({
        action: "accept",
        values: providerFormValues(request.fields, new FormData(e.currentTarget)),
      });
    else if (href) respond({ action: "accept" });
  }
  return (
    <form className="inbox-answer provider-question" onSubmit={submit} autoComplete="off">
      <fieldset disabled={busy}>
        <legend>Request from {request.provider}</legend>
        <p>{request.message}</p>
        {request.mode === "form" ? (
          request.fields.map((field) => <FormField field={field} key={field.name} />)
        ) : href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
            Continue at {request.host}
          </a>
        ) : (
          <p role="alert">This provider link is unavailable.</p>
        )}
        <div className="actions">
          <button type="submit" disabled={request.mode === "url" && !href}>
            {request.mode === "form" ? "Send to provider" : "I finished"}
          </button>
          <button type="button" onClick={() => respond({ action: "decline" })}>
            Decline
          </button>
          <button type="button" onClick={() => respond({ action: "cancel" })}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}
