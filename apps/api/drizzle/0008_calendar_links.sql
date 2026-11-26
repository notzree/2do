CREATE TABLE `calendar_link` (
	`taskId` text PRIMARY KEY NOT NULL,
	`account` text NOT NULL,
	`remoteId` text NOT NULL,
	`origin` text NOT NULL,
	`base` text,
	`conflict` integer DEFAULT false NOT NULL,
	`seen` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_remote` ON `calendar_link` (`account`,`origin`,`remoteId`);