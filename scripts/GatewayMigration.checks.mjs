import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

class GatewayMigrationScenario {
  constructor() {
    this.db = new DatabaseSync(':memory:');
  }

  apply(name) {
    const sql = readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8');
    this.db.exec(sql);
  }

  seedLiveConversation() {
    this.db.prepare(
      `INSERT INTO threads
        (id, org_id, kind, sender_agent_id, sender_session_id,
         recipient_agent_id, recipient_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('thread-live', 'org-live', 'message', 'agent-a', 'session-a',
      'agent-b', 'session-b', '2026-11-12T00:00:00.000Z');

    this.db.prepare(
      `INSERT INTO messages
        (id, thread_id, kind, sender_agent_id, sender_session_id,
         recipient_agent_id, recipient_session_id, subject, body,
         delivery_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('msg-live', 'thread-live', 'message', 'agent-a', 'session-a',
      'agent-b', 'session-b', 'original subject', 'old message is preserved',
      'sent', '2026-11-12T00:00:00.000Z');

    this.db.prepare(
      `INSERT INTO wake_events (message_id, session_id, next_attempt_at)
       VALUES (?, ?, ?)`,
    ).run('msg-live', 'session-b', '2026-11-12T00:00:00.000Z');
  }

  verify() {
    const message = this.db.prepare(
      'SELECT body, delivery_status AS deliveryStatus, sender_canonical_address AS senderAddress ' +
      'FROM messages WHERE id = ?',
    ).get('msg-live');
    assert.deepEqual(message, {
      body: 'old message is preserved',
      deliveryStatus: 'sent',
      senderAddress: '',
    });

    const thread = this.db.prepare('SELECT sender_session_id AS sender FROM threads WHERE id = ?')
      .get('thread-live');
    assert.equal(thread.sender, 'session-a');

    const wake = this.db.prepare('SELECT status FROM wake_events WHERE message_id = ?')
      .get('msg-live');
    assert.equal(wake.status, 'pending');

    const gateway = this.db.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'gateway_%' ORDER BY name`,
    ).all().map((item) => item.name);
    assert.deepEqual(gateway, [
      'gateway_conversations', 'gateway_first_contacts', 'gateway_routes',
    ]);

    this.db.prepare(
      `INSERT INTO messages
        (id, thread_id, kind, sender_agent_id, sender_session_id,
         sender_canonical_address, recipient_agent_id, recipient_session_id,
         subject, body, delivery_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('msg-new', 'thread-live', 'message', 'agent-a', 'session-a',
      'nuwa/xiaoqing/main', 'agent-b', 'session-b', 'new subject',
      'new message after migration', 'sent', '2026-11-12T00:01:00.000Z');

    assert.equal(this.db.prepare(
      'SELECT sender_canonical_address AS address FROM messages WHERE id = ?',
    ).get('msg-new').address, 'nuwa/xiaoqing/main');
  }

  close() {
    this.db.close();
  }
}

test('upgrade deployed V2 with existing message and pending Wake without data loss', () => {
  const scenario = new GatewayMigrationScenario();

  try {
    scenario.apply('0001_init.sql');
    scenario.seedLiveConversation();
    scenario.apply('0002_gateway.sql');
    scenario.verify();
  } finally {
    scenario.close();
  }
});
