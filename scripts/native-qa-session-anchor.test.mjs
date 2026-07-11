import assert from 'node:assert/strict';
import test from 'node:test';

import { createMacKeychainStudySessionConsumptionAnchor } from './native-qa-session-anchor.mjs';

test('macOS Keychain anchor is create-only and monotonic across local state rollback', () => {
  const accounts = new Set();
  const commands = [];
  const spawnSync = (_command, args) => {
    commands.push(args);
    const account = args[args.indexOf('-a') + 1];
    if (args[0] === 'find-generic-password') {
      return accounts.has(account) ? { status: 0, stderr: '' } : { status: 44, stderr: '' };
    }
    if (args[0] === 'add-generic-password' && !accounts.has(account)) {
      accounts.add(account);
      return { status: 0, stderr: '' };
    }
    return { status: 45, stderr: 'duplicate item' };
  };
  const anchor = createMacKeychainStudySessionConsumptionAnchor({ spawnSync });
  const profile = 'a'.repeat(64);
  assert.equal(anchor.hasConsumed(profile), false);
  anchor.consume(profile, 'b'.repeat(64));
  assert.equal(anchor.hasConsumed(profile), true);
  assert.throws(() => anchor.consume(profile, 'b'.repeat(64)), /already consumed/i);
  assert.equal(commands.some((args) => args.includes('-U')), false, 'consumption markers must never be overwritten');
});
