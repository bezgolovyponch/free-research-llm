import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { actionQueue } from '../src/actionqueue.mjs';

describe('ActionQueue', () => {
  beforeEach(() => {
    actionQueue.clear('test-project');
    actionQueue.clear('project-1');
    actionQueue.clear('project-2');
  });

  afterEach(() => {
    actionQueue.clear('test-project');
    actionQueue.clear('project-1');
    actionQueue.clear('project-2');
  });

  describe('enqueue', () => {
    it('enqueues an action and returns position', () => {
      const result = actionQueue.enqueue('test-project', { type: 'delete', body: {} });
      expect(result).toEqual({ queued: true, type: 'delete', position: 1 });
    });

    it('increments position for multiple actions', () => {
      actionQueue.enqueue('test-project', { type: 'reset', body: {} });
      actionQueue.enqueue('test-project', { type: 'restore', body: {} });
      const result = actionQueue.enqueue('test-project', { type: 'synthesize', body: {} });
      expect(result.position).toBe(3);
    });

    it('maintains separate queues per project', () => {
      actionQueue.enqueue('project-1', { type: 'delete', body: {} });
      actionQueue.enqueue('project-1', { type: 'reset', body: {} });
      const result = actionQueue.enqueue('project-2', { type: 'delete', body: {} });
      expect(result.position).toBe(1);
    });

    it('includes queuedAt timestamp', () => {
      const before = new Date().toISOString();
      const result = actionQueue.enqueue('test-project', { type: 'delete', body: {} });
      const after = new Date().toISOString();
      const queued = actionQueue.peek('test-project');
      expect(queued.queuedAt).toBeDefined();
      expect(queued.queuedAt >= before).toBe(true);
      expect(queued.queuedAt <= after).toBe(true);
    });
  });

  describe('dequeue', () => {
    it('returns actions in FIFO order', () => {
      actionQueue.enqueue('test-project', { type: 'delete', body: {} });
      actionQueue.enqueue('test-project', { type: 'reset', body: {} });
      actionQueue.enqueue('test-project', { type: 'restore', body: {} });

      const first = actionQueue.dequeue('test-project');
      expect(first.type).toBe('delete');

      const second = actionQueue.dequeue('test-project');
      expect(second.type).toBe('reset');

      const third = actionQueue.dequeue('test-project');
      expect(third.type).toBe('restore');

      expect(actionQueue.dequeue('test-project')).toBeNull();
    });

    it('returns null for empty queue', () => {
      expect(actionQueue.dequeue('test-project')).toBeNull();
    });

    it('clears queue when empty', () => {
      actionQueue.enqueue('test-project', { type: 'delete', body: {} });
      actionQueue.dequeue('test-project');
      expect(actionQueue.has('test-project')).toBe(false);
    });
  });

  describe('peek', () => {
    it('returns first action without removing it', () => {
      actionQueue.enqueue('test-project', { type: 'delete', body: {} });
      actionQueue.enqueue('test-project', { type: 'reset', body: {} });

      const first = actionQueue.peek('test-project');
      expect(first.type).toBe('delete');

      const again = actionQueue.peek('test-project');
      expect(again.type).toBe('delete');
    });

    it('returns null for empty queue', () => {
      expect(actionQueue.peek('test-project')).toBeNull();
    });
  });

  describe('summary', () => {
    it('returns null for empty queue', () => {
      expect(actionQueue.summary('test-project')).toBeNull();
    });

    it('returns count and types', () => {
      actionQueue.enqueue('test-project', { type: 'delete', body: {} });
      actionQueue.enqueue('test-project', { type: 'reset', body: {} });
      actionQueue.enqueue('test-project', { type: 'reset', body: {} });
      actionQueue.enqueue('test-project', { type: 'synthesize', body: {} });

      const summary = actionQueue.summary('test-project');
      expect(summary).toEqual({
        count: 4,
        types: { delete: 1, reset: 2, synthesize: 1 }
      });
    });
  });

  describe('has', () => {
    it('returns false for empty queue', () => {
      expect(actionQueue.has('test-project')).toBe(false);
    });

    it('returns true for non-empty queue', () => {
      actionQueue.enqueue('test-project', { type: 'delete', body: {} });
      expect(actionQueue.has('test-project')).toBe(true);
    });
  });

  describe('clear', () => {
    it('removes all actions for a project', () => {
      actionQueue.enqueue('test-project', { type: 'delete', body: {} });
      actionQueue.enqueue('test-project', { type: 'reset', body: {} });
      actionQueue.clear('test-project');
      expect(actionQueue.has('test-project')).toBe(false);
      expect(actionQueue.summary('test-project')).toBeNull();
    });
  });

  describe('all', () => {
    it('returns all queued actions for all projects', () => {
      actionQueue.enqueue('project-1', { type: 'delete', body: {} });
      actionQueue.enqueue('project-2', { type: 'reset', body: {} });
      actionQueue.enqueue('project-2', { type: 'restore', body: {} });

      const all = actionQueue.all();
      expect(all['project-1']).toHaveLength(1);
      expect(all['project-2']).toHaveLength(2);
    });
  });
});