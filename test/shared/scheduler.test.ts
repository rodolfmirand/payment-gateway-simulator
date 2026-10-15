import { describe, expect, it } from 'vitest';
import { Scheduler } from '../../src/shared/scheduler.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Scheduler', () => {
  it('runs tasks after the delay', async () => {
    const scheduler = new Scheduler(10);
    const ran: string[] = [];
    scheduler.schedule('a', () => ran.push('a'));
    expect(ran).toEqual([]);
    await sleep(40);
    expect(ran).toEqual(['a']);
    expect(scheduler.pending()).toEqual([]);
  });

  it('runPending runs everything now, in order, including tasks scheduled by tasks', () => {
    const scheduler = new Scheduler(60_000);
    const ran: string[] = [];
    scheduler.schedule('a', () => {
      ran.push('a');
      scheduler.schedule('c', () => ran.push('c'));
    });
    scheduler.schedule('b', () => ran.push('b'));
    expect(scheduler.pending().map((task) => task.label)).toEqual(['a', 'b']);

    expect(scheduler.runPending()).toBe(3);
    expect(ran).toEqual(['a', 'b', 'c']);
  });

  it('cancelAll drops pending tasks', async () => {
    const scheduler = new Scheduler(10);
    const ran: string[] = [];
    scheduler.schedule('a', () => ran.push('a'));
    scheduler.cancelAll();
    await sleep(40);
    expect(ran).toEqual([]);
  });

  it('reports task errors and keeps going', () => {
    const errors: string[] = [];
    const scheduler = new Scheduler(60_000, (_error, label) => errors.push(label));
    const ran: string[] = [];
    scheduler.schedule('boom', () => {
      throw new Error('boom');
    });
    scheduler.schedule('ok', () => ran.push('ok'));
    scheduler.runPending();
    expect(errors).toEqual(['boom']);
    expect(ran).toEqual(['ok']);
  });
});
