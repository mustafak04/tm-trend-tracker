import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TM_DOMAINS = ['com', 'co.uk', 'us', 'de', 'fr', 'es', 'it', 'nl'];
const HISTORY_WINDOW_MS = 36 * 60 * 60 * 1000;
const DEDUP_WINDOW_MS = 10 * 60 * 1000;
const MAX_SNAPSHOTS = 60;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Origin: 'https://www.transfermarkt.com',
  Referer: 'https://www.transfermarkt.com/',
};

function normalizeSearchText(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'i')
    .replace(/[øØ]/g, 'o')
    .replace(/[łŁ]/g, 'l')
    .replace(/[đĐ]/g, 'd')
    .replace(/ß/g, 'ss')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[œŒ]/g, 'oe')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatMarketValue(mvDetails) {
  const c = mvDetails?.current?.compact;
  if (c && c.content) {
    return `${c.prefix || ''}${c.content}${c.suffix || ''}`;
  }
  const num = Number(mvDetails?.current?.value);
  if (Number.isFinite(num) && num > 0) {
    if (num >= 1000000) return `€${(num / 1000000).toFixed(2)}M`;
    if (num >= 1000) return `€${Math.round(num / 1000)}K`;
  }
  return null;
}

async function fetchLiveSnapshot() {
  const ranksByPlayerId = new Map();
  let successDomains = 0;

  await Promise.all(
    TM_DOMAINS.map(async (tld) => {
      try {
        const url = `https://tmapi.transfermarkt.technology/statistic/player/most-viewed?topLevelDomain=${encodeURIComponent(
          tld
        )}`;
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) return;
        const json = await res.json();
        const ids = Array.isArray(json?.data?.playerIds) ? json.data.playerIds : [];
        if (ids.length === 0) return;
        successDomains += 1;
        ids.forEach((rawId, idx) => {
          const id = String(rawId || '').trim();
          if (!id) return;
          if (!ranksByPlayerId.has(id)) {
            ranksByPlayerId.set(id, {});
          }
          ranksByPlayerId.get(id)[tld] = idx + 1;
        });
      } catch {
        // Ignore single TLD failure
      }
    })
  );

  const playerIds = Array.from(ranksByPlayerId.keys());
  if (playerIds.length === 0 || successDomains === 0) {
    throw new Error('Transfermarkt most-viewed endpoints returned no players.');
  }

  const playerMetaById = new Map();
  for (let i = 0; i < playerIds.length; i += 50) {
    const chunk = playerIds.slice(i, i + 50);
    const qs = chunk.map((id) => `ids[]=${encodeURIComponent(id)}`).join('&');
    const url = `https://tmapi.transfermarkt.technology/players?${qs}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) continue;
    const json = await res.json();
    for (const p of json?.data || []) {
      if (p?.id != null) {
        playerMetaById.set(String(p.id), p);
      }
    }
  }

  const players = [];
  for (const id of playerIds) {
    const meta = playerMetaById.get(id);
    const name = typeof meta?.name === 'string' ? meta.name.trim() : '';
    const normName = normalizeSearchText(name);
    if (!name || !normName) continue;
    players.push({
      tmId: id,
      name,
      normName,
      marketValue: formatMarketValue(meta.marketValueDetails),
      relativeUrl: typeof meta.relativeUrl === 'string' ? meta.relativeUrl : null,
      ranks: ranksByPlayerId.get(id),
    });
  }

  if (players.length === 0) {
    throw new Error('Failed to resolve player names from Transfermarkt /players.');
  }

  return {
    snapshot: {
      ts: Date.now(),
      source: 'cloud',
      players,
    },
    successDomains,
  };
}

function mergeHistory(existingSnapshots, newSnapshot, nowMs = Date.now()) {
  const minTs = nowMs - HISTORY_WINDOW_MS;
  const all = [...(existingSnapshots || []), newSnapshot].filter(
    (s) =>
      s &&
      Number.isFinite(Number(s.ts)) &&
      s.ts >= minTs &&
      s.ts <= nowMs + DEDUP_WINDOW_MS &&
      Array.isArray(s.players) &&
      s.players.length > 0
  );

  all.sort((a, b) => a.ts - b.ts);
  const deduped = [];
  for (const snap of all) {
    const last = deduped[deduped.length - 1];
    if (last && snap.ts - last.ts <= DEDUP_WINDOW_MS) {
      if (snap.players.length >= last.players.length) {
        deduped[deduped.length - 1] = snap;
      }
    } else {
      deduped.push(snap);
    }
  }

  deduped.sort((a, b) => b.ts - a.ts);
  const snapshots = deduped.slice(0, MAX_SNAPSHOTS);
  return {
    version: 1,
    updatedAt: snapshots[0]?.ts || null,
    snapshots,
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const historyPath = path.resolve(scriptDir, '..', 'tm-history.json');

  let existing = { version: 1, updatedAt: null, snapshots: [] };
  try {
    const raw = await fs.readFile(historyPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.snapshots)) {
      existing = parsed;
    }
  } catch {
    // Missing or fresh file
  }

  const { snapshot, successDomains } = await fetchLiveSnapshot();
  const nextHistory = mergeHistory(existing.snapshots, snapshot, snapshot.ts);

  console.log(
    JSON.stringify({
      dryRun,
      successDomains,
      capturedPlayers: snapshot.players.length,
      totalSnapshots: nextHistory.snapshots.length,
      sampleTop5: snapshot.players.slice(0, 5).map((p) => `${p.name} (${p.marketValue || 'n/a'})`),
    })
  );

  if (!dryRun) {
    await fs.writeFile(historyPath, `${JSON.stringify(nextHistory, null, 2)}\n`, 'utf8');
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
