CREATE TABLE `goal_check_in` (
	`id` integer PRIMARY KEY NOT NULL,
	`goalId` text NOT NULL,
	`at` text NOT NULL,
	`note` text NOT NULL,
	FOREIGN KEY (`goalId`) REFERENCES `planner_goal`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `check_ins_by_goal` ON `goal_check_in` (`goalId`,`id`);--> statement-breakpoint
CREATE TABLE `goal_task_link` (
	`goalId` text NOT NULL,
	`taskId` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`goalId`, `taskId`),
	FOREIGN KEY (`goalId`) REFERENCES `planner_goal`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`taskId`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `goals_by_task` ON `goal_task_link` (`taskId`);--> statement-breakpoint
CREATE TABLE `planner_goal` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`creation` text NOT NULL,
	`document` text NOT NULL
);

--> statement-breakpoint
INSERT INTO planner_goal (id, revision, creation, document)
SELECT id, json_extract(document,'$.revision'), creation,
  json_object('title',json_extract(document,'$.label'),'targetDate',NULL,'nextCheckIn',NULL,
    'manualAchievement',json('false'),'subtype',NULL,'timeZone',json_extract(document,'$.timeZone'),
    'dailyMetric',json_extract(document,'$.metric.id'))
FROM plugin_goal;
