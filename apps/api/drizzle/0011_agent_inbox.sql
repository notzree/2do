CREATE TABLE `agent_inbox` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`document` text NOT NULL,
	`createdAt` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`read` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`due` integer,
	`attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_inbox_id_unique` ON `agent_inbox` (`id`);--> statement-breakpoint
CREATE INDEX `agent_inbox_pending` ON `agent_inbox` (`status`,`sequence`);--> statement-breakpoint
CREATE INDEX `agent_inbox_due` ON `agent_inbox` (`due`);
--> statement-breakpoint
INSERT INTO agent_inbox (id, kind, status, createdAt, document)
SELECT p.id, 'proposal',
 CASE p.status WHEN 'accepted' THEN 'applied' ELSE p.status END,
 json_extract(p.document,'$.createdAt'),
 json_object('title', json_extract(t.document,'$.title'), 'body',json_extract(p.document,'$.reason'),
 'source','review','taskId',p.taskId,'changes',json_array(json_object('field','schedule',
 'before',json_extract(p.document,'$.before'),'after',json_extract(p.document,'$.after'))))
FROM time_proposal p JOIN task t ON t.id=p.taskId WHERE p.status <> 'duplicate';
--> statement-breakpoint
CREATE TRIGGER inbox_time_insert AFTER INSERT ON time_proposal WHEN NEW.status='pending'
BEGIN
 INSERT INTO agent_inbox (id, kind, status, createdAt, document)
 SELECT NEW.id,'proposal','pending',json_extract(NEW.document,'$.createdAt'),
 json_object('title', json_extract(document,'$.title'),'body',json_extract(NEW.document,'$.reason'),
 'source','review','taskId',NEW.taskId,'changes',json_array(json_object('field','schedule',
 'before',json_extract(NEW.document,'$.before'),'after',json_extract(NEW.document,'$.after'))))
 FROM task WHERE id=NEW.taskId;
 UPDATE agent_inbox SET document=json_insert(document,'$.changes[#]',
   json_object('field','Google Calendar event','before',json_object('destination',json_extract(NEW.document,'$.calendarTarget'),'schedule',json_extract(NEW.document,'$.before')),
   'after',json_object('destination',json_extract(NEW.document,'$.calendarTarget'),'schedule',json_extract(NEW.document,'$.after'))))
 WHERE id=NEW.id AND json_type(NEW.document,'$.calendarTarget')='object';
END;
--> statement-breakpoint
CREATE TRIGGER inbox_time_update AFTER UPDATE OF status ON time_proposal WHEN NEW.status <> 'duplicate'
BEGIN
 UPDATE agent_inbox SET status=CASE NEW.status WHEN 'accepted' THEN 'applied' ELSE NEW.status END,
 due=CASE WHEN json_extract(document,'$.conversation') IS NOT NULL THEN unixepoch()*1000 ELSE NULL END
 WHERE id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER inbox_time_delete AFTER DELETE ON time_proposal WHEN OLD.status='pending'
BEGIN
 UPDATE agent_inbox SET status='stale',
 due=CASE WHEN json_extract(document,'$.conversation') IS NOT NULL THEN unixepoch()*1000 ELSE NULL END
 WHERE id=OLD.id;
END;
