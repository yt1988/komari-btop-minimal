import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveSocket } from '../src/api/komari';

class TestSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: TestSocket[] = [];
  readyState = 0;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  });

  constructor() {
    super();
    TestSocket.instances.push(this);
  }

  open(): void {
    this.readyState = TestSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  reply(): void {
    const data = JSON.stringify({ status: 'success', data: { online: [], data: {} } });
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  TestSocket.instances = [];
});

describe('live WebSocket timeout', () => {
  it('replaces an unresponsive connection, ignores late replies, and resumes polling', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', TestSocket);
    const onSnapshot = vi.fn();
    const socket = createLiveSocket({ scope: 'all', onSnapshot });
    const first = TestSocket.instances[0]!;
    first.open();
    const firstRequest = 3000;
    vi.advanceTimersByTime(firstRequest);
    socket.request();
    expect(first.send).toHaveBeenCalledExactlyOnceWith('get');

    vi.advanceTimersByTime(9000 - firstRequest);
    expect(first.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    const replacement = TestSocket.instances[1]!;
    replacement.open();
    first.reply();
    expect(onSnapshot).not.toHaveBeenCalled();
    replacement.reply();
    expect(onSnapshot).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(9000);
    expect(replacement.close).not.toHaveBeenCalled();
    socket.request();
    expect(replacement.send).toHaveBeenCalledTimes(2);
    socket.stop();
    vi.advanceTimersByTime(30_000);
    expect(TestSocket.instances).toHaveLength(2);
  });

  it('retries a connection that never opens', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', TestSocket);
    const socket = createLiveSocket({ scope: 'all', onSnapshot: vi.fn() });

    vi.advanceTimersByTime(10_000);
    expect(TestSocket.instances[0]!.close).toHaveBeenCalledOnce();
    expect(TestSocket.instances).toHaveLength(2);
    socket.stop();
  });
});

describe('live WebSocket scope and visibility', () => {
  it('discards a late reply for the previous node and immediately requests the new scope', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', TestSocket);
    let uuid: string | undefined = 'node-a';
    const onSnapshot = vi.fn();
    const socket = createLiveSocket({ scope: 'all', nodeUuid: () => uuid, onSnapshot });
    const connection = TestSocket.instances[0]!;
    connection.open();
    expect(connection.send).toHaveBeenLastCalledWith('get node-a');

    uuid = 'node-b';
    socket.request();
    connection.reply();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(connection.send).toHaveBeenLastCalledWith('get node-b');
    connection.reply();
    expect(onSnapshot).toHaveBeenLastCalledWith({ online: [], data: {} }, 'node-b');

    uuid = undefined;
    socket.request();
    expect(connection.send).toHaveBeenLastCalledWith('get');
    socket.stop();
  });

  it('stops sending and reconnecting during a pause, then requests fresh data on resume', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', TestSocket);
    const onSnapshot = vi.fn();
    const socket = createLiveSocket({ scope: 'all', onSnapshot });
    const connection = TestSocket.instances[0]!;
    connection.open();
    socket.pause();
    connection.reply();
    vi.advanceTimersByTime(3000);
    socket.request();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(connection.send).toHaveBeenCalledOnce();

    socket.resume();
    expect(connection.send).toHaveBeenCalledTimes(2);
    connection.reply();
    expect(onSnapshot).toHaveBeenCalledOnce();
    socket.pause();
    connection.close();
    vi.advanceTimersByTime(30_000);
    expect(TestSocket.instances).toHaveLength(1);
    socket.resume();
    socket.resume();
    expect(TestSocket.instances).toHaveLength(2);
    socket.stop();
  });
});
