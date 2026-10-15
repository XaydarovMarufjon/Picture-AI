import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ScanGateway } from './scan.gateway';

// Exercise the real Nest/Socket.IO server over loopback HTTP polling. The small
// client below uses Engine.IO v4 framing (0 = open, 1 = close, 4 = message) and
// Socket.IO framing (0 = namespace connect, 2 = event), without a new dependency.
// WebSocket upgrades, browser clients, and the scan pipeline are not exercised.
describe('ScanGateway (local Socket.IO integration)', () => {
  let app: INestApplication | undefined;
  let baseUrl: string;
  let gateway: ScanGateway;
  const endpoint = '/socket.io/?EIO=4&transport=polling';

  beforeEach(async () => {
    const fixture = await Test.createTestingModule({
      providers: [ScanGateway],
    }).compile();
    app = fixture.createNestApplication();
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    gateway = app.get(ScanGateway);
  });

  afterEach(async () => {
    // Nest closes both the HTTP listener and every Engine.IO connection/timer,
    // including when an assertion or a client request fails.
    await app?.close();
    app = undefined;
  });

  function poll(path: string) {
    return request(baseUrl)
      .get(path)
      .timeout({ response: 1500, deadline: 2000 });
  }

  function send(path: string, packet: string) {
    return request(baseUrl)
      .post(path)
      .set('Content-Type', 'text/plain')
      .send(packet)
      .timeout({ response: 1500, deadline: 2000 })
      .expect(200, 'ok');
  }

  async function connect() {
    const opened = await poll(endpoint).expect(200);
    expect(opened.text[0]).toBe('0');
    const handshake = JSON.parse(opened.text.slice(1)) as { sid: string };
    expect(handshake.sid).toEqual(expect.any(String));
    const path = `${endpoint}&sid=${encodeURIComponent(handshake.sid)}`;

    await send(path, '40');
    const connected = await poll(path).expect(200);
    expect(connected.text.slice(0, 2)).toBe('40');
    const namespace = JSON.parse(connected.text.slice(2)) as { sid: string };
    expect(namespace.sid).toEqual(expect.any(String));

    return {
      path,
      async events(): Promise<unknown[]> {
        const response = await poll(path).expect(200);
        return response.text.split('\x1e').map((packet) => {
          expect(packet.slice(0, 2)).toBe('42');
          return JSON.parse(packet.slice(2)) as unknown;
        });
      },
      async disconnect() {
        await send(path, '1');
      },
    };
  }

  it('delivers every scan stage once, in order, with unchanged payloads', async () => {
    const client = await connect();
    const stages = [
      { stage: 'start', url: 'https://example.test/rasm?q=salom%20dunyo' },
      { stage: 'crawl', count: 0 },
      { stage: 'filter', count: 5 },
      { stage: 'dedup', count: 5 },
      { stage: 'moderation', done: 5, total: 5, progress: 100 },
      { stage: 'finished', scanId: 42 },
    ];

    for (const payload of stages) gateway.sendProgress(payload);

    expect(await client.events()).toEqual(
      stages.map((payload) => ['scan-progress', payload]),
    );
  });

  it('broadcasts the same progress to every connected client', async () => {
    const first = await connect();
    const second = await connect();
    const payload = { stage: 'moderation', done: 5, total: 12, progress: 42 };

    gateway.sendProgress(payload);

    const received = await Promise.all([first.events(), second.events()]);
    expect(received).toEqual([
      [['scan-progress', payload]],
      [['scan-progress', payload]],
    ]);
  });

  it('keeps delivering to remaining and newly connected clients after disconnect', async () => {
    const leaving = await connect();
    const remaining = await connect();
    await leaving.disconnect();
    await poll(leaving.path).expect(400);

    const duringDisconnect = { stage: 'filter', count: 3 };
    gateway.sendProgress(duringDisconnect);
    expect(await remaining.events()).toEqual([
      ['scan-progress', duringDisconnect],
    ]);

    const reconnected = await connect();
    const finished = { stage: 'finished', scanId: 73 };
    gateway.sendProgress(finished);

    // A new session receives new events, not the earlier session's history.
    expect(
      await Promise.all([remaining.events(), reconnected.events()]),
    ).toEqual([[['scan-progress', finished]], [['scan-progress', finished]]]);
  });

  it('accepts emissions without clients and delivers subsequent live events', async () => {
    expect(() =>
      gateway.sendProgress({ stage: 'finished', scanId: 1 }),
    ).not.toThrow();
    const client = await connect();
    const payload = { stage: 'start', url: 'https://example.test/new-scan' };

    gateway.sendProgress(payload);

    expect(await client.events()).toEqual([['scan-progress', payload]]);
  });
});
