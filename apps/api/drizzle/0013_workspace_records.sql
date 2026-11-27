CREATE TABLE IF NOT EXISTS agent_item_link (chat TEXT NOT NULL, item TEXT NOT NULL REFERENCES agent_inbox(id), PRIMARY KEY(chat,item));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, chat TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL, itemId TEXT, messageId TEXT, relatedChat TEXT, generation TEXT);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_activity_order ON agent_activity(at DESC,seq DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_activity_chat ON agent_activity(chat,at DESC,seq DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_delivery (id TEXT PRIMARY KEY, target TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL, attributes TEXT NOT NULL, due INTEGER, attempts INTEGER NOT NULL DEFAULT 0, token TEXT, receipt TEXT);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_delivery_due ON agent_delivery(due);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_history_job (chat TEXT PRIMARY KEY, generation TEXT, beforeCursor TEXT, due INTEGER, token TEXT, again INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_history_due ON agent_history_job(due);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_turn_scope (chat TEXT NOT NULL, turn TEXT NOT NULL, scope TEXT NOT NULL, PRIMARY KEY(chat,turn));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_message (rowid INTEGER PRIMARY KEY, chat TEXT NOT NULL, generation TEXT NOT NULL, messageId TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(chat,generation,messageId));
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS agent_message_fts USING fts5(text, content='agent_message', content_rowid='rowid');
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS agent_message_insert AFTER INSERT ON agent_message BEGIN INSERT INTO agent_message_fts(rowid,text) VALUES(NEW.rowid,NEW.text); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS agent_message_delete AFTER DELETE ON agent_message BEGIN INSERT INTO agent_message_fts(agent_message_fts,rowid,text) VALUES('delete',OLD.rowid,OLD.text); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS agent_activity_insert AFTER INSERT ON agent_inbox BEGIN
 INSERT INTO agent_activity(id,chat,kind,title,body,at,itemId) VALUES('item/'||NEW.id,CASE WHEN json_extract(NEW.document,'$.conversation') LIKE 'side:%' THEN substr(json_extract(NEW.document,'$.conversation'),6,36) ELSE 'me' END,NEW.kind,json_extract(NEW.document,'$.title'),NEW.status,NEW.createdAt,NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS agent_activity_transition AFTER UPDATE OF status ON agent_inbox WHEN NEW.status <> OLD.status BEGIN
 INSERT INTO agent_activity(id,chat,kind,title,body,at,itemId) VALUES('item/'||NEW.id||'/'||NEW.version||'/'||NEW.status,CASE WHEN json_extract(NEW.document,'$.conversation') LIKE 'side:%' THEN substr(json_extract(NEW.document,'$.conversation'),6,36) ELSE 'me' END,NEW.kind,json_extract(NEW.document,'$.title'),NEW.status,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NEW.id) ON CONFLICT(id) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS agent_activity_origin AFTER UPDATE OF document ON agent_inbox WHEN json_extract(OLD.document,'$.conversation') IS NULL AND json_extract(NEW.document,'$.conversation') LIKE 'side:%' BEGIN
 UPDATE agent_activity SET chat=substr(json_extract(NEW.document,'$.conversation'),6,36) WHERE itemId=NEW.id;
END;
--> statement-breakpoint
INSERT OR IGNORE INTO agent_activity(id,chat,kind,title,body,at,itemId)
 SELECT 'item/'||id,CASE WHEN json_extract(document,'$.conversation') LIKE 'side:%' THEN substr(json_extract(document,'$.conversation'),6,36) ELSE 'me' END,kind,json_extract(document,'$.title'),status,createdAt,id FROM agent_inbox;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_flight (chat TEXT NOT NULL,key TEXT NOT NULL,report INTEGER NOT NULL, payload TEXT, receipt TEXT, due INTEGER, PRIMARY KEY(chat,key));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_flight_recover ON agent_flight(due);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_device_origin (chat TEXT NOT NULL, submission TEXT NOT NULL, claim TEXT NOT NULL, PRIMARY KEY(chat,submission));

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_milestone_source(chat TEXT NOT NULL,item TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,report TEXT NOT NULL,PRIMARY KEY(chat,item,version,status));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_delivery_settlement(report TEXT PRIMARY KEY,outcome TEXT NOT NULL);
--> statement-breakpoint
INSERT INTO agent_message_fts(agent_message_fts) VALUES ('rebuild');
