CREATE TABLE `subtype_extraction` (
	`taskId` text NOT NULL,
	`typeId` text NOT NULL,
	`epoch` text NOT NULL,
	`revision` text NOT NULL,
	`title` text NOT NULL,
	`input` text NOT NULL,
	`due` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`taskId`, `typeId`),
	FOREIGN KEY (`taskId`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `subtype_extraction_due` ON `subtype_extraction` (`due`);