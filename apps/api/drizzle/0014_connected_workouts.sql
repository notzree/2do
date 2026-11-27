CREATE TABLE `connected_workout_metric` (
	`workoutId` text NOT NULL,
	`metricId` text NOT NULL,
	`metricVersion` integer NOT NULL,
	`day` text NOT NULL,
	`value` real,
	PRIMARY KEY(`workoutId`, `metricId`),
	FOREIGN KEY (`workoutId`) REFERENCES `connected_workout`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workout_metric_period` ON `connected_workout_metric` (`metricId`,`metricVersion`,`day`);--> statement-breakpoint
CREATE TABLE `connected_workout` (
	`id` text PRIMARY KEY NOT NULL,
	`account` text NOT NULL,
	`scan` text NOT NULL,
	`day` text NOT NULL,
	`activity` text NOT NULL,
	`start` text NOT NULL,
	`minutes` real NOT NULL,
	`elapsedMinutes` real NOT NULL,
	`km` real,
	`running` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workout_account_start` ON `connected_workout` (`account`,`start`);