CREATE TABLE `task_classification_result` (
	`taskId` text PRIMARY KEY NOT NULL,
	`checkedAt` text NOT NULL,
	`title` text NOT NULL,
	`decisions` text NOT NULL,
	FOREIGN KEY (`taskId`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
