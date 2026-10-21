import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './prisma.module';
import { PrismaService } from './prisma.service';

// Keep Nest's real module/application lifecycle, but never create a database
// client or connect to a database. Only the client's two I/O methods are mocked.
jest.mock('@prisma/client', () => ({
  PrismaClient: class {
    $connect = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    $disconnect = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('PrismaService Nest lifecycle (offline)', () => {
  let app: INestApplication;
  let connect: jest.SpiedFunction<PrismaService['$connect']>;
  let disconnect: jest.SpiedFunction<PrismaService['$disconnect']>;
  let closed: boolean;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    app = module.createNestApplication();
    const service = app.get(PrismaService);
    connect = jest.spyOn(service, '$connect');
    disconnect = jest.spyOn(service, '$disconnect');
    closed = false;
  });

  afterEach(async () => {
    if (!closed) await app.close();
  });

  it('connects during application initialization, not module compilation', async () => {
    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();

    await app.init();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('disconnects the injected client once when the initialized application closes', async () => {
    await app.init();

    await app.close();
    closed = true;

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(connect.mock.invocationCallOrder[0]).toBeLessThan(
      disconnect.mock.invocationCallOrder[0],
    );
  });

  it('does not finish application shutdown until disconnect resolves', async () => {
    await app.init();
    const disconnecting = deferred();
    disconnect.mockReturnValueOnce(disconnecting.promise);
    let settled = false;
    const closing = app.close().then(() => {
      settled = true;
      closed = true;
    });

    try {
      await nextTurn();
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
    } finally {
      disconnecting.resolve();
      await closing;
    }

    expect(settled).toBe(true);
  });

  it('propagates disconnect failure instead of reporting successful shutdown', async () => {
    await app.init();
    const error = new Error('disconnect failed');
    disconnect.mockRejectedValueOnce(error);

    await expect(app.close()).rejects.toBe(error);

    expect(disconnect).toHaveBeenCalledTimes(1);
    // afterEach retries cleanup with the default resolved mock implementation.
  });

  it('disconnects when an initialized Nest module context closes without an HTTP application', async () => {
    const module = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    const client = module.get(PrismaService);
    const contextConnect = jest.spyOn(client, '$connect');
    const contextDisconnect = jest.spyOn(client, '$disconnect');
    await module.init();

    await module.close();

    expect(contextConnect).toHaveBeenCalledTimes(1);
    expect(contextDisconnect).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });
});
