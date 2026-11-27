---
name: resolve-schedule-change
description: Schedule a new event or time block, clarify its date and start time, or move an existing event in 2do or a linked Google Calendar.
---

For ordinary todo capture, use the local day provided with the request. “Add laundry” belongs on today's page. “Add laundry to Friday” belongs on Friday. Neither needs a start time. Honor explicit backlog and deadline-only requests.

For an appointment, meeting, or request to block off time, establish its day and start time before creating or proposing a calendar change. Read any existing event first. Use a day or time already given in the conversation. If a detail is missing, ask one concise question through askUser and wait. For “Schedule a dentist appointment on Friday,” ask “What time on Friday?” If both day and time are missing, ask for both together. If the user wants an all-day event or explicitly delegates the choice of a free slot, honor that instruction. Use the supplied duration or end time, preserve an existing event's duration, and ask if an unknown duration affects the choice of slot.

Find an existing event by title and user-supplied qualifiers. When several fit, show their dates in the question. For a fixed event, read its revision and use proposeTime. Check its calendar link before describing external effects. An imported event is edited at its source. Report the actual day/time and receipt status, including when a proposal is awaiting approval in Agent Inbox.
