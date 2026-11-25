CREATE TABLE `task_capture` (
	`taskId` text PRIMARY KEY NOT NULL,
	`document` text NOT NULL,
	FOREIGN KEY (`taskId`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_prompt_skip` (
	`taskId` text NOT NULL,
	`promptId` text NOT NULL,
	PRIMARY KEY(`taskId`, `promptId`),
	FOREIGN KEY (`taskId`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
