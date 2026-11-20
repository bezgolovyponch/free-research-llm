export class ActionQueue {
  constructor() {
    this.queues = new Map();
  }

  enqueue(projectId, action) {
    const queue = this.queues.get(projectId) ?? [];
    const position = queue.length + 1;
    const queuedAction = { ...action, queuedAt: new Date().toISOString(), position };
    queue.push(queuedAction);
    this.queues.set(projectId, queue);
    return { queued: true, type: action.type, position };
  }

  dequeue(projectId) {
    const queue = this.queues.get(projectId);
    if (!queue || !queue.length) return null;
    const action = queue.shift();
    if (!queue.length) this.queues.delete(projectId);
    return action;
  }

  peek(projectId) {
    const queue = this.queues.get(projectId);
    return queue?.[0] ?? null;
  }

  summary(projectId) {
    const queue = this.queues.get(projectId);
    if (!queue || !queue.length) return null;
    const counts = {};
    for (const action of queue) {
      counts[action.type] = (counts[action.type] ?? 0) + 1;
    }
    return { count: queue.length, types: counts };
  }

  has(projectId) {
    const queue = this.queues.get(projectId);
    return Boolean(queue?.length);
  }

  clear(projectId) {
    this.queues.delete(projectId);
  }

  all() {
    const result = {};
    for (const [projectId, queue] of this.queues) {
      if (queue.length) result[projectId] = [...queue];
    }
    return result;
  }
}

export const actionQueue = new ActionQueue();