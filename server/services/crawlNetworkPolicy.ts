import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

type ResolvedAddress = {
  address: string;
  family: number;
};

export type CrawlAddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type CrawlTextResponse = {
  headers: Headers;
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  url: string;
};

export class UnsafeCrawlTargetError extends Error {
  constructor(message = 'The crawl target must be a publicly reachable URL on the selected site host.') {
    super(message);
    this.name = 'UnsafeCrawlTargetError';
  }
}

const blockedAddresses = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

function normalizedHostname(hostname: string) {
  return hostname.replace(/^\[|\]$/g, '').replace(/^www\./i, '').toLowerCase();
}

function mappedIpv4Address(address: string) {
  const match = address.toLowerCase().match(/^::ffff:(.+)$/);
  if (!match) return null;
  if (isIP(match[1]) === 4) return match[1];

  const parts = match[1].split(':');
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const high = Number.parseInt(parts[0], 16);
  const low = Number.parseInt(parts[1], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

export function isBlockedCrawlAddress(address: string) {
  const normalized = address.replace(/^\[|\]$/g, '').split('%')[0];
  const mappedIpv4 = mappedIpv4Address(normalized);
  if (mappedIpv4) {
    return blockedAddresses.check(mappedIpv4, 'ipv4');
  }

  const family = isIP(normalized);
  if (family === 4) return blockedAddresses.check(normalized, 'ipv4');
  if (family === 6) return blockedAddresses.check(normalized, 'ipv6');
  return true;
}

const defaultResolver: CrawlAddressResolver = async (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

export async function resolveSafeCrawlTarget(
  candidate: string,
  allowedHostname?: string,
  resolver: CrawlAddressResolver = defaultResolver,
) {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new UnsafeCrawlTargetError('The crawl target is not a valid URL.');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new UnsafeCrawlTargetError();
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (allowedHostname && normalizedHostname(hostname) !== normalizedHostname(allowedHostname)) {
    throw new UnsafeCrawlTargetError();
  }

  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await resolver(hostname).catch(() => []);

  if (!addresses.length || addresses.some((entry) => isBlockedCrawlAddress(entry.address))) {
    throw new UnsafeCrawlTargetError();
  }

  return { addresses, url };
}

async function readBoundedBody(response: Awaited<ReturnType<typeof undiciFetch>>, maxBytes: number) {
  const declaredLength = Number(response.headers.get('content-length') || '0');
  if (declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Crawl response exceeded ${maxBytes} bytes.`);
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Crawl response exceeded ${maxBytes} bytes.`);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, total);
}

export async function fetchCrawlText(
  candidate: string,
  init: RequestInit = {},
  userAgent: string,
  allowedHostname: string,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<CrawlTextResponse> {
  let current = candidate;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const { addresses, url } = await resolveSafeCrawlTarget(current, allowedHostname);
    const dispatcher = new Agent({
      connect: {
        lookup(_hostname, options, callback) {
          const requestedFamily = Number(options?.family || 0);
          const address = addresses.find((entry) => !requestedFamily || entry.family === requestedFamily) || addresses[0];
          callback(null, address.address, address.family);
        },
      },
    });

    try {
      const response = await undiciFetch(url, {
        ...(init as any),
        dispatcher,
        headers: {
          'user-agent': userAgent,
          ...(init.headers || {}),
        },
        redirect: 'manual',
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirectCount === MAX_REDIRECTS) {
          throw new UnsafeCrawlTargetError('The crawl target exceeded the redirect limit.');
        }
        current = new URL(location, url).toString();
        continue;
      }

      const body = await readBoundedBody(response, maxBytes);
      const headers = new Headers();
      response.headers.forEach((value, key) => headers.append(key, value));
      const text = new TextDecoder().decode(body);
      return {
        headers,
        ok: response.ok,
        status: response.status,
        text: async () => text,
        url: url.toString(),
      };
    } finally {
      await dispatcher.close();
    }
  }

  throw new UnsafeCrawlTargetError('The crawl target exceeded the redirect limit.');
}
