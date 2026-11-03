import { expect, it } from 'vitest';
import { checkGatewayPolicy, loadGatewayPolicy, parseGatewayPolicy } from '../src/core/mcp-gateway-policy.js';
const identity = { agent: 'codex', groups: ['core'] };
it.each([
  ['deny', 'allow', undefined],
  ['allow', 'deny', undefined],
  ['deny', 'approval_required', 'Policy group: approval_required'],
  ['approval_required', 'deny', 'Policy agent: approval_required'],
])('resolves matching agent %s and group %s', (agent, group, expected) => {
  const policy = parseGatewayPolicy(`policies:
  - name: agent
    agents: [codex]
    tools: {server__tool: ${agent}}
  - name: group
    groups: [core]
    tools: {server__tool: ${group}}
  - name: unrelated
    agents: [other]
    tools: {server__tool: allow}`);
  expect(checkGatewayPolicy(policy, identity, 'server__tool')).toBe(expected);
  expect(checkGatewayPolicy(policy, identity, 'server__other')).toBeUndefined();
  expect(checkGatewayPolicy(policy, { agent: 'unknown', groups: [] }, 'server__tool')).toBeUndefined();
});
it('defaults to current behavior and requires fleet approval for unclassified writes', () => {
  expect(checkGatewayPolicy(parseGatewayPolicy('{}'), identity, 'server__tool')).toBeUndefined();
  const policy = parseGatewayPolicy('ask_before_every_change: true\nread_tools: [server__read]\npolicies: [{name: permissive, tools: {server__write: allow}}]');
  expect(checkGatewayPolicy(policy, identity, 'server__read')).toBeUndefined();
  expect(checkGatewayPolicy(policy, identity, 'server__write')).toContain('ask_before_every_change');
});
it.each(['policies: nope', 'ask_before_every_change: yes', 'policies: [{name: bad, tools: {s__t: typo}}]', 'unknown: true'])('rejects invalid policy %s', source => {
  expect(() => parseGatewayPolicy(source)).toThrow('Invalid MCP gateway policy');
});
it('fails closed for a missing configured file', () => {
  expect(() => loadGatewayPolicy('/nonexistent/gateway-policy.yaml')).toThrow('Cannot read MCP gateway policy');
});
