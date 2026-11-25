import { Activity, BookOpen, CalendarDays, CreditCard, Tag, Utensils } from "lucide-react";
import type { TaskTypeIconName } from "@2do/api/task-plugins";

const icons = {
  activity: Activity,
  book: BookOpen,
  calendar: CalendarDays,
  card: CreditCard,
  tag: Tag,
  utensils: Utensils,
};

export function TaskTypeIcon({ icon, size = 13 }: { icon?: TaskTypeIconName; size?: number }) {
  const Icon = (icon && icons[icon]) || Tag;
  return <Icon size={size} strokeWidth={1.65} aria-hidden="true" />;
}
