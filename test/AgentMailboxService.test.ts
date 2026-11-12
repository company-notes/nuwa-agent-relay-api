import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { AgentMailboxService } from '../src/AgentMailboxService';
import { RelayTestClient } from './RelayTestClient';

describe('Agent mailboxes use the existing MailTrigger transport', () => {
  const client = new RelayTestClient();
  it('provisions once per Agent and reuses the same mailbox for all of its Sessions', async () => {
    client.installExternalTestTransport();

    const mailboxes = new AgentMailboxService(env);
    const first = await mailboxes.provision('org-v2', 'agent-0001');
    const again = await mailboxes.provision('org-v2', 'agent-0001');

    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.mailboxId).toBe(first.mailboxId);

    const saved = await mailboxes.require('org-v2', 'agent-0001');
    expect(saved.mailbox_id).toBe(first.mailboxId);
    expect(saved.mailbox_email).toBe(first.mailboxEmail);

    const count = await env.DB.prepare(
      'SELECT count(*) AS count FROM agent_mailboxes WHERE org_id = ? AND agent_id = ?',
    ).bind('org-v2', 'agent-0001').first<{ count: number }>();

    expect(count?.count).toBe(1);
  });

  it('isolates different Agents without any MailTrigger API changes', async () => {
    client.installExternalTestTransport();

    const mailboxes = new AgentMailboxService(env);
    const left = await mailboxes.provision('org-v2', 'agent-0002');
    const right = await mailboxes.provision('org-v2', 'agent-0003');

    expect(left.mailboxId).not.toBe(right.mailboxId);
    await expect(mailboxes.require('org-other', 'agent-0002'))
      .rejects.toMatchObject({ status: 409, code: 'agent_mailbox_not_ready' });
  });
});
