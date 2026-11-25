CREATE TABLE `day_page` (
	`day` text PRIMARY KEY NOT NULL,
	`commandHash` text NOT NULL,
	`revision` integer NOT NULL,
	`document` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dependency` (
	`prerequisite` text NOT NULL,
	`dependent` text NOT NULL,
	PRIMARY KEY(`prerequisite`, `dependent`),
	FOREIGN KEY (`prerequisite`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dependent`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "distinct_tasks" CHECK("dependency"."prerequisite" <> "dependency"."dependent")
);
--> statement-breakpoint
CREATE INDEX `by_dependent` ON `dependency` (`dependent`,`prerequisite`);--> statement-breakpoint
CREATE TABLE `notebook_image` (
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_plugin_install` (
	`id` text PRIMARY KEY NOT NULL,
	`epoch` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_classification` (
	`taskId` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`due` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`taskId`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_classification_due` ON `task_classification` (`due`);--> statement-breakpoint
CREATE TABLE `plan_head` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	CONSTRAINT "singleton_one" CHECK("plan_head"."singleton" = 1)
);
--> statement-breakpoint
CREATE TABLE `side_chat` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_subtype` (
	`taskId` text NOT NULL,
	`typeId` text NOT NULL,
	`schemaVersion` integer NOT NULL,
	`revision` text NOT NULL,
	`classifiedTitle` text,
	`source` text NOT NULL,
	`document` text,
	PRIMARY KEY(`taskId`, `typeId`),
	FOREIGN KEY (`taskId`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task` (
	`id` text PRIMARY KEY NOT NULL,
	`document` text NOT NULL,
	`parentId` text GENERATED ALWAYS AS (json_extract(document, '$.parentId')) VIRTUAL
);
--> statement-breakpoint
CREATE INDEX `task_parent` ON `task` (`parentId`);
--> statement-breakpoint
INSERT INTO plan_head (singleton, revision) VALUES (1, 0);
