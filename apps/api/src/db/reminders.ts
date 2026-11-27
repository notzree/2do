// All tables live in the planner's SQLite database so task changes, inbox publication,
// the push outbox and the shared alarm can commit in the same storage transaction.
export function migrateReminders(sql: SqlStorage) {
  const hasReceipts =
    sql
      .exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reminder_occurrence'")
      .toArray().length > 0;
  sql.exec(`CREATE TABLE IF NOT EXISTS reminder_rule (
		id TEXT PRIMARY KEY, taskId TEXT REFERENCES task(id) ON DELETE CASCADE, kind TEXT NOT NULL,
		document TEXT NOT NULL, generation TEXT NOT NULL, scanAfter TEXT
	);
	CREATE INDEX IF NOT EXISTS reminder_rule_task ON reminder_rule(taskId);
	CREATE INDEX IF NOT EXISTS reminder_rule_kind ON reminder_rule(kind);
	CREATE TABLE IF NOT EXISTS reminder_slot (
		ruleId TEXT NOT NULL REFERENCES reminder_rule(id) ON DELETE CASCADE,
		slot TEXT NOT NULL, taskId TEXT REFERENCES task(id) ON DELETE CASCADE,
		anchor INTEGER NOT NULL, due INTEGER, PRIMARY KEY (ruleId,slot)
	);
	CREATE INDEX IF NOT EXISTS reminder_slot_due ON reminder_slot(due);
	CREATE INDEX IF NOT EXISTS reminder_slot_task ON reminder_slot(taskId);
	CREATE TABLE IF NOT EXISTS reminder_routine_owner (
    ruleId TEXT PRIMARY KEY REFERENCES reminder_rule(id) ON DELETE CASCADE, owner TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reminder_routine_run (
    id TEXT PRIMARY KEY, ruleId TEXT NOT NULL REFERENCES reminder_rule(id) ON DELETE CASCADE,
    anchor INTEGER NOT NULL, expires INTEGER NOT NULL, due INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
    day TEXT NOT NULL, zone TEXT NOT NULL, UNIQUE(ruleId,anchor)
  );
  CREATE INDEX IF NOT EXISTS reminder_routine_run_due ON reminder_routine_run(due);
  CREATE TABLE IF NOT EXISTS reminder_brief (
		id TEXT PRIMARY KEY, ruleId TEXT NOT NULL REFERENCES reminder_rule(id) ON DELETE CASCADE,
		snapshot TEXT NOT NULL, anchor INTEGER NOT NULL, due INTEGER NOT NULL, deadline INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS reminder_brief_due ON reminder_brief(due);
	CREATE TABLE IF NOT EXISTS reminder_notice (
		id TEXT PRIMARY KEY, ruleId TEXT NOT NULL REFERENCES reminder_rule(id) ON DELETE CASCADE,
		taskId TEXT REFERENCES task(id) ON DELETE CASCADE, generation TEXT NOT NULL, anchor INTEGER NOT NULL,
		expires INTEGER NOT NULL, created INTEGER NOT NULL, snooze INTEGER, action TEXT, title TEXT NOT NULL, body TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS reminder_notice_snooze ON reminder_notice(snooze);
	CREATE INDEX IF NOT EXISTS reminder_notice_rule ON reminder_notice(ruleId);
	CREATE INDEX IF NOT EXISTS reminder_notice_task ON reminder_notice(taskId);
	CREATE TABLE IF NOT EXISTS reminder_occurrence (
		ruleId TEXT NOT NULL, slot TEXT NOT NULL, anchor INTEGER NOT NULL, source TEXT NOT NULL, expires INTEGER NOT NULL,
		PRIMARY KEY(ruleId,slot,anchor,source)
	);
	CREATE INDEX IF NOT EXISTS reminder_occurrence_expires ON reminder_occurrence(expires);
	CREATE TABLE IF NOT EXISTS reminder_device (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, document TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS reminder_push (
		noticeId TEXT NOT NULL REFERENCES reminder_notice(id) ON DELETE CASCADE,
		deviceId TEXT NOT NULL REFERENCES reminder_device(id) ON DELETE CASCADE,
		due INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(noticeId,deviceId)
	);
	CREATE INDEX IF NOT EXISTS reminder_push_due ON reminder_push(due)`);
  // Existing delivered notices may predate the independent occurrence ledger. Seed
  // once while the object is initializing so an upgrade preserves those deliveries.
  if (!hasReceipts)
    sql.exec(`INSERT OR IGNORE INTO reminder_occurrence(ruleId,slot,anchor,source,expires)
    SELECT ruleId,coalesce(taskId,''),anchor,'',max(expires) FROM reminder_notice GROUP BY ruleId,taskId,anchor`);
}
