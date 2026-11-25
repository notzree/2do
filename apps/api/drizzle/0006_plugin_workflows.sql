CREATE TABLE `plugin_effect` (
	`taskId` text NOT NULL,
	`typeId` text NOT NULL,
	`effect` text NOT NULL,
	`token` text NOT NULL,
	`epoch` text NOT NULL,
	`subtypeRevision` text NOT NULL,
	`workflowRevision` text NOT NULL,
	`input` text NOT NULL,
	`due` integer NOT NULL,
	`attempts` integer NOT NULL,
	PRIMARY KEY(`taskId`, `typeId`),
	FOREIGN KEY (`taskId`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plugin_effect_due` ON `plugin_effect` (`due`);--> statement-breakpoint
CREATE TABLE `plugin_command_receipt` (
	`commandId` text PRIMARY KEY NOT NULL,
	`taskId` text NOT NULL,
	`signature` text NOT NULL,
	`workflowRevision` text NOT NULL,
	FOREIGN KEY (`taskId`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `plugin_workflow` (
	`taskId` text NOT NULL,
	`typeId` text NOT NULL,
	`version` integer NOT NULL,
	`revision` text NOT NULL,
	`document` text NOT NULL,
	`suspendedChanges` text,
	PRIMARY KEY(`taskId`, `typeId`),
	FOREIGN KEY (`taskId`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `plugin_metric_observation` (
	`taskId` text NOT NULL,
	`typeId` text NOT NULL,
	`sourceKey` text NOT NULL,
	`metricId` text NOT NULL,
	`metricVersion` integer NOT NULL,
	`day` text NOT NULL,
	`value` real,
	`revision` text NOT NULL,
	PRIMARY KEY(`taskId`, `typeId`, `sourceKey`, `metricId`),
	FOREIGN KEY (`taskId`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plugin_metric_period` ON `plugin_metric_observation` (`metricId`,`metricVersion`,`day`);--> statement-breakpoint
CREATE TABLE `plugin_report_calendar` (
	`id` integer PRIMARY KEY NOT NULL,
	`timeZone` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plugin_goal` (
	`id` text PRIMARY KEY NOT NULL,
	`creation` text NOT NULL,
	`document` text NOT NULL
);
