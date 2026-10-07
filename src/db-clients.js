import { createClient } from 'db-vendo-client';
import { defaultProfile } from 'db-vendo-client/lib/default-profile.js';
import { withThrottling } from 'db-vendo-client/throttle.js';
import { profile as dbProfile } from 'db-vendo-client/p/db/index.js';
import { profile as dbwebProfile } from 'db-vendo-client/p/dbweb/index.js';
import { withBahnTransport, withRequestFallback } from './db-transport.js';

export const USER_AGENT = process.env.DB_USER_AGENT
  || 'DBsaver/1.2 (+https://github.com/hundt12345/DBsaver)';

// The DB APIs are rate limited aggressively and block clients that ask too
// often, so every upstream client is throttled globally.
const REQUESTS_PER_SECOND = 2;

function buildClient(profile, { label, timeoutMs }) {
  // `createClient` merges the profile with its defaults, so the transport
  // wrappers have to see the complete profile (including `request`).
  const prepared = withRequestFallback(
    withBahnTransport({ ...defaultProfile, ...profile }),
    { userAgent: USER_AGENT, timeoutMs, label },
  );

  return createClient(withThrottling(prepared, REQUESTS_PER_SECOND, 1000), USER_AGENT, {
    // The bundled station index is used instead: loading it through the client
    // would pull db-hafas-stations' 125 MB file into memory.
    enrichStations: false,
  });
}

/**
 * Price and station APIs of the DB, most promising upstream first.
 * `db` (DB Navigator backend) is the one the client library recommends,
 * `dbweb` (bahn.de backend) is kept as a second chance in case one of them is
 * blocked or throttled.
 */
export const upstreams = [
  {
    id: 'dbnav',
    label: 'DB Navigator API',
    client: buildClient(dbProfile, { label: 'DB Navigator API', timeoutMs: 12_000 }),
  },
  {
    id: 'dbweb',
    label: 'bahn.de Web-API',
    client: buildClient(dbwebProfile, { label: 'bahn.de Web-API', timeoutMs: 12_000 }),
  },
];

export function getUpstream(id) {
  return upstreams.find((upstream) => upstream.id === id) || null;
}
