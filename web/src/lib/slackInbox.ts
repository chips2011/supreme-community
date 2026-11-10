import type { Project, TaskSummary } from '../types';

export function slackOnlyProject(project: Project, threads: TaskSummary[]): boolean {
  const children = threads.filter((thread) => project.id && thread.projectId ? thread.projectId === project.id : thread.repo === project.path);
  return children.length > 0 && children.every((thread) => thread.origin === 'slack');
}

export function slackAttentionCount(threads: TaskSummary[]): number {
  return threads.filter((thread) => thread.origin === 'slack' && !thread.archived && thread.slackInbox?.state !== 'finished').length;
}

export function slackTitle(title: string): string {
  return title.replace(/:speech_balloon:/g, '').replace(/\*/g, '').trim();
}
