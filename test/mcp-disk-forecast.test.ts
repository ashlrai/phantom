import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { parseFleetDiskForecastArgs, readFleetDiskForecast } from '../src/mcp/fleet-disk-forecast.js';

let root: string;
const clients: Client[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-disk-forecast-')); });
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  rmSync(root, { recursive: true, force: true });
});
async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), diskForecast: async () => readFleetDiskForecast(root) });
  const client = new Client({ name: 'disk-forecast-test', version: '1.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
function history(last: number): void {
  mkdirSync(join(root, 'queue'), { recursive: true });
  mkdirSync(join(root, 'metrics'), { recursive: true });
  writeFileSync(join(root, 'queue', 'disk-growth-history.json'), JSON.stringify([{ at: 1000000, free_gb: last + 10 }, { at: 1003600, free_gb: last }]));
  writeFileSync(join(root, 'metrics', 'jobs.jsonl'), '');
}
describe('fleet disk forecast', () => {
  it('lists the read-only tool and rejects extra arguments', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_disk_forecast');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(parseFleetDiskForecastArgs({ path: '/tmp' })).toBeNull();
    await expect(client.callTool({ name: 'fleet_disk_forecast', arguments: { path: '/tmp' } })).rejects.toThrow(/Invalid fleet tool arguments/);
  });
  it('projects crossing and advises based on runway', async () => {
    history(200);
    expect(await readFleetDiskForecast(root)).toMatchObject({ forecast: { status: 'projected', hoursUntilThreshold: 5, consumptionGbPerHour: 10 }, advice: 'avoid-large-writes' });
    history(210);
    expect(await readFleetDiskForecast(root)).toMatchObject({ forecast: { status: 'projected', hoursUntilThreshold: 6 }, advice: 'ok' });
    history(150);
    expect(await readFleetDiskForecast(root)).toMatchObject({ forecast: { status: 'reached' }, advice: 'avoid-large-writes' });
  });
  it('reports unknown when either file is missing', async () => {
    expect(await readFleetDiskForecast(root)).toMatchObject({ forecast: { status: 'unknown' }, advice: 'unknown' });
    history(200);
    rmSync(join(root, 'metrics', 'jobs.jsonl'));
    expect(await readFleetDiskForecast(root)).toMatchObject({ forecast: { status: 'unknown' }, advice: 'unknown' });
  });
  it('uses the injected reader', async () => {
    history(200);
    const result = await (await connect()).callTool({ name: 'fleet_disk_forecast', arguments: {} });
    const content = result.content as Array<{ text: string }>;
    expect(JSON.parse(content[0]!.text)).toMatchObject({ schema: 'fleet.mcp.disk-forecast.v1', forecast: { status: 'projected' }, advice: 'avoid-large-writes' });
  });
});
