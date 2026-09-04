process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET ?? 'test-cookie-secret-value-0123456789';
process.env.AGENT_MODE = 'mock';
// Keep the fake token pacing out of the test suite's wall clock.
process.env.AGENT_FAKE_CHUNK_DELAY_MS = '0';
// Short heartbeat so the stream route's "is the generator still alive?" re-check
// runs often enough for tests to finish quickly.
process.env.SSE_HEARTBEAT_MS = '500';
